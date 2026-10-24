import {
  aliasFieldChanges,
  computeChangeSet,
  isLocalId,
  lockoutWarnings,
  planOrdering,
  ruleFieldChanges,
  RULE_FIELDS,
  validateWorkingState,
  type Alias,
  type FieldChange,
  type FirewallRule,
  type RiskWarning,
  type ValidationReport,
  type WorkingCopy,
} from "@ruledeck/core";
import {
  aliasToRecord,
  OpnsenseError,
  ruleChangedFields,
  ruleToRecord,
  type FlatRecord,
  type OpnsenseClient,
  type ReadResult,
} from "@ruledeck/opnsense-client";

/**
 * Apply pipeline (Phase 4):
 *   1. re-read the firewall and check for conflicts with the user's baseline
 *   2. validate the proposed state
 *   3. write: aliases (create, update) -> rules (create, update) -> rule deletes -> alias deletes
 *   4. activate: alias reconfigure (if aliases changed) + filter apply
 *   5. read back and verify every touched object and the rule order
 * It stops at the first failure and reports exactly what happened.
 */

export interface Conflict {
  objectType: "rule" | "alias";
  id: string;
  label: string;
  reason: "modified" | "deleted" | "name_taken" | "order_changed";
  message: string;
  fields?: FieldChange[];
}

export type StepStatus = "done" | "failed" | "skipped";

export interface ApplyStep {
  label: string;
  kind: "write" | "activate" | "verify";
  status: StepStatus;
  error?: string;
}

export type ApplyOutcome = "conflict" | "invalid" | "risky" | "success" | "partial" | "failed" | "unverified";

export interface ApplyResult {
  outcome: ApplyOutcome;
  conflicts?: Conflict[];
  validation?: ValidationReport;
  risks?: RiskWarning[];
  steps: ApplyStep[];
  /** What we know about the firewall after the run. */
  state: { written: number; totalWrites: number; activated: boolean; verified: boolean };
  verificationProblems?: string[];
  recovery?: string[];
  /** Local id -> firewall uuid for created objects. */
  createdIds?: Record<string, string>;
}

const labelRule = (r: FirewallRule) => r.description || `(${r.action} rule)`;

/** Compare the user's baseline with what the firewall has now. */
export function detectConflicts(wc: WorkingCopy, live: ReadResult): Conflict[] {
  const conflicts: Conflict[] = [];
  const changes = computeChangeSet(wc);
  const liveRules = new Map(live.rules.map((r) => [r.id, r]));
  const liveAliases = new Map(live.aliases.map((a) => [a.id, a]));

  for (const c of changes.changes) {
    if (isLocalId(c.id)) {
      if (c.objectType === "alias") {
        const name = wc.current.aliases.find((a) => a.id === c.id)?.name;
        if (name && live.aliases.some((a) => a.name === name)) {
          conflicts.push({ objectType: "alias", id: c.id, label: name, reason: "name_taken", message: `An alias named ${name} was created on the firewall meanwhile.` });
        }
      }
      continue;
    }
    const baseFp = wc.baseline.fingerprints[c.id];
    const liveFp = live.fingerprints[c.id];
    if (c.objectType === "rule") {
      const base = wc.baseline.rules.find((r) => r.id === c.id);
      const now = liveRules.get(c.id);
      if (!now) conflicts.push({ objectType: "rule", id: c.id, label: c.label, reason: "deleted", message: "This rule was deleted on the firewall." });
      else if (baseFp && liveFp && baseFp !== liveFp) {
        conflicts.push({ objectType: "rule", id: c.id, label: c.label, reason: "modified", message: "This rule was changed on the firewall.", fields: base ? ruleFieldChanges(base, now) : undefined });
      }
    } else {
      const base = wc.baseline.aliases.find((a) => a.id === c.id);
      const now = liveAliases.get(c.id);
      if (!now) conflicts.push({ objectType: "alias", id: c.id, label: c.label, reason: "deleted", message: "This alias was deleted on the firewall." });
      else if (baseFp && liveFp && baseFp !== liveFp) {
        conflicts.push({ objectType: "alias", id: c.id, label: c.label, reason: "modified", message: "This alias was changed on the firewall.", fields: base ? aliasFieldChanges(base, now) : undefined });
      }
    }
  }

  // Groups we will renumber must look exactly like they did when loaded.
  const plan = planOrdering(wc.baseline.rules, wc.current.rules);
  const touchedGroups = new Set(wc.current.rules.filter((r) => plan.has(r.id)).map((r) => r.prioGroup ?? ""));
  for (const g of touchedGroups) {
    const sig = (rules: FirewallRule[]) =>
      rules.filter((r) => r.origin === "mvc" && (r.prioGroup ?? "") === g).map((r) => `${r.id}@${r.sequence}`).join(",");
    if (sig(wc.baseline.rules) !== sig(live.rules)) {
      conflicts.push({
        objectType: "rule",
        id: `group:${g}`,
        label: `Rule order (group ${g})`,
        reason: "order_changed",
        message: "Rules in this group were added, removed or reordered on the firewall since you loaded it.",
      });
    }
  }
  return conflicts;
}

function changedAliasFields(before: Alias, after: Alias): FlatRecord {
  const a = aliasToRecord(before);
  const b = aliasToRecord(after);
  const out: FlatRecord = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if ((a[k] ?? "") !== (b[k] ?? "")) out[k] = b[k] ?? "";
  return out;
}

function errMsg(err: unknown): string {
  if (err instanceof OpnsenseError) {
    const v = err.details.validations;
    const detail = v ? " " + Object.entries(v).map(([k, m]) => `${k}: ${Array.isArray(m) ? m.join(", ") : m}`).join("; ") : "";
    return err.message + detail;
  }
  return "Unexpected error.";
}

const sameSet = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export async function runApply(
  client: OpnsenseClient,
  wc: WorkingCopy,
  opts: { acknowledgeRisks: boolean },
): Promise<ApplyResult> {
  const steps: ApplyStep[] = [];
  const state = { written: 0, totalWrites: 0, activated: false, verified: false };

  // 1. Conflicts against the live firewall.
  const live = await client.readAll();
  const conflicts = detectConflicts(wc, live);
  if (conflicts.length) return { outcome: "conflict", conflicts, steps, state };

  // 2. Validation against live options.
  const validation = validateWorkingState(wc.current, live.options, wc.baseline);
  if (validation.errorCount > 0) return { outcome: "invalid", validation, steps, state };

  const risks = lockoutWarnings(wc);
  if (risks.length && !opts.acknowledgeRisks) return { outcome: "risky", risks, steps, state };

  // 3. Build the write plan.
  const baseRules = new Map(wc.baseline.rules.map((r) => [r.id, r]));
  const baseAliases = new Map(wc.baseline.aliases.map((a) => [a.id, a]));
  const curRuleIds = new Set(wc.current.rules.map((r) => r.id));
  const curAliasIds = new Set(wc.current.aliases.map((a) => a.id));
  const sequences = planOrdering(wc.baseline.rules, wc.current.rules);
  const idMap = new Map<string, string>();

  type Op = { label: string; run: () => Promise<void> };
  const ops: Op[] = [];
  for (const a of wc.current.aliases) {
    const base = baseAliases.get(a.id);
    if (!base) {
      ops.push({ label: `Create alias ${a.name}`, run: async () => void idMap.set(a.id, await client.addAlias(aliasToRecord(a))) });
    } else {
      const fields = changedAliasFields(base, a);
      if (Object.keys(fields).length) ops.push({ label: `Update alias ${a.name}`, run: () => client.setAlias(a.id, fields) });
    }
  }
  for (const r of wc.current.rules) {
    if (r.origin !== "mvc") continue;
    const base = baseRules.get(r.id);
    const seq = sequences.get(r.id);
    if (!base) {
      const rec = ruleToRecord(r);
      if (seq !== undefined) rec.sequence = String(seq);
      ops.push({ label: `Create rule "${labelRule(r)}"`, run: async () => void idMap.set(r.id, await client.addRule(rec)) });
    } else {
      const fields = ruleChangedFields(base, r);
      if (seq !== undefined) fields.sequence = String(seq);
      if (Object.keys(fields).length) {
        const what = Object.keys(fields).length === 1 && fields.sequence ? "Reorder" : "Update";
        ops.push({ label: `${what} rule "${labelRule(r)}"`, run: () => client.setRule(r.id, fields) });
      }
    }
  }
  for (const r of wc.baseline.rules) {
    if (r.origin === "mvc" && !curRuleIds.has(r.id)) ops.push({ label: `Delete rule "${labelRule(r)}"`, run: () => client.deleteRule(r.id) });
  }
  for (const a of wc.baseline.aliases) {
    if (!curAliasIds.has(a.id)) ops.push({ label: `Delete alias ${a.name}`, run: () => client.deleteAlias(a.id) });
  }
  state.totalWrites = ops.length;
  const aliasesChanged = ops.some((o) => o.label.includes("alias"));

  // 3b. Write, stopping at the first failure.
  let failedAt = -1;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    try {
      await op.run();
      steps.push({ label: op.label, kind: "write", status: "done" });
      state.written++;
    } catch (err) {
      steps.push({ label: op.label, kind: "write", status: "failed", error: errMsg(err) });
      failedAt = i;
      break;
    }
  }
  if (failedAt >= 0) {
    for (const op of ops.slice(failedAt + 1)) steps.push({ label: op.label, kind: "write", status: "skipped" });
    steps.push({ label: "Activate configuration", kind: "activate", status: "skipped" });
    return {
      outcome: state.written > 0 ? "partial" : "failed",
      steps,
      state,
      createdIds: Object.fromEntries(idMap),
      recovery: recoveryForWriteFailure(state.written),
    };
  }

  // 4. Activate.
  try {
    if (aliasesChanged) {
      const s = await client.reconfigureAliases();
      if (s.trim().toLowerCase() !== "ok") throw new OpnsenseError("rejected", `Alias reload returned "${s.trim()}".`);
      steps.push({ label: "Reload aliases", kind: "activate", status: "done" });
    }
    const status = await client.applyFilter();
    if (!/^ok/i.test(status.trim())) throw new OpnsenseError("rejected", `Filter reload returned "${status.trim() || "(empty)"}".`);
    steps.push({ label: "Activate firewall rules", kind: "activate", status: "done" });
    state.activated = true;
  } catch (err) {
    steps.push({ label: "Activate firewall rules", kind: "activate", status: "failed", error: errMsg(err) });
    return { outcome: "partial", steps, state, createdIds: Object.fromEntries(idMap), recovery: recoveryForActivationFailure() };
  }

  // 5. Verify by reading back.
  const problems = await verify(client, wc, idMap);
  steps.push({ label: "Verify result on firewall", kind: "verify", status: problems.length ? "failed" : "done", error: problems.length ? `${problems.length} difference(s)` : undefined });
  state.verified = problems.length === 0;
  return {
    outcome: problems.length ? "unverified" : "success",
    steps,
    state,
    verificationProblems: problems.length ? problems : undefined,
    createdIds: Object.fromEntries(idMap),
    recovery: problems.length ? recoveryForVerification() : undefined,
  };
}

/** Read back and compare every touched object and the order of affected groups. */
export async function verify(client: OpnsenseClient, wc: WorkingCopy, idMap: Map<string, string>): Promise<string[]> {
  const problems: string[] = [];
  let after: ReadResult;
  try {
    after = await client.readAll();
  } catch (err) {
    return [`Could not read the firewall back: ${errMsg(err)}`];
  }
  const mapId = (id: string) => idMap.get(id) ?? id;
  const liveRules = new Map(after.rules.map((r) => [r.id, r]));
  const liveAliases = new Map(after.aliases.map((a) => [a.id, a]));
  const changes = computeChangeSet(wc);

  for (const c of changes.changes) {
    const id = mapId(c.id);
    if (c.objectType === "alias") {
      const live = liveAliases.get(id);
      if (c.kind === "delete") {
        if (live) problems.push(`Alias ${c.label} still exists.`);
        continue;
      }
      const want = wc.current.aliases.find((a) => a.id === c.id)!;
      if (!live) {
        problems.push(`Alias ${want.name} is missing.`);
        continue;
      }
      if (live.name !== want.name || live.type !== want.type || live.description !== want.description || !sameSet(live.entries, want.entries) || live.enabled !== want.enabled) {
        problems.push(`Alias ${want.name} differs from what was intended.`);
      }
    } else if (c.kind !== "reorder") {
      const live = liveRules.get(id);
      if (c.kind === "delete") {
        if (live) problems.push(`Rule "${c.label}" still exists.`);
        continue;
      }
      const want = wc.current.rules.find((r) => r.id === c.id)!;
      if (!live) {
        problems.push(`Rule "${c.label}" is missing.`);
        continue;
      }
      const diffs = RULE_FIELDS.filter((f) => f.get(want) !== f.get(live)).map((f) => `${f.label}: expected ${f.get(want) || "(empty)"}, found ${f.get(live) || "(empty)"}`);
      for (const [k, v] of Object.entries(want.extra)) {
        const base = wc.baseline.rules.find((r) => r.id === c.id);
        if (base && (base.extra[k] ?? "") !== v && (live.extra[k] ?? "") !== v) diffs.push(`${k}: expected ${v}, found ${live.extra[k] ?? "(empty)"}`);
      }
      if (diffs.length) problems.push(`Rule "${c.label}": ${diffs.join("; ")}`);
    }
  }

  // Order inside every group that has planned sequence changes.
  const plan = planOrdering(wc.baseline.rules, wc.current.rules);
  const groups = new Set(wc.current.rules.filter((r) => plan.has(r.id)).map((r) => r.prioGroup ?? ""));
  for (const g of groups) {
    const want = wc.current.rules.filter((r) => r.origin === "mvc" && (r.prioGroup ?? "") === g).map((r) => mapId(r.id));
    const have = after.rules.filter((r) => r.origin === "mvc" && (r.prioGroup ?? "") === g).map((r) => r.id);
    if (JSON.stringify(want) !== JSON.stringify(have)) problems.push(`Rule order in group ${g} is not as intended.`);
  }
  return problems;
}

function recoveryForWriteFailure(written: number): string[] {
  return [
    written > 0
      ? `${written} change(s) were saved to the OPNsense configuration but NOT activated. The firewall still runs the previous rules.`
      : "Nothing was changed on the firewall.",
    "Reload in RuleDeck to see the current firewall state, fix the problem shown above, and apply again.",
    "To undo what was saved: in OPNsense open System ▸ Configuration ▸ History and restore the revision from just before this apply.",
    "Alternatively, activate the saved changes from the OPNsense UI (Firewall ▸ Rules ▸ Apply) if they are what you want.",
  ];
}

function recoveryForActivationFailure(): string[] {
  return [
    "All changes were saved to the OPNsense configuration, but activation failed or was not confirmed. The running ruleset may be the old one.",
    "Check System ▸ Log Files ▸ General in OPNsense for filter reload errors.",
    "Try activating again from the OPNsense UI (Firewall ▸ Rules ▸ Apply), or restore the previous revision under System ▸ Configuration ▸ History.",
  ];
}

function recoveryForVerification(): string[] {
  return [
    "The changes were saved and activated, but the firewall's configuration doesn't fully match what you intended (see differences).",
    "Reload in RuleDeck and review the affected rules. Another administrator or an OPNsense default may have changed a value.",
    "To roll back: System ▸ Configuration ▸ History in OPNsense, restore the revision from just before this apply, then apply.",
  ];
}

