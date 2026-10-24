import type { FirewallRule, FirewallSnapshot, InterfaceInfo } from "./domain.ts";

/**
 * Rule ordering in OPNsense (26.x): rules sort by `prio_group` and then
 * `sequence` (1..999999). prio_group is derived from the interfaces:
 *   floating (none, several, or inverted) = 200000
 *   single interface group                = 300000 + group sequence
 *   single interface                      = 400000
 *   unknown interface (not applied)       = 600000
 */

export const PRIO_FLOATING = "200000";
export const PRIO_INTERFACE = "400000";
export const PRIO_INVALID = "600000";
export const MAX_SEQUENCE = 999999;

export function derivePrioGroup(
  rule: Pick<FirewallRule, "interfaces" | "interfaceNot">,
  interfaces: InterfaceInfo[],
  knownGroupPrio: ReadonlyMap<string, string> = new Map(),
): string {
  const ifs = rule.interfaces;
  if (ifs.length && !ifs.some((i) => interfaces.some((x) => x.key === i))) return PRIO_INVALID;
  if (ifs.length !== 1 || rule.interfaceNot) return PRIO_FLOATING;
  const info = interfaces.find((x) => x.key === ifs[0]);
  if (info?.kind === "group") return knownGroupPrio.get(ifs[0]!) ?? "300000";
  return PRIO_INTERFACE;
}

/** prio_group values of interface groups, learned from existing rules. */
export function groupPrioMap(snapshot: Pick<FirewallSnapshot, "rules" | "options">): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of snapshot.rules) {
    const iface = r.interfaces.length === 1 ? r.interfaces[0]! : null;
    if (!iface || !r.prioGroup) continue;
    if (snapshot.options.interfaces.find((i) => i.key === iface)?.kind === "group") map.set(iface, r.prioGroup);
  }
  return map;
}

function prioNum(g: string | undefined): number {
  return Number(g ?? PRIO_INTERFACE);
}

/**
 * Put a rule at the end of its priority group within the ordered rule list
 * (used when editing its interfaces moves it to another group).
 */
export function placeAtEndOfGroup(rules: FirewallRule[], rule: FirewallRule): FirewallRule[] {
  const without = rules.filter((r) => r.id !== rule.id);
  let idx = -1;
  for (let i = 0; i < without.length; i++) {
    const r = without[i]!;
    if (r.origin !== "mvc") continue;
    if (prioNum(r.prioGroup) <= prioNum(rule.prioGroup)) idx = i;
  }
  return [...without.slice(0, idx + 1), rule, ...without.slice(idx + 1)];
}

/** Longest strictly increasing subsequence of sequence numbers; returns kept indexes. */
function lisIndexes(values: (number | null)[]): Set<number> {
  const idx = values.map((v, i) => [v, i] as const).filter(([v]) => v !== null) as [number, number][];
  const tails: number[] = []; // index into idx
  const prev: number[] = new Array(idx.length).fill(-1);
  for (let k = 0; k < idx.length; k++) {
    const v = idx[k]![0];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (idx[tails[mid]!]![0] < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1]!;
    tails[lo] = k;
  }
  const keep = new Set<number>();
  let k = tails.length ? tails[tails.length - 1]! : -1;
  while (k >= 0) {
    keep.add(idx[k]![1]);
    k = prev[k]!;
  }
  return keep;
}

export interface SequenceItem {
  id: string;
  /** Current sequence on the firewall, or null for new rules. */
  sequence: number | null;
}

/**
 * Choose sequence numbers so the rules end up in the given order, changing as
 * few rules as possible. Returns only the ids whose sequence must change.
 */
export function planGroupSequences(desired: SequenceItem[]): Map<string, number> {
  const values = desired.map((d) => (d.sequence !== null && d.sequence >= 1 && d.sequence <= MAX_SEQUENCE ? d.sequence : null));
  const keep = lisIndexes(values);
  const result = new Map<string, number>();
  const assigned: number[] = desired.map((_, i) => (keep.has(i) ? values[i]! : NaN));

  let ok = true;
  let i = 0;
  while (i < desired.length && ok) {
    if (keep.has(i)) {
      i++;
      continue;
    }
    let j = i;
    while (j < desired.length && !keep.has(j)) j++;
    const lower = i > 0 ? assigned[i - 1]! : 0;
    const upper = j < desired.length ? assigned[j]! : MAX_SEQUENCE + 1;
    const count = j - i;
    if (upper - lower - 1 < count) {
      ok = false;
      break;
    }
    // Spread evenly in the gap, but prefer round steps of 10 after the last rule.
    const step = j >= desired.length ? Math.min(100, Math.floor((upper - lower - 1) / count)) : (upper - lower) / (count + 1);
    for (let k = 0; k < count; k++) assigned[i + k] = Math.floor(lower + step * (k + 1));
    // Guarantee strictly increasing after flooring.
    for (let k = 0; k < count; k++) {
      const prevVal = i + k > 0 ? assigned[i + k - 1]! : 0;
      if (assigned[i + k]! <= prevVal) assigned[i + k] = prevVal + 1;
    }
    if (assigned[j - 1]! >= upper) ok = false;
    i = j;
  }

  if (!ok) {
    // Not enough room: renumber the whole group.
    const step = Math.min(100, Math.floor(MAX_SEQUENCE / (desired.length + 1)));
    if (step < 1) throw new Error("Too many rules in one group to order.");
    desired.forEach((d, k) => {
      const seq = step * (k + 1);
      if (d.sequence !== seq) result.set(d.id, seq);
    });
    return result;
  }
  desired.forEach((d, k) => {
    if (d.sequence !== assigned[k]) result.set(d.id, assigned[k]!);
  });
  return result;
}

/**
 * Sequence changes needed so the firewall order matches the working copy.
 * Only groups with new rules, moved rules or rules that changed group are
 * planned, so untouched groups keep their numbers exactly.
 */
export function planOrdering(baseline: FirewallRule[], current: FirewallRule[]): Map<string, number> {
  const baseById = new Map(baseline.map((r) => [r.id, r]));
  const groups = new Map<string, SequenceItem[]>();
  for (const r of current) {
    if (r.origin !== "mvc") continue;
    const g = r.prioGroup ?? PRIO_INTERFACE;
    const base = baseById.get(r.id);
    const seq = base && base.prioGroup === r.prioGroup ? base.sequence : null;
    const list = groups.get(g) ?? [];
    list.push({ id: r.id, sequence: seq });
    groups.set(g, list);
  }
  const result = new Map<string, number>();
  for (const [g, items] of groups) {
    const hasNew = items.some((i) => i.sequence === null);
    const ids = new Set(items.map((i) => i.id));
    const baseOrder = baseline.filter((r) => r.origin === "mvc" && (r.prioGroup ?? PRIO_INTERFACE) === g && ids.has(r.id)).map((r) => r.id);
    const curOrder = items.filter((i) => i.sequence !== null).map((i) => i.id);
    if (!hasNew && JSON.stringify(baseOrder) === JSON.stringify(curOrder)) continue;
    for (const [id, seq] of planGroupSequences(items)) result.set(id, seq);
  }
  return result;
}
