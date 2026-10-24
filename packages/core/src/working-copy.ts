import type { Alias, FirewallRule, FirewallSnapshot } from "./domain.ts";
import { ANY_ADDRESS, ANY_PORT } from "./domain.ts";
import { aliasNamesInAddress } from "./address.ts";
import { derivePrioGroup, groupPrioMap, placeAtEndOfGroup } from "./ordering.ts";

/**
 * The working copy: the baseline read from the firewall plus the user's local
 * edits. All functions are pure and return a new WorkingCopy, so React can
 * hold it in state. Diffs are derived by comparing `current` with `baseline`.
 */

export interface WorkingState {
  /** Rules in evaluation order. */
  rules: FirewallRule[];
  aliases: Alias[];
  nextLocalId: number;
}

export interface WorkingCopy {
  baseline: FirewallSnapshot;
  current: WorkingState;
  past: WorkingState[];
  future: WorkingState[];
}

const HISTORY_LIMIT = 200;

export class WorkingCopyError extends Error {}

export type RulePatch = Partial<Omit<FirewallRule, "id" | "origin" | "prioGroup" | "sortOrder">>;
export type AliasPatch = Partial<Omit<Alias, "id">>;

export function createWorkingCopy(baseline: FirewallSnapshot): WorkingCopy {
  return {
    baseline,
    current: { rules: baseline.rules, aliases: baseline.aliases, nextLocalId: 1 },
    past: [],
    future: [],
  };
}

function commit(wc: WorkingCopy, next: WorkingState): WorkingCopy {
  const past = [...wc.past, wc.current];
  if (past.length > HISTORY_LIMIT) past.shift();
  return { ...wc, current: next, past, future: [] };
}

export function canUndo(wc: WorkingCopy): boolean {
  return wc.past.length > 0;
}

export function canRedo(wc: WorkingCopy): boolean {
  return wc.future.length > 0;
}

export function undo(wc: WorkingCopy): WorkingCopy {
  const prev = wc.past[wc.past.length - 1];
  if (!prev) return wc;
  return { ...wc, current: prev, past: wc.past.slice(0, -1), future: [wc.current, ...wc.future] };
}

export function redo(wc: WorkingCopy): WorkingCopy {
  const next = wc.future[0];
  if (!next) return wc;
  return { ...wc, current: next, past: [...wc.past, wc.current], future: wc.future.slice(1) };
}

/** Run several edits as one undo step (e.g. a multi-cell paste). */
export function batch(wc: WorkingCopy, fn: (wc: WorkingCopy) => WorkingCopy): WorkingCopy {
  const result = fn(wc);
  if (result.current === wc.current) return wc;
  return { ...result, past: [...wc.past, wc.current].slice(-HISTORY_LIMIT), future: [] };
}

/** Throw away all local edits. */
export function discardAll(wc: WorkingCopy): WorkingCopy {
  return commit(wc, { rules: wc.baseline.rules, aliases: wc.baseline.aliases, nextLocalId: wc.current.nextLocalId });
}

// ---------------------------------------------------------------------------
// Rules

function findRule(state: WorkingState, id: string): FirewallRule {
  const rule = state.rules.find((r) => r.id === id);
  if (!rule) throw new WorkingCopyError(`Rule ${id} not found.`);
  return rule;
}

function assertEditable(rule: FirewallRule): void {
  if (rule.origin !== "mvc") {
    throw new WorkingCopyError("This rule is managed outside the rules API (legacy or automatic) and is read-only.");
  }
}

export function updateRule(wc: WorkingCopy, id: string, patch: RulePatch): WorkingCopy {
  const rule = findRule(wc.current, id);
  assertEditable(rule);
  const updated = { ...rule, ...patch };
  let rules = wc.current.rules.map((r) => (r.id === id ? updated : r));
  if ("interfaces" in patch || "interfaceNot" in patch) {
    // Interfaces decide the priority group; OPNsense will move the rule there.
    const group = derivePrioGroup(updated, wc.baseline.options.interfaces, groupPrioMap(wc.baseline));
    if (group !== rule.prioGroup) {
      updated.prioGroup = group;
      rules = placeAtEndOfGroup(rules, updated);
    }
  }
  return commit(wc, { ...wc.current, rules });
}

/** Apply the same patch to several rules (bulk edit). Read-only rules are rejected up front. */
export function updateRules(wc: WorkingCopy, ids: string[], patch: RulePatch): WorkingCopy {
  const idSet = new Set(ids);
  for (const id of ids) assertEditable(findRule(wc.current, id));
  return commit(wc, {
    ...wc.current,
    rules: wc.current.rules.map((r) => (idSet.has(r.id) ? { ...r, ...patch } : r)),
  });
}

export function newRuleTemplate(id: string, prioGroup?: string): FirewallRule {
  return {
    id,
    origin: "mvc",
    enabled: true,
    action: "pass",
    quick: true,
    interfaces: [],
    interfaceNot: false,
    direction: "in",
    ipProtocol: "inet",
    protocol: "any",
    source: ANY_ADDRESS,
    sourcePort: ANY_PORT,
    destination: ANY_ADDRESS,
    destinationPort: ANY_PORT,
    description: "",
    log: false,
    categories: [],
    sequence: 0,
    prioGroup,
    extra: {},
  };
}

function insertAfter(rules: FirewallRule[], afterId: string | undefined, rule: FirewallRule): FirewallRule[] {
  if (afterId === undefined) return [...rules, rule];
  const idx = rules.findIndex((r) => r.id === afterId);
  if (idx < 0) return [...rules, rule];
  return [...rules.slice(0, idx + 1), rule, ...rules.slice(idx + 1)];
}

/** Add a new rule. Returns the new copy and the local id of the rule. */
export function addRule(
  wc: WorkingCopy,
  opts: { afterId?: string; patch?: RulePatch } = {},
): { wc: WorkingCopy; id: string } {
  const id = `new:${wc.current.nextLocalId}`;
  const anchor = opts.afterId ? wc.current.rules.find((r) => r.id === opts.afterId) : undefined;
  const rule: FirewallRule = {
    ...newRuleTemplate(id, anchor?.prioGroup),
    interfaces: anchor ? [...anchor.interfaces] : [],
    interfaceNot: anchor?.interfaceNot ?? false,
    ...opts.patch,
  };
  if (!anchor) rule.prioGroup = derivePrioGroup(rule, wc.baseline.options.interfaces, groupPrioMap(wc.baseline));
  const next = commit(wc, {
    ...wc.current,
    rules: insertAfter(wc.current.rules, opts.afterId, rule),
    nextLocalId: wc.current.nextLocalId + 1,
  });
  return { wc: next, id };
}

/** Duplicate a rule right below the original, with a new local identity. */
export function cloneRule(wc: WorkingCopy, sourceId: string): { wc: WorkingCopy; id: string } {
  const source = findRule(wc.current, sourceId);
  assertEditable(source);
  const id = `new:${wc.current.nextLocalId}`;
  // Rules are plain JSON data, so a JSON round-trip is a safe deep copy.
  const clone: FirewallRule = { ...(JSON.parse(JSON.stringify(source)) as FirewallRule), id, prioGroup: source.prioGroup };
  const next = commit(wc, {
    ...wc.current,
    rules: insertAfter(wc.current.rules, sourceId, clone),
    nextLocalId: wc.current.nextLocalId + 1,
  });
  return { wc: next, id };
}

export function deleteRules(wc: WorkingCopy, ids: string[]): WorkingCopy {
  const idSet = new Set(ids);
  for (const id of ids) assertEditable(findRule(wc.current, id));
  return commit(wc, { ...wc.current, rules: wc.current.rules.filter((r) => !idSet.has(r.id)) });
}

/**
 * Move a rule so it sits directly before `beforeId` (or at the end of its group
 * when `beforeId` is null). Only moves inside the same priority group are allowed,
 * matching OPNsense's move_rule_before.
 */
export function moveRule(wc: WorkingCopy, id: string, beforeId: string | null): WorkingCopy {
  const rule = findRule(wc.current, id);
  assertEditable(rule);
  const without = wc.current.rules.filter((r) => r.id !== id);
  let idx: number;
  if (beforeId === null) {
    const lastInGroup = without.map((r) => (r.origin === "mvc" ? r.prioGroup : undefined)).lastIndexOf(rule.prioGroup);
    idx = lastInGroup + 1;
  } else {
    const target = findRule(wc.current, beforeId);
    if (target.id === id) return wc;
    if (target.prioGroup !== rule.prioGroup) {
      throw new WorkingCopyError("Rules can only be reordered within the same group (floating, group or interface).");
    }
    idx = without.findIndex((r) => r.id === beforeId);
  }
  const rules = [...without.slice(0, idx), rule, ...without.slice(idx)];
  return commit(wc, { ...wc.current, rules });
}

/** Move a rule one step up or down within its group (keyboard reordering). */
export function nudgeRule(wc: WorkingCopy, id: string, delta: -1 | 1): WorkingCopy {
  const rule = findRule(wc.current, id);
  const group = wc.current.rules.filter((r) => r.prioGroup === rule.prioGroup && r.origin === "mvc");
  const pos = group.findIndex((r) => r.id === id);
  const targetPos = pos + delta;
  if (targetPos < 0 || targetPos >= group.length) return wc;
  if (delta === -1) return moveRule(wc, id, group[targetPos]!.id);
  const after = group[targetPos + 1];
  return moveRule(wc, id, after ? after.id : null);
}

// ---------------------------------------------------------------------------
// Aliases

export function findAliasByName(state: WorkingState, name: string): Alias | undefined {
  return state.aliases.find((a) => a.name === name);
}

export function addAlias(wc: WorkingCopy, alias: Omit<Alias, "id">): { wc: WorkingCopy; id: string } {
  if (findAliasByName(wc.current, alias.name)) {
    throw new WorkingCopyError(`An alias named "${alias.name}" already exists.`);
  }
  const id = `new:${wc.current.nextLocalId}`;
  const next = commit(wc, {
    ...wc.current,
    aliases: [...wc.current.aliases, { ...alias, id }],
    nextLocalId: wc.current.nextLocalId + 1,
  });
  return { wc: next, id };
}

function renameInRule(rule: FirewallRule, from: string, to: string): FirewallRule {
  const renameAddr = (spec: FirewallRule["source"]) =>
    spec.items.some((i) => i.kind === "alias" && i.name === from)
      ? { ...spec, items: spec.items.map((i) => (i.kind === "alias" && i.name === from ? { ...i, name: to } : i)) }
      : spec;
  const renamePort = (p: FirewallRule["sourcePort"]) => (p.kind === "alias" && p.name === from ? { ...p, name: to } : p);
  const source = renameAddr(rule.source);
  const destination = renameAddr(rule.destination);
  const sourcePort = renamePort(rule.sourcePort);
  const destinationPort = renamePort(rule.destinationPort);
  if (
    source === rule.source &&
    destination === rule.destination &&
    sourcePort === rule.sourcePort &&
    destinationPort === rule.destinationPort
  ) {
    return rule;
  }
  return { ...rule, source, destination, sourcePort, destinationPort };
}

/** Update an alias. Renames are propagated to rule references (as OPNsense does). */
export function updateAlias(wc: WorkingCopy, id: string, patch: AliasPatch): WorkingCopy {
  const alias = wc.current.aliases.find((a) => a.id === id);
  if (!alias) throw new WorkingCopyError(`Alias ${id} not found.`);
  const updated = { ...alias, ...patch };
  let rules = wc.current.rules;
  if (patch.name !== undefined && patch.name !== alias.name) {
    if (findAliasByName(wc.current, patch.name)) {
      throw new WorkingCopyError(`An alias named "${patch.name}" already exists.`);
    }
    rules = rules.map((r) => (r.origin === "mvc" ? renameInRule(r, alias.name, patch.name!) : r));
  }
  return commit(wc, {
    ...wc.current,
    rules,
    aliases: wc.current.aliases.map((a) => (a.id === id ? updated : a)),
  });
}

export interface AliasReference {
  ruleId: string;
  ruleLabel: string;
  fields: ("source" | "destination" | "sourcePort" | "destinationPort")[];
}

/** Which rules (and other aliases) reference the alias with this name. */
export function findAliasReferences(state: WorkingState, name: string): {
  rules: AliasReference[];
  aliases: string[];
} {
  const rules: AliasReference[] = [];
  for (const r of state.rules) {
    const fields: AliasReference["fields"] = [];
    if (aliasNamesInAddress(r.source).includes(name)) fields.push("source");
    if (aliasNamesInAddress(r.destination).includes(name)) fields.push("destination");
    if (r.sourcePort.kind === "alias" && r.sourcePort.name === name) fields.push("sourcePort");
    if (r.destinationPort.kind === "alias" && r.destinationPort.name === name) fields.push("destinationPort");
    if (fields.length) rules.push({ ruleId: r.id, ruleLabel: ruleLabel(r, state), fields });
  }
  const aliases = state.aliases.filter((a) => a.name !== name && a.entries.includes(name)).map((a) => a.name);
  return { rules, aliases };
}

/**
 * Delete an alias. If it is referenced, the deletion is refused unless
 * `acknowledgeReferences` is set. Referencing rules are then left pointing at a
 * missing alias, which validation reports, so they can't silently become "any".
 */
export function deleteAlias(
  wc: WorkingCopy,
  id: string,
  opts: { acknowledgeReferences?: boolean } = {},
): WorkingCopy {
  const alias = wc.current.aliases.find((a) => a.id === id);
  if (!alias) throw new WorkingCopyError(`Alias ${id} not found.`);
  const refs = findAliasReferences(wc.current, alias.name);
  if ((refs.rules.length || refs.aliases.length) && !opts.acknowledgeReferences) {
    throw new WorkingCopyError(
      `Alias "${alias.name}" is used by ${refs.rules.length} rule(s) and ${refs.aliases.length} alias(es).`,
    );
  }
  return commit(wc, { ...wc.current, aliases: wc.current.aliases.filter((a) => a.id !== id) });
}

// ---------------------------------------------------------------------------
// Helpers

export function ruleLabel(rule: FirewallRule, state?: { rules: FirewallRule[] }): string {
  if (rule.description) return rule.description;
  const pos = state ? state.rules.findIndex((r) => r.id === rule.id) + 1 : 0;
  return pos > 0 ? `#${pos} (${rule.action})` : `(${rule.action}, no description)`;
}
