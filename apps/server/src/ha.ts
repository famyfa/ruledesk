import { haRole, switchChecks, switchSettled, type HaCheck, type HaState } from "@ruledeck/core";
import { OpnsenseError, type OpnsenseClient } from "@ruledeck/opnsense-client";

/**
 * Graceful HA switchover: put the node RuleDeck is signed in to into (or take it
 * out of) CARP maintenance mode, so its virtual IPs move to the peer (or come back).
 *
 * The firewall's maintenance call is a TOGGLE, so it is sent at most once per switch.
 * Whatever happens, the state is read back from the firewall; RuleDeck never says
 * "switched" without seeing it. There is no automatic rollback (decided): a switch
 * that doesn't settle is reported, and the user decides (switch back is one click).
 */

export interface HaView {
  state: HaState;
  role: ReturnType<typeof haRole>;
  peerReachable: boolean;
  enter: ReturnType<typeof switchChecks>;
  leave: ReturnType<typeof switchChecks>;
}

export async function readHa(client: OpnsenseClient): Promise<HaView> {
  const [state, peerReachable] = await Promise.all([client.readHaState(), client.peerReachable()]);
  return { state, role: haRole(state), peerReachable, enter: switchChecks(state, true, peerReachable), leave: switchChecks(state, false, peerReachable) };
}

export type SwitchOutcome = "done" | "already" | "refused" | "unverified" | "failed";

export interface SwitchStep {
  label: string;
  status: "done" | "failed" | "skipped";
  error?: string;
}

export interface SwitchResult {
  outcome: SwitchOutcome;
  enter: boolean;
  checks: HaCheck[];
  steps: SwitchStep[];
  /** State read back after the switch (or the last one we saw). */
  after: HaState | null;
  message: string;
}

export interface SwitchOptions {
  pollMs?: number;
  timeoutMs?: number;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runSwitch(client: OpnsenseClient, enter: boolean, opts: SwitchOptions = {}): Promise<SwitchResult> {
  const pollMs = opts.pollMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const sleep = opts.sleep ?? wait;
  const steps: SwitchStep[] = [];
  const verb = enter ? "Enter" : "Leave";
  const result = (outcome: SwitchOutcome, message: string, checks: HaCheck[], after: HaState | null): SwitchResult => ({ outcome, enter, checks, steps, after, message });

  // 1. Look first, right before acting: the toggle must not be sent on stale information.
  const before = await readHa(client);
  const gate = enter ? before.enter : before.leave;
  steps.push({ label: "Read the CARP state of this node and its peer", status: "done" });
  if (gate.already) {
    return result("already", enter ? "This node is already in CARP maintenance mode. Nothing was changed." : "This node is not in CARP maintenance mode. Nothing was changed.", gate.checks, before.state);
  }
  if (!gate.allowed) {
    const failed = gate.checks.filter((c) => !c.ok).map((c) => c.text);
    steps.push({ label: "Check that it is safe to switch", status: "failed", error: `Not true: ${failed.join(" ")}` });
    return result("refused", "Not switched: a safety check failed. Nothing was changed.", gate.checks, before.state);
  }
  steps.push({ label: "Check that it is safe to switch", status: "done" });

  // 2. The single toggle.
  const expected = enter ? "enter_maintenance" : "leave_maintenance";
  try {
    const action = await client.toggleCarpMaintenance();
    if (action !== expected) {
      steps.push({ label: `${verb} CARP maintenance mode`, status: "failed", error: `The firewall did "${action}" instead (the mode changed in the meantime).` });
      const now = await client.readHaState().catch(() => null);
      return result("unverified", `The firewall did the opposite of what was asked (${action}). It was not repeated. Check the state below and decide.`, gate.checks, now);
    }
    steps.push({ label: `${verb} CARP maintenance mode`, status: "done" });
  } catch (err) {
    // The answer was lost or refused; the toggle may or may not have happened. Read, don't retry.
    const detail = err instanceof OpnsenseError ? err.message : "The request failed.";
    const now = await client.readHaState().catch(() => null);
    if (now && now.maintenance === enter) {
      steps.push({ label: `${verb} CARP maintenance mode`, status: "done", error: `The answer was lost (${detail}), but the firewall did switch.` });
    } else {
      steps.push({ label: `${verb} CARP maintenance mode`, status: "failed", error: detail });
      return result("failed", "Not switched: the firewall did not accept the change. It was not repeated.", gate.checks, now);
    }
  }

  // 3. Read back until it settles (the peer needs a moment to take over, or this node to preempt).
  const deadline = Date.now() + timeoutMs;
  let last: HaState | null = null;
  for (;;) {
    try {
      last = await client.readHaState();
      if (switchSettled(last, enter)) break;
    } catch {
      /* the node may be busy while VIPs move; keep reading until the deadline */
    }
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }
  if (last && switchSettled(last, enter)) {
    steps.push({ label: enter ? "Read back: this node is backup, the peer carries the VIPs" : "Read back: this node is master again", status: "done" });
    return result("done", enter ? "Switched over. This node is in maintenance mode; its VIPs run on the peer." : "Switched back. This node is master again.", gate.checks, last);
  }
  steps.push({
    label: enter ? "Read back: this node is backup" : "Read back: this node is master again",
    status: "failed",
    error: last ? `Still: ${haRole(last)}, maintenance ${last.maintenance ? "on" : "off"}.` : "The state could not be read.",
  });
  return result(
    "unverified",
    enter
      ? "Maintenance mode is on, but this node still reports itself as master for some VIPs. Check the peer before relying on the switch."
      : "Maintenance mode is off, but this node has not become master again yet. Check that CARP preemption is enabled.",
    gate.checks,
    last,
  );
}
