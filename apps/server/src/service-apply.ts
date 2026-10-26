import {
  computeServiceChanges,
  gridById,
  isNewId,
  itemFingerprint,
  redactChange,
  type Item,
  type ServiceChange,
  type ServiceDef,
  type ServiceSnapshot,
  type ServiceWc,
} from "@ruledeck/core";
import { OpnsenseError, type OpnsenseClient } from "@ruledeck/opnsense-client";

/**
 * Apply staged changes of one service (DHCP, DNS, gateways, ...), with the same rules as rule changes:
 *  1. re-read the firewall; stop if anything the user changed was changed there too
 *  2. write: general settings, then new entries, then edits, then deletions; stop at the first failure
 *  3. activate (reconfigure)
 *  4. read back and compare with what was intended
 * No automatic rollback: recovery is the firewall's own configuration history.
 */

export interface ServiceStep {
  label: string;
  status: "done" | "failed" | "skipped";
  error?: string;
}

export interface ServiceConflict {
  id: string;
  label: string;
  message: string;
}

export type ServiceOutcome = "success" | "conflict" | "failed" | "partial" | "unverified" | "nothing";

export interface ServiceApplyResult {
  outcome: ServiceOutcome;
  steps: ServiceStep[];
  conflicts?: ServiceConflict[];
  verificationProblems?: string[];
  changes: Omit<ServiceChange, "patch">[];
  state: { written: number; totalWrites: number; activated: boolean; verified: boolean };
  recovery?: string[];
  /** Secret fields were written but can't be read back. */
  secretsNotVerified?: boolean;
}

const RECOVERY = [
  "RuleDeck does not roll back automatically.",
  "Open System ▸ Configuration ▸ History in OPNsense and restore the previous revision if needed.",
  "Reload the service in RuleDeck to see what is on the firewall now.",
];

function errText(e: unknown): string {
  if (!(e instanceof OpnsenseError)) return "Unexpected error.";
  const v = e.details.validations;
  const detail = v ? " " + Object.entries(v).map(([k, m]) => `${k}: ${Array.isArray(m) ? m.join(", ") : m}`).join("; ") : "";
  return e.message + detail;
}

export function detectServiceConflicts(def: ServiceDef, wc: ServiceWc, changes: ServiceChange[], live: ServiceSnapshot): ServiceConflict[] {
  const out: ServiceConflict[] = [];
  for (const c of changes) {
    if (c.kind === "create") continue;
    if (c.area === "settings") {
      const was = wc.baseline.fingerprints.settings;
      const now = live.fingerprints.settings;
      if (was !== now) out.push({ id: "settings", label: c.label, message: "The settings were changed on the firewall since you loaded them." });
      continue;
    }
    const key = `${c.area}:${c.id}`;
    if (!(key in live.fingerprints)) out.push({ id: c.id, label: c.label, message: "This entry no longer exists on the firewall." });
    else if (wc.baseline.fingerprints[key] !== live.fingerprints[key]) out.push({ id: c.id, label: c.label, message: "This entry was changed on the firewall since you loaded it." });
  }
  return out;
}

/** Compare what was intended with what the firewall now has (secret fields are skipped; they can't be read back). */
export function verifyService(def: ServiceDef, changes: ServiceChange[], live: ServiceSnapshot, created: Map<string, string>, secrets: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const same = (live: Item, patch: Item, what: string) => {
    for (const [k, v] of Object.entries(patch)) {
      if (secrets.has(k)) continue;
      if ((live[k] ?? "") !== v) problems.push(`${what}: ${k} is "${live[k] ?? ""}" on the firewall, expected "${v}".`);
    }
  };
  for (const c of changes) {
    if (c.area === "settings") {
      same(live.settings ?? {}, c.patch, c.label);
      continue;
    }
    const rows = live.grids[c.area] ?? [];
    const id = c.kind === "create" ? created.get(c.id) : c.id;
    if (c.kind === "delete") {
      if (rows.some((r) => r.id === c.id)) problems.push(`${c.label}: still on the firewall after deleting it.`);
      continue;
    }
    const row = id ? rows.find((r) => r.id === id) : undefined;
    if (!row) problems.push(`${c.label}: not found on the firewall after saving.`);
    else same(row.item, c.patch, c.label);
  }
  return problems;
}

export async function runServiceApply(client: OpnsenseClient, def: ServiceDef, wc: ServiceWc, siteId: string): Promise<ServiceApplyResult> {
  const steps: ServiceStep[] = [];
  const state = { written: 0, totalWrites: 0, activated: false, verified: false };
  const changes = computeServiceChanges(def, wc);
  const shown = changes.map(redactChange);
  if (!changes.length) return { outcome: "nothing", steps, changes: shown, state };

  // 1. Conflicts.
  const live = await client.readServiceSnapshot(def, siteId);
  const conflicts = detectServiceConflicts(def, wc, changes, live);
  if (conflicts.length) return { outcome: "conflict", conflicts, steps, changes: shown, state };

  // 2. Writes: settings, creates, edits, deletes.
  const order = [...changes.filter((c) => c.area === "settings"), ...changes.filter((c) => c.kind === "create"), ...changes.filter((c) => c.area !== "settings" && c.kind === "modify"), ...changes.filter((c) => c.kind === "delete")];
  state.totalWrites = order.length;
  const created = new Map<string, string>();
  for (const [i, c] of order.entries()) {
    const g = c.area === "settings" ? null : gridById(def, c.area);
    const what = c.area === "settings" ? "Save general settings" : `${c.kind === "create" ? "Add" : c.kind === "delete" ? "Delete" : "Save"} ${g?.label ?? c.area}: ${c.label}`;
    try {
      if (c.area === "settings") await client.saveServiceSettings(def, c.patch);
      else if (!g) throw new OpnsenseError("rejected", `Unknown table ${c.area}.`);
      else if (c.kind === "create") created.set(c.id, await client.addServiceItem(g, c.patch));
      else if (c.kind === "modify") await client.setServiceItem(g, c.id, c.patch);
      else await client.deleteServiceItem(g, c.id);
      steps.push({ label: what, status: "done" });
      state.written++;
    } catch (err) {
      steps.push({ label: what, status: "failed", error: errText(err) });
      for (const rest of order.slice(i + 1)) steps.push({ label: `${rest.kind} ${rest.label}`, status: "skipped" });
      return {
        outcome: state.written === 0 ? "failed" : "partial",
        steps,
        changes: shown,
        state,
        recovery: state.written === 0 ? undefined : RECOVERY,
      };
    }
  }

  // 3. Activate.
  if (def.reconfigure) {
    try {
      await client.reconfigureService(def);
      steps.push({ label: `Activate ${def.label}`, status: "done" });
      state.activated = true;
    } catch (err) {
      steps.push({ label: `Activate ${def.label}`, status: "failed", error: errText(err) });
      return { outcome: "partial", steps, changes: shown, state, recovery: ["The changes are saved on the firewall but not active yet.", ...RECOVERY] };
    }
  } else {
    state.activated = true;
  }

  // 4. Read back.
  const secrets = new Set(live.secrets);
  const hasSecret = changes.some((c) => Object.keys(c.patch).some((k) => secrets.has(k)));
  try {
    const after = await client.readServiceSnapshot(def, siteId);
    const problems = verifyService(def, changes, after, created, secrets);
    steps.push({ label: "Read back from the firewall and compare", status: problems.length ? "failed" : "done" });
    state.verified = problems.length === 0;
    if (problems.length) return { outcome: "unverified", steps, verificationProblems: problems, changes: shown, state, secretsNotVerified: hasSecret };
  } catch (err) {
    steps.push({ label: "Read back from the firewall and compare", status: "failed", error: errText(err) });
    return { outcome: "unverified", steps, verificationProblems: ["The firewall could not be read back."], changes: shown, state };
  }
  return { outcome: "success", steps, changes: shown, state, secretsNotVerified: hasSecret };
}

export { isNewId, itemFingerprint };
