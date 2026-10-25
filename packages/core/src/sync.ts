import type { AddressSpec, Alias, FirewallRule, FirewallSnapshot, InterfaceInfo } from "./domain.ts";
import { aliasFieldChanges, ruleFieldChanges, type FieldChange } from "./diff.ts";
import { SHARED_FORBIDDEN_FIELDS } from "./shared.ts";
import { addAlias, addRule, batch, ruleLabel, updateAlias, updateRule, type WorkingCopy, type WorkingState } from "./working-copy.ts";

/**
 * One-off sync of rules and aliases from one site to another.
 *
 * Unlike the "shared policy" (same uuid everywhere, kept in step), a sync copies
 * what the source has *now* into the target's working copy. The result is
 * ordinary pending changes at the target: review, then apply as usual.
 *
 *  - aliases are matched by name
 *  - rules are matched by uuid (shared rules), else by description
 *  - interfaces are translated by key + label; rules that can't be translated are blocked
 *  - aliases a rule (or another alias) needs are brought along when the target lacks them
 *  - categories are never copied (they're per site)
 */

export type SyncKind = "create" | "update" | "same" | "blocked";

export interface SyncItem {
  objectType: "rule" | "alias";
  /** Id in the source. */
  sourceId: string;
  label: string;
  kind: SyncKind;
  /** Id of the matching object at the target (update/same). */
  targetId?: string;
  changes: FieldChange[];
  /** Why the item can't be synced (kind = blocked). */
  reasons: string[];
  /** Things to know but not blocking. */
  warnings: string[];
  /** Brought along because a selected object needs it. */
  dependency: boolean;
  /** The object as it will exist at the target. */
  desired: FirewallRule | Alias;
}

export interface SyncPlan {
  items: SyncItem[];
  counts: Record<SyncKind, number>;
}

/** Alias types whose content means the same on every site. */
export const SYNCABLE_ALIAS_TYPES = ["host", "network", "port", "url", "urltable", "geoip", "networkgroup", "mac", "asn"];

type Options = FirewallSnapshot["options"];

function translateKey(key: string, from: InterfaceInfo[], to: InterfaceInfo[]): string | null {
  const src = from.find((i) => i.key === key);
  const sameKey = to.find((i) => i.key === key);
  if (sameKey && (!src || src.label.toLowerCase() === sameKey.label.toLowerCase())) return sameKey.key;
  if (!src) return null;
  return to.find((i) => i.label.toLowerCase() === src.label.toLowerCase() && i.kind === src.kind)?.key ?? null;
}

function translateRuleInterfaces(rule: FirewallRule, from: Options, to: Options): { rule: FirewallRule; missing: string[] } {
  const missing: string[] = [];
  const t = (key: string) => {
    const k = translateKey(key, from.interfaces, to.interfaces);
    if (k === null) missing.push(from.interfaces.find((i) => i.key === key)?.label ?? key);
    return k ?? key;
  };
  const addr = (spec: AddressSpec): AddressSpec => ({
    ...spec,
    items: spec.items.map((i) => (i.kind === "interfaceNet" || i.kind === "interfaceAddr" ? { ...i, iface: t(i.iface) } : i)),
  });
  return {
    rule: { ...rule, interfaces: rule.interfaces.map(t), source: addr(rule.source), destination: addr(rule.destination) },
    missing: [...new Set(missing)],
  };
}

function aliasNamesOf(rule: FirewallRule): string[] {
  const out: string[] = [];
  for (const i of [...rule.source.items, ...rule.destination.items]) if (i.kind === "alias") out.push(i.name);
  for (const p of [rule.sourcePort, rule.destinationPort]) if (p.kind === "alias") out.push(p.name);
  return out;
}

const withoutForbidden = (extra: Record<string, string>) => Object.fromEntries(Object.entries(extra).filter(([k]) => !SHARED_FORBIDDEN_FIELDS.includes(k)));

function planAlias(src: Alias, srcAliases: Map<string, Alias>, target: WorkingState, dependency: boolean, plan: Map<string, SyncItem>): void {
  const key = `alias:${src.name}`;
  if (plan.has(key)) return;
  const reasons: string[] = [];
  if (!SYNCABLE_ALIAS_TYPES.includes(src.type)) reasons.push(`Alias type "${src.type}" depends on the firewall it runs on and can't be synced.`);
  const existing = target.aliases.find((a) => a.name === src.name);
  const desired: Alias = {
    ...src,
    id: existing?.id ?? src.id,
    categories: existing?.categories ?? [],
    extra: { ...(existing?.extra ?? {}), ...src.extra },
  };
  const item: SyncItem = {
    objectType: "alias",
    sourceId: src.id,
    label: src.name,
    kind: "create",
    targetId: existing?.id,
    changes: [],
    reasons,
    warnings: [],
    dependency,
    desired,
  };
  // Nested aliases first, so they exist (and are created) before this one.
  for (const entry of src.entries) {
    const nested = srcAliases.get(entry);
    if (nested) planAlias(nested, srcAliases, target, true, plan);
  }
  if (existing) {
    item.changes = aliasFieldChanges(existing, desired);
    const extraDiff = Object.keys(desired.extra).some((k) => (existing.extra[k] ?? "") !== desired.extra[k]);
    item.kind = item.changes.length || extraDiff ? "update" : "same";
    if (extraDiff && !item.changes.length) item.changes = [{ field: "extra", label: "Settings", before: "", after: "differs" }];
  } else {
    item.changes = aliasFieldChanges({ ...desired, name: "", type: "", entries: [], description: "", enabled: false }, desired);
  }
  if (reasons.length) item.kind = "blocked";
  plan.set(key, item);
}

/**
 * What would happen if the selected rules/aliases of `source` were copied into `target`.
 * Nothing is changed; call {@link applySyncPlan} to stage it.
 */
export function planSync(
  source: Pick<FirewallSnapshot, "rules" | "aliases" | "options">,
  target: WorkingCopy,
  selection: { ruleIds: string[]; aliasIds: string[] },
): SyncPlan {
  const state = target.current;
  const srcAliases = new Map(source.aliases.map((a) => [a.name, a]));
  const plan = new Map<string, SyncItem>();

  // Aliases that rules need are planned first (they have to exist before the rules).
  const ruleItems: SyncItem[] = [];
  const aliasOrder: Alias[] = [];
  for (const id of selection.aliasIds) {
    const a = source.aliases.find((x) => x.id === id);
    if (a) aliasOrder.push(a);
  }

  const wantedRules = source.rules.filter((r) => selection.ruleIds.includes(r.id));
  const targetRules = state.rules.filter((r) => r.origin === "mvc");
  for (const r of wantedRules) {
    const reasons: string[] = [];
    const warnings: string[] = [];
    if (r.origin !== "mvc") reasons.push("Legacy and automatic rules can't be synced.");
    for (const f of SHARED_FORBIDDEN_FIELDS) {
      if (r.extra[f] && r.extra[f] !== "0") reasons.push(`"${f}" is set; it means something different at each site.`);
    }
    const tr = translateRuleInterfaces(r, source.options, target.baseline.options);
    if (tr.missing.length) reasons.push(`Interface ${tr.missing.join(", ")} doesn't exist at the target.`);

    // Match: same uuid, else same description.
    let existing = targetRules.find((x) => x.id === r.id);
    if (!existing && r.description) {
      const byName = targetRules.filter((x) => x.description === r.description);
      if (byName.length > 1) reasons.push(`${byName.length} rules named "${r.description}" at the target; can't tell which one to update.`);
      else existing = byName[0];
    }

    for (const name of aliasNamesOf(r)) {
      const inSource = srcAliases.get(name);
      const atTarget = state.aliases.find((a) => a.name === name);
      if (!inSource && !atTarget) reasons.push(`Uses alias ${name}, which exists at neither site.`);
      else if (inSource && !atTarget) planAlias(inSource, srcAliases, state, true, plan);
      else if (inSource && atTarget) {
        // Same name at both sites: don't change it silently, but say when the content differs.
        const d = aliasFieldChanges(atTarget, { ...inSource, id: atTarget.id, categories: atTarget.categories, extra: atTarget.extra });
        if (d.length) warnings.push(`Alias ${name} differs between the sites and is not changed. Sync it too if that is intended.`);
      }
    }

    const desired: FirewallRule = {
      ...tr.rule,
      id: existing?.id ?? r.id,
      origin: "mvc",
      categories: existing?.categories ?? [],
      sequence: existing?.sequence ?? 0,
      prioGroup: existing?.prioGroup,
      sortOrder: existing?.sortOrder,
      extra: { ...(existing?.extra ?? {}), ...withoutForbidden(r.extra) },
    };
    const changes = existing ? ruleFieldChanges(existing, desired) : [];
    let kind: SyncKind = existing ? (changes.length ? "update" : "same") : "create";
    // A rule without a description can't be matched; don't create the same thing again and again.
    if (!existing && !r.description) {
      const twin = targetRules.find((x) => ruleFieldChanges(x, { ...desired, id: x.id, categories: x.categories, extra: x.extra, description: x.description }).length === 0);
      if (twin) kind = "same";
    }
    if (reasons.length) kind = "blocked";
    ruleItems.push({
      objectType: "rule",
      sourceId: r.id,
      label: ruleLabel(r, source),
      kind,
      targetId: existing?.id,
      changes,
      reasons,
      warnings,
      dependency: false,
      desired,
    });
  }

  for (const a of aliasOrder) {
    const was = plan.get(`alias:${a.name}`);
    planAlias(a, srcAliases, state, false, plan);
    if (was) was.dependency = false; // it was asked for explicitly
  }

  const items = [...plan.values(), ...ruleItems];
  const counts: Record<SyncKind, number> = { create: 0, update: 0, same: 0, blocked: 0 };
  for (const i of items) counts[i.kind]++;
  return { items, counts };
}

/** Stage a plan in the target's working copy (one undo step). Blocked and unchanged items are skipped. */
export function applySyncPlan(wc: WorkingCopy, plan: SyncPlan, sourceRules: readonly FirewallRule[]): WorkingCopy {
  return batch(wc, (start) => {
    let cur = start;
    for (const item of plan.items) {
      if (item.objectType !== "alias" || (item.kind !== "create" && item.kind !== "update")) continue;
      const a = item.desired as Alias;
      if (item.kind === "create") {
        const { id: _id, ...rest } = a;
        cur = addAlias(cur, { ...rest, categories: [] }).wc;
      } else {
        cur = updateAlias(cur, item.targetId!, { type: a.type, enabled: a.enabled, entries: a.entries, description: a.description, extra: a.extra });
      }
    }

    // Rules go in source order; a new rule sits below the target counterpart of the rule above it in the source.
    const targetOf = new Map<string, string>();
    for (const item of plan.items) if (item.objectType === "rule" && item.targetId) targetOf.set(item.sourceId, item.targetId);
    const order = new Map(sourceRules.map((r, i) => [r.id, i]));
    const rules = plan.items.filter((i) => i.objectType === "rule").sort((a, b) => (order.get(a.sourceId) ?? 0) - (order.get(b.sourceId) ?? 0));
    for (const item of rules) {
      if (item.kind !== "create" && item.kind !== "update") continue;
      const r = item.desired as FirewallRule;
      const fields = {
        enabled: r.enabled, action: r.action, quick: r.quick, interfaces: r.interfaces, interfaceNot: r.interfaceNot, direction: r.direction,
        ipProtocol: r.ipProtocol, protocol: r.protocol, source: r.source, sourcePort: r.sourcePort, destination: r.destination,
        destinationPort: r.destinationPort, description: r.description, log: r.log, extra: r.extra,
      };
      if (item.kind === "update") {
        cur = updateRule(cur, item.targetId!, fields);
      } else {
        const srcIdx = order.get(item.sourceId) ?? 0;
        const group = sourceRules[srcIdx]?.prioGroup;
        let afterId: string | undefined;
        for (let i = srcIdx - 1; i >= 0; i--) {
          const prev = sourceRules[i]!;
          if (prev.prioGroup !== group) break;
          const t = targetOf.get(prev.id);
          if (t) {
            afterId = t;
            break;
          }
        }
        const added = addRule(cur, { afterId, patch: fields });
        cur = added.wc;
        targetOf.set(item.sourceId, added.id);
      }
    }
    return cur;
  });
}
