import type { Alias, FirewallRule, FirewallSnapshot } from "./domain.ts";
import { isLocalId } from "./domain.ts";
import { uuidOfLocalId } from "./shared.ts";
import type { AliasPatch, RulePatch, WorkingCopy } from "./working-copy.ts";
import { ruleLabel } from "./working-copy.ts";

const SAME = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const RULE_PROPS: (keyof FirewallRule)[] = [
  "enabled", "action", "quick", "interfaces", "interfaceNot", "direction", "ipProtocol", "protocol",
  "source", "sourcePort", "destination", "destinationPort", "description", "log", "categories",
];

/** The domain properties the user changed on a rule (extra fields per key). */
export function rulePatch(base: FirewallRule, cur: FirewallRule): RulePatch {
  const patch: Record<string, unknown> = {};
  for (const k of RULE_PROPS) if (!SAME(base[k], cur[k])) patch[k] = cur[k];
  const extraChanged = Object.keys({ ...base.extra, ...cur.extra }).filter((k) => (base.extra[k] ?? "") !== (cur.extra[k] ?? ""));
  if (extraChanged.length) patch.extra = Object.fromEntries(extraChanged.map((k) => [k, cur.extra[k] ?? ""]));
  return patch as RulePatch;
}

export function aliasPatch(base: Alias, cur: Alias): AliasPatch {
  const patch: Record<string, unknown> = {};
  for (const k of ["name", "type", "enabled", "entries", "description", "categories"] as const) if (!SAME(base[k], cur[k])) patch[k] = cur[k];
  const extraChanged = Object.keys({ ...base.extra, ...cur.extra }).filter((k) => (base.extra[k] ?? "") !== (cur.extra[k] ?? ""));
  if (extraChanged.length) patch.extra = Object.fromEntries(extraChanged.map((k) => [k, cur.extra[k] ?? ""]));
  return patch as AliasPatch;
}

export interface RebaseResult {
  wc: WorkingCopy;
  /** Things that could not be carried over, in plain language. */
  notes: string[];
}

/**
 * Re-apply the user's staged edits on top of a freshly read snapshot.
 * Field edits are replayed onto the new version of each object. Edits to
 * objects that disappeared are dropped (and reported). Reorders are not
 * replayed because the surrounding order may have changed; they're reported.
 */
export function rebase(wc: WorkingCopy, fresh: FirewallSnapshot): RebaseResult {
  const notes: string[] = [];
  const oldBaseRules = new Map(wc.baseline.rules.filter((r) => r.origin === "mvc").map((r) => [r.id, r]));
  const oldBaseAliases = new Map(wc.baseline.aliases.map((a) => [a.id, a]));
  const freshAliasNames = new Set(fresh.aliases.map((a) => a.name));

  // ---- aliases
  const aliases: Alias[] = [];
  const curAliasIds = new Set(wc.current.aliases.map((a) => a.id));
  for (const fa of fresh.aliases) {
    const old = oldBaseAliases.get(fa.id);
    const cur = wc.current.aliases.find((a) => a.id === fa.id);
    if (old && !curAliasIds.has(fa.id)) continue; // deleted locally: keep deleted
    if (old && cur) {
      const patch = aliasPatch(old, cur);
      aliases.push(Object.keys(patch).length ? { ...fa, ...patch, extra: { ...fa.extra, ...(patch.extra ?? {}) } } : fa);
    } else aliases.push(fa);
  }
  for (const a of wc.current.aliases) {
    const landed = uuidOfLocalId(a.id);
    const freshCopy = landed ? fresh.aliases.find((f) => f.id === landed) : undefined;
    if (freshCopy) {
      // Created by an earlier (partly failed) apply: it exists now, so it becomes an update.
      const idx = aliases.findIndex((x) => x.id === landed);
      const merged = { ...a, id: landed!, extra: { ...freshCopy.extra, ...a.extra } };
      if (idx >= 0) aliases[idx] = merged;
      else aliases.push(merged);
    } else if (isLocalId(a.id)) {
      if (freshAliasNames.has(a.name)) notes.push(`New alias ${a.name} was not kept: an alias with that name now exists on the firewall.`);
      else aliases.push(a);
    } else if (!fresh.aliases.some((f) => f.id === a.id) && oldBaseAliases.has(a.id)) {
      const old = oldBaseAliases.get(a.id)!;
      if (!SAME(old, a)) notes.push(`Your edit to alias ${old.name} was dropped: it was deleted on the firewall.`);
    }
  }

  // ---- rules: start from fresh order, then apply local edits/deletes, then insert local creations
  const curById = new Map(wc.current.rules.filter((r) => r.origin === "mvc").map((r) => [r.id, r]));
  let rules: FirewallRule[] = [];
  for (const fr of fresh.rules) {
    const old = oldBaseRules.get(fr.id);
    const cur = curById.get(fr.id);
    if (old && !cur) continue; // deleted locally
    if (old && cur && fr.origin === "mvc") {
      const patch = rulePatch(old, cur);
      rules.push(Object.keys(patch).length ? { ...fr, ...patch, extra: { ...fr.extra, ...(patch.extra ?? {}) }, prioGroup: cur.prioGroup !== old.prioGroup ? cur.prioGroup : fr.prioGroup } : fr);
    } else rules.push(fr);
  }
  for (const [id, old] of oldBaseRules) {
    const cur = curById.get(id);
    if (!fresh.rules.some((f) => f.id === id) && cur && !SAME(old, cur)) {
      notes.push(`Your edit to rule "${ruleLabel(old)}" was dropped: it was deleted on the firewall.`);
    }
  }
  // Insert locally created rules after the nearest preceding rule that still exists.
  const order = wc.current.rules;
  for (let i = 0; i < order.length; i++) {
    const r = order[i]!;
    if (!isLocalId(r.id)) continue;
    const landed = uuidOfLocalId(r.id);
    const at = landed ? rules.findIndex((x) => x.id === landed) : -1;
    if (at >= 0) {
      // Created by an earlier (partly failed) apply: update it in place instead of creating it again.
      rules[at] = { ...r, id: landed!, extra: { ...rules[at]!.extra, ...r.extra }, prioGroup: rules[at]!.prioGroup, sequence: rules[at]!.sequence };
      continue;
    }
    let anchorIdx = -1;
    for (let k = i - 1; k >= 0; k--) {
      const idx = rules.findIndex((x) => x.id === order[k]!.id);
      if (idx >= 0) {
        anchorIdx = idx;
        break;
      }
    }
    rules = [...rules.slice(0, anchorIdx + 1), r, ...rules.slice(anchorIdx + 1)];
  }

  // Reorders are not replayed.
  const baseOrder = wc.baseline.rules.map((r) => r.id).filter((id) => curById.has(id));
  const curOrder = wc.current.rules.map((r) => r.id).filter((id) => oldBaseRules.has(id));
  if (!SAME(baseOrder, curOrder)) notes.push("Rule moves were not carried over. Check the order and move the rules again if needed.");

  const next: WorkingCopy = {
    baseline: fresh,
    current: { rules, aliases, nextLocalId: wc.current.nextLocalId },
    past: [],
    future: [],
  };
  return { wc: next, notes };
}
