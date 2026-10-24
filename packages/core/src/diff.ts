import type { Alias, FirewallRule } from "./domain.ts";
import { isLocalId } from "./domain.ts";
import { formatAddress, formatPort } from "./address.ts";
import type { WorkingCopy } from "./working-copy.ts";
import { ruleLabel } from "./working-copy.ts";

/**
 * Change sets derived from comparing the working copy with its baseline.
 * The text rendering is meant to be readable by a network administrator.
 */

export interface FieldChange {
  field: string;
  label: string;
  before?: string;
  after?: string;
  /** For list-valued fields (alias entries). */
  added?: string[];
  removed?: string[];
}

export type ChangeKind = "create" | "modify" | "delete" | "reorder";

export interface Change {
  kind: ChangeKind;
  objectType: "rule" | "alias";
  id: string;
  label: string;
  fields: FieldChange[];
}

export interface ChangeSet {
  changes: Change[];
  counts: Record<ChangeKind, number>;
}

interface RuleField {
  key: string;
  label: string;
  get: (r: FirewallRule) => string;
}

export const RULE_FIELDS: RuleField[] = [
  { key: "enabled", label: "Enabled", get: (r) => (r.enabled ? "yes" : "no") },
  { key: "action", label: "Action", get: (r) => r.action },
  { key: "quick", label: "Quick", get: (r) => (r.quick ? "yes" : "no") },
  {
    key: "interfaces",
    label: "Interface",
    get: (r) => (r.interfaceNot ? "!" : "") + (r.interfaces.length ? r.interfaces.join(", ") : "any"),
  },
  { key: "direction", label: "Direction", get: (r) => r.direction },
  { key: "ipProtocol", label: "IP version", get: (r) => ({ inet: "IPv4", inet6: "IPv6", inet46: "IPv4+6" })[r.ipProtocol] },
  { key: "protocol", label: "Protocol", get: (r) => r.protocol },
  { key: "source", label: "Source", get: (r) => formatAddress(r.source) },
  { key: "sourcePort", label: "Source port", get: (r) => formatPort(r.sourcePort) },
  { key: "destination", label: "Destination", get: (r) => formatAddress(r.destination) },
  { key: "destinationPort", label: "Port", get: (r) => formatPort(r.destinationPort) },
  { key: "description", label: "Description", get: (r) => r.description },
  { key: "log", label: "Logging", get: (r) => (r.log ? "yes" : "no") },
  { key: "categories", label: "Categories", get: (r) => r.categories.join(", ") },
];

export function ruleFieldChanges(before: FirewallRule, after: FirewallRule): FieldChange[] {
  const out: FieldChange[] = [];
  for (const f of RULE_FIELDS) {
    const a = f.get(before);
    const b = f.get(after);
    if (a !== b) out.push({ field: f.key, label: f.label, before: a, after: b });
  }
  const keys = new Set([...Object.keys(before.extra), ...Object.keys(after.extra)]);
  for (const k of [...keys].sort()) {
    const a = before.extra[k] ?? "";
    const b = after.extra[k] ?? "";
    if (a !== b) out.push({ field: `extra.${k}`, label: k, before: a, after: b });
  }
  return out;
}

function ruleCreateFields(r: FirewallRule): FieldChange[] {
  const fields = RULE_FIELDS.map((f) => ({ field: f.key, label: f.label, after: f.get(r) })).filter(
    (f) => f.after !== "" && !(f.field === "categories"),
  );
  return fields;
}

export function aliasFieldChanges(before: Alias, after: Alias): FieldChange[] {
  const out: FieldChange[] = [];
  const simple: [keyof Alias, string][] = [
    ["name", "Name"],
    ["type", "Type"],
    ["description", "Description"],
  ];
  for (const [k, label] of simple) {
    if (before[k] !== after[k]) out.push({ field: k, label, before: String(before[k]), after: String(after[k]) });
  }
  if (before.enabled !== after.enabled) {
    out.push({ field: "enabled", label: "Enabled", before: before.enabled ? "yes" : "no", after: after.enabled ? "yes" : "no" });
  }
  const added = after.entries.filter((e) => !before.entries.includes(e));
  const removed = before.entries.filter((e) => !after.entries.includes(e));
  if (added.length || removed.length) out.push({ field: "entries", label: "Entries", added, removed });
  const keys = new Set([...Object.keys(before.extra), ...Object.keys(after.extra)]);
  for (const k of [...keys].sort()) {
    const a = before.extra[k] ?? "";
    const b = after.extra[k] ?? "";
    if (a !== b) out.push({ field: `extra.${k}`, label: k, before: a, after: b });
  }
  return out;
}

/** Baseline rules (still present) whose relative order changed, per priority group. */
function reorderedRuleIds(baseline: FirewallRule[], current: FirewallRule[]): Set<string> {
  const currentIds = new Set(current.map((r) => r.id));
  const groups = new Map<string, { base: string[]; cur: string[] }>();
  const groupOf = (r: FirewallRule) => r.prioGroup ?? "";
  for (const r of baseline) {
    if (!currentIds.has(r.id)) continue;
    const g = groups.get(groupOf(r)) ?? { base: [], cur: [] };
    g.base.push(r.id);
    groups.set(groupOf(r), g);
  }
  const baseIds = new Set(baseline.map((r) => r.id));
  for (const r of current) {
    if (!baseIds.has(r.id)) continue;
    groups.get(groupOf(r))?.cur.push(r.id);
  }
  const moved = new Set<string>();
  for (const { base, cur } of groups.values()) {
    // Rules whose predecessor changed are the ones that visibly moved.
    // Using the longest common subsequence keeps the list minimal.
    const keep = lcs(base, cur);
    for (const id of cur) if (!keep.has(id)) moved.add(id);
  }
  return moved;
}

function lcs(a: string[], b: string[]): Set<string> {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.add(a[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

export function computeChangeSet(wc: WorkingCopy): ChangeSet {
  const changes: Change[] = [];
  const baseAliases = new Map(wc.baseline.aliases.map((a) => [a.id, a]));
  const curAliasIds = new Set(wc.current.aliases.map((a) => a.id));

  // Aliases first: rules may depend on them.
  for (const a of wc.current.aliases) {
    const base = baseAliases.get(a.id);
    if (!base || isLocalId(a.id)) {
      changes.push({
        kind: "create",
        objectType: "alias",
        id: a.id,
        label: a.name,
        fields: [
          { field: "type", label: "Type", after: a.type },
          ...(a.description ? [{ field: "description", label: "Description", after: a.description }] : []),
          { field: "entries", label: "Entries", added: a.entries, removed: [] },
        ],
      });
    } else {
      const fields = aliasFieldChanges(base, a);
      if (fields.length) changes.push({ kind: "modify", objectType: "alias", id: a.id, label: a.name, fields });
    }
  }
  for (const a of wc.baseline.aliases) {
    if (!curAliasIds.has(a.id)) changes.push({ kind: "delete", objectType: "alias", id: a.id, label: a.name, fields: [] });
  }

  const baseRules = new Map(wc.baseline.rules.map((r) => [r.id, r]));
  const curRuleIds = new Set(wc.current.rules.map((r) => r.id));
  for (const r of wc.current.rules) {
    const base = baseRules.get(r.id);
    if (!base) {
      changes.push({ kind: "create", objectType: "rule", id: r.id, label: ruleLabel(r, wc.current), fields: ruleCreateFields(r) });
    } else {
      const fields = ruleFieldChanges(base, r);
      if (fields.length) changes.push({ kind: "modify", objectType: "rule", id: r.id, label: ruleLabel(r, wc.current), fields });
    }
  }
  for (const r of wc.baseline.rules) {
    if (!curRuleIds.has(r.id)) {
      changes.push({ kind: "delete", objectType: "rule", id: r.id, label: ruleLabel(r, wc.baseline), fields: [] });
    }
  }
  for (const id of reorderedRuleIds(wc.baseline.rules, wc.current.rules)) {
    const r = wc.current.rules.find((x) => x.id === id)!;
    const before = wc.baseline.rules.findIndex((x) => x.id === id) + 1;
    const after = wc.current.rules.findIndex((x) => x.id === id) + 1;
    changes.push({
      kind: "reorder",
      objectType: "rule",
      id,
      label: ruleLabel(r, wc.current),
      fields: [{ field: "position", label: "Position", before: String(before), after: String(after) }],
    });
  }

  const counts = { create: 0, modify: 0, delete: 0, reorder: 0 };
  for (const c of changes) counts[c.kind]++;
  return { changes, counts };
}

export type ChangeStatus = "unchanged" | "added" | "modified";

export function ruleStatus(wc: WorkingCopy, rule: FirewallRule): ChangeStatus {
  const base = wc.baseline.rules.find((r) => r.id === rule.id);
  if (!base) return "added";
  if (base === rule) return "unchanged";
  return ruleFieldChanges(base, rule).length ? "modified" : "unchanged";
}

/** Set of field keys that differ from the baseline (for cell highlighting). */
export function changedRuleFields(wc: WorkingCopy, rule: FirewallRule): Set<string> {
  const base = wc.baseline.rules.find((r) => r.id === rule.id);
  if (!base || base === rule) return new Set();
  return new Set(ruleFieldChanges(base, rule).map((f) => f.field));
}

export function aliasStatus(wc: WorkingCopy, alias: Alias): ChangeStatus {
  const base = wc.baseline.aliases.find((a) => a.id === alias.id);
  if (!base) return "added";
  if (base === alias) return "unchanged";
  return aliasFieldChanges(base, alias).length ? "modified" : "unchanged";
}

const KIND_LABEL: Record<ChangeKind, string> = {
  create: "CREATE",
  modify: "MODIFY",
  delete: "DELETE",
  reorder: "MOVE",
};

/** Plain-text diff in the format from the project book. */
export function formatChangeSet(set: ChangeSet): string {
  const lines: string[] = [];
  for (const c of set.changes) {
    const type = c.objectType === "rule" ? "Rule" : "Alias";
    lines.push(`${KIND_LABEL[c.kind].padEnd(8)}${type}: ${c.label}`);
    const scalar = c.fields.filter((f) => !f.added && !f.removed);
    const width = Math.max(0, ...scalar.map((f) => f.label.length)) + 1;
    for (const f of c.fields) {
      if (f.added || f.removed) {
        lines.push(`  ${f.label}:`);
        for (const e of f.removed ?? []) lines.push(`    - ${e}`);
        for (const e of f.added ?? []) lines.push(`    + ${e}`);
      } else if (c.kind === "create") {
        lines.push(`  ${(f.label + ":").padEnd(width + 1)}${f.after}`);
      } else {
        lines.push(`  ${(f.label + ":").padEnd(width + 1)}${f.before || "(empty)"} -> ${f.after || "(empty)"}`);
      }
    }
    lines.push("");
  }
  if (set.changes.length) lines.push("APPLY   Firewall configuration");
  return lines.join("\n");
}
