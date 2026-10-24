import type { AddressItem, AddressSpec, Alias, FirewallRule, FirewallSnapshot, InterfaceInfo } from "./domain.ts";
import { aliasFieldChanges, computeChangeSet, ruleFieldChanges, type FieldChange } from "./diff.ts";
import { derivePrioGroup, groupPrioMap } from "./ordering.ts";
import type { WorkingCopy, WorkingState } from "./working-copy.ts";

/**
 * Multi-site shared policy.
 *
 * A rule or alias is "shared" when it carries the marker category. Shared
 * objects have the SAME uuid on every site (OPNsense set_rule/set_item upsert
 * by uuid), so the firewalls themselves are the source of truth and RuleDeck
 * stores nothing. Shared rules use LOGICAL interface names (e.g. DMZ) which
 * each site maps to a real interface key (opt1, opt2, ...) via the topology.
 */

export const SHARED_CATEGORY_UUID = "b6f1c2d4-7e3a-4f20-9c41-2a8d0e6b13f7";
export const SHARED_CATEGORY_NAME = "RuleDeck shared";
export const SHARED_CATEGORY_COLOR = "2f6fde";

/** Extra rule fields that must be empty/default on shared rules (they mean something different per site). */
export const SHARED_FORBIDDEN_FIELDS = ["gateway", "replyto", "reply-to", "sched", "divert-to", "overload", "shaper1", "shaper2"];
/** Extra rule fields whose value is compared and pushed for shared rules. */
export const SHARED_SAFE_EXTRA_FIELDS = ["statetype", "state-policy", "icmptype", "icmp6type", "allowopts", "tag", "tagged", "max", "statetimeout"];
/** Alias types that mean the same thing on every site. */
export const SHARED_ALIAS_TYPES = ["host", "network", "port", "url", "urltable", "geoip"];

export type SiteInterfaceMap = Record<string, { key: string; label: string }>;

export interface SiteInput {
  siteId: string;
  siteName: string;
  map: SiteInterfaceMap;
  snapshot: FirewallSnapshot;
}

export class MappingError extends Error {
  constructor(
    public readonly siteId: string,
    public readonly what: string,
  ) {
    super(what);
  }
}

export function isShared(obj: { categories: string[] }): boolean {
  return obj.categories.includes(SHARED_CATEGORY_UUID);
}

/** `new:<uuid>` -> uuid (shared/new objects carry their final uuid from the start). */
export function uuidOfLocalId(id: string): string | null {
  const m = /^new:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(id);
  return m ? m[1]!.toLowerCase() : null;
}

/** The uuid an object has (or will have) on the firewalls. */
export function objectUuid(id: string): string {
  return uuidOfLocalId(id) ?? id;
}

// ---------------------------------------------------------------------------
// Interface translation

function mapItem(item: AddressItem, f: (iface: string) => string): AddressItem {
  if (item.kind === "interfaceNet" || item.kind === "interfaceAddr") return { ...item, iface: f(item.iface) };
  return item;
}

function mapAddress(spec: AddressSpec, f: (iface: string) => string): AddressSpec {
  return { ...spec, items: spec.items.map((i) => mapItem(i, f)) };
}

/** Logical -> site-physical. Throws MappingError if a logical name isn't mapped. */
export function localizeRule(rule: FirewallRule, map: SiteInterfaceMap, siteId: string): FirewallRule {
  const f = (logical: string) => {
    const m = map[logical];
    if (!m) throw new MappingError(siteId, `Interface "${logical}" has no mapping at this site.`);
    return m.key;
  };
  return { ...rule, interfaces: rule.interfaces.map(f), source: mapAddress(rule.source, f), destination: mapAddress(rule.destination, f) };
}

/** Site-physical -> logical. Throws MappingError for interfaces outside the map. */
export function canonicalizeRule(rule: FirewallRule, map: SiteInterfaceMap, siteId: string): FirewallRule {
  const reverse = new Map(Object.entries(map).map(([logical, m]) => [m.key, logical]));
  const f = (key: string) => {
    const l = reverse.get(key);
    if (!l) throw new MappingError(siteId, `Interface "${key}" isn't in this site's interface map.`);
    return l;
  };
  return { ...rule, interfaces: rule.interfaces.map(f), source: mapAddress(rule.source, f), destination: mapAddress(rule.destination, f) };
}

/**
 * Live checks of a site's map against the firewall: every key exists, the
 * label matches what the operator pinned, and kinds agree across sites.
 */
export function interfaceGuards(map: SiteInterfaceMap, live: InterfaceInfo[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const [logical, m] of Object.entries(map)) {
    const iface = live.find((i) => i.key === m.key);
    if (!iface) problems.push(`${logical}: interface "${m.key}" doesn't exist on the firewall.`);
    else if (iface.label.trim() !== m.label.trim()) {
      problems.push(`${logical}: interface "${m.key}" is labelled "${iface.label}" on the firewall, but the topology expects "${m.label}". Refusing to guess.`);
    }
    if (seen.has(m.key)) problems.push(`${logical} and ${seen.get(m.key)} both map to "${m.key}".`);
    seen.set(m.key, logical);
  }
  return problems;
}

/** Kind of each logical interface per site must agree (it decides the rule's priority group). */
export function kindProblems(sites: SiteInput[]): string[] {
  const problems: string[] = [];
  const logicals = Object.keys(sites[0]?.map ?? {});
  for (const l of logicals) {
    const kinds = new Set(sites.map((s) => s.snapshot.options.interfaces.find((i) => i.key === s.map[l]?.key)?.kind ?? "?"));
    if (kinds.size > 1) problems.push(`${l} is an interface at some sites and a group at others; rule order would differ.`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Canonical form and eligibility

function pickExtra(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SHARED_SAFE_EXTRA_FIELDS) if (extra[k] !== undefined && extra[k] !== "") out[k] = extra[k]!;
  return out;
}

/** Comparable form of a shared rule: logical interfaces, no site-local fields. */
export function canonicalRule(rule: FirewallRule): FirewallRule {
  return {
    ...rule,
    id: objectUuid(rule.id),
    categories: [SHARED_CATEGORY_UUID],
    sequence: 0,
    prioGroup: undefined,
    sortOrder: undefined,
    extra: pickExtra(rule.extra),
  };
}

export function canonicalAlias(alias: Alias): Alias {
  return { ...alias, id: objectUuid(alias.id), categories: [SHARED_CATEGORY_UUID], entries: [...alias.entries].sort(), extra: {} };
}

const sameRule = (a: FirewallRule, b: FirewallRule) => ruleFieldChanges(canonicalRule(a), canonicalRule(b)).length === 0;
const sameAlias = (a: Alias, b: Alias) => aliasFieldChanges(canonicalAlias(a), canonicalAlias(b)).length === 0;

/** Why a rule can't be shared (empty = OK). */
export function ruleShareProblems(rule: FirewallRule, sharedAliasNames: ReadonlySet<string>): string[] {
  const p: string[] = [];
  if (rule.origin !== "mvc") p.push("Legacy and automatic rules can't be shared.");
  for (const f of SHARED_FORBIDDEN_FIELDS) {
    if (rule.extra[f] && rule.extra[f] !== "0") p.push(`"${f}" is set; it means something different at each site.`);
  }
  if (rule.extra.nosync === "1") p.push("\"No XMLRPC sync\" is set; shared rules must reach the HA secondary.");
  const aliasNames = [
    ...[...rule.source.items, ...rule.destination.items].flatMap((i) => (i.kind === "alias" ? [i.name] : [])),
    ...[rule.sourcePort, rule.destinationPort].flatMap((x) => (x.kind === "alias" ? [x.name] : [])),
  ];
  for (const n of aliasNames) if (!sharedAliasNames.has(n)) p.push(`Uses alias ${n}, which isn't shared. Share it first.`);
  return p;
}

export function aliasShareProblems(alias: Alias, sharedAliasNames: ReadonlySet<string>, siteAliasNames: ReadonlySet<string>): string[] {
  const p: string[] = [];
  if (!SHARED_ALIAS_TYPES.includes(alias.type)) p.push(`Alias type "${alias.type}" can't be shared (allowed: ${SHARED_ALIAS_TYPES.join(", ")}).`);
  // Entries that name another alias must name a shared one.
  for (const e of alias.entries) if (siteAliasNames.has(e) && !sharedAliasNames.has(e)) p.push(`Contains alias ${e}, which isn't shared. Share it first.`);
  return p;
}

// ---------------------------------------------------------------------------
// Shared view and drift

export type DriftKind = "missing" | "differs" | "unmarked" | "unmappable" | "order_differs" | "guard";

export interface DriftItem {
  kind: DriftKind;
  objectType: "rule" | "alias" | "site";
  uuid?: string;
  label: string;
  /** Per site: a short summary or the field differences against the reference. */
  sites: Record<string, string | FieldChange[]>;
}

export interface SharedView {
  /** Synthetic snapshot of the shared policy (logical interfaces), firewallId "shared". */
  baseline: FirewallSnapshot;
  drift: DriftItem[];
  /** uuid -> site the baseline version was taken from. */
  reference: Record<string, string>;
  /** Sites where shared writes are blocked, with reasons. */
  blockedSites: Record<string, string[]>;
}

export function buildSharedView(sites: SiteInput[]): SharedView {
  const drift: DriftItem[] = [];
  const blockedSites: Record<string, string[]> = {};
  for (const s of sites) {
    const g = interfaceGuards(s.map, s.snapshot.options.interfaces);
    if (g.length) {
      blockedSites[s.siteId] = g;
      drift.push({ kind: "guard", objectType: "site", label: s.siteName, sites: { [s.siteId]: g.join(" ") } });
    }
  }
  for (const k of kindProblems(sites)) drift.push({ kind: "guard", objectType: "site", label: "Interface kinds", sites: Object.fromEntries(sites.map((s) => [s.siteId, k])) });

  // Collect canonical forms per uuid per site.
  const ruleForms = new Map<string, Map<string, FirewallRule | MappingError>>();
  const ruleOrder: string[] = [];
  const aliasForms = new Map<string, Map<string, Alias>>();
  const aliasOrder: string[] = [];
  for (const s of sites) {
    for (const r of s.snapshot.rules) {
      if (r.origin !== "mvc" || !isShared(r)) continue;
      let form: FirewallRule | MappingError;
      try {
        form = canonicalizeRule(r, s.map, s.siteId);
      } catch (err) {
        form = err as MappingError;
      }
      if (!ruleForms.has(r.id)) {
        ruleForms.set(r.id, new Map());
        ruleOrder.push(r.id);
      }
      ruleForms.get(r.id)!.set(s.siteId, form);
    }
    for (const a of s.snapshot.aliases) {
      if (!isShared(a)) continue;
      if (!aliasForms.has(a.id)) {
        aliasForms.set(a.id, new Map());
        aliasOrder.push(a.id);
      }
      aliasForms.get(a.id)!.set(s.siteId, a);
    }
  }

  const reference: Record<string, string> = {};
  const rules: FirewallRule[] = [];
  const aliases: Alias[] = [];
  const fingerprints: Record<string, string> = {};

  for (const uuid of aliasOrder) {
    const forms = aliasForms.get(uuid)!;
    const refSite = sites.find((s) => forms.has(s.siteId))!;
    const ref = forms.get(refSite.siteId)!;
    reference[uuid] = refSite.siteId;
    aliases.push({ ...ref, categories: [SHARED_CATEGORY_UUID], extra: {} });
    fingerprints[uuid] = JSON.stringify(canonicalAlias(ref));
    const perSite: DriftItem["sites"] = {};
    let differs = false;
    let missing = false;
    for (const s of sites) {
      const f = forms.get(s.siteId);
      if (!f) {
        const local = s.snapshot.aliases.find((a) => a.id === uuid);
        perSite[s.siteId] = local ? "present but not marked shared" : "missing";
        missing = true;
      } else if (!sameAlias(f, ref)) {
        perSite[s.siteId] = aliasFieldChanges(canonicalAlias(ref), canonicalAlias(f));
        differs = true;
      }
    }
    if (missing) drift.push({ kind: "missing", objectType: "alias", uuid, label: ref.name, sites: perSite });
    else if (differs) drift.push({ kind: "differs", objectType: "alias", uuid, label: ref.name, sites: perSite });
  }

  for (const uuid of ruleOrder) {
    const forms = ruleForms.get(uuid)!;
    const unmappable = [...forms.entries()].filter(([, f]) => f instanceof MappingError) as [string, MappingError][];
    const refSite = sites.find((s) => {
      const f = forms.get(s.siteId);
      return f && !(f instanceof MappingError);
    });
    if (unmappable.length) {
      drift.push({ kind: "unmappable", objectType: "rule", uuid, label: uuid, sites: Object.fromEntries(unmappable.map(([sid, e]) => [sid, e.message])) });
    }
    if (!refSite) continue;
    const ref = forms.get(refSite.siteId) as FirewallRule;
    reference[uuid] = refSite.siteId;
    rules.push({ ...ref, categories: [SHARED_CATEGORY_UUID], extra: pickExtra(ref.extra), sequence: ref.sequence });
    fingerprints[uuid] = JSON.stringify(canonicalRule(ref));
    const perSite: DriftItem["sites"] = {};
    let differs = false;
    let missing = false;
    for (const s of sites) {
      const f = forms.get(s.siteId);
      if (f instanceof MappingError) continue;
      if (!f) {
        const local = s.snapshot.rules.find((r) => r.id === uuid);
        perSite[s.siteId] = local ? "present but not marked shared" : "missing";
        missing = true;
      } else if (!sameRule(f, ref)) {
        perSite[s.siteId] = ruleFieldChanges(canonicalRule(ref), canonicalRule(f));
        differs = true;
      }
    }
    const label = ref.description || uuid;
    if (missing) drift.push({ kind: "missing", objectType: "rule", uuid, label, sites: perSite });
    else if (differs) drift.push({ kind: "differs", objectType: "rule", uuid, label, sites: perSite });
  }

  // Shared order: reference = first site; compare relative order of shared rules present everywhere.
  const first = sites[0];
  if (first) {
    const orderAt = (s: SiteInput) => s.snapshot.rules.filter((r) => isShared(r) && ruleForms.get(r.id)?.size === sites.length).map((r) => r.id);
    const refOrder = orderAt(first);
    for (const s of sites.slice(1)) {
      if (JSON.stringify(orderAt(s)) !== JSON.stringify(refOrder)) {
        drift.push({ kind: "order_differs", objectType: "rule", label: "Order of shared rules", sites: { [s.siteId]: `differs from ${first.siteName}` } });
      }
    }
    // Baseline order follows the first site where possible.
    const pos = new Map(first.snapshot.rules.map((r, i) => [r.id, i]));
    rules.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
  }

  // Synthetic options: logical interfaces, rest from the first site.
  const logical = Object.keys(first?.map ?? {});
  const interfaces: InterfaceInfo[] = logical.map((l) => ({
    key: l,
    label: l,
    kind: first?.snapshot.options.interfaces.find((i) => i.key === first.map[l]?.key)?.kind ?? "interface",
  }));
  const groupPrio = new Map<string, string>();
  for (const l of logical) if (interfaces.find((i) => i.key === l)?.kind === "group") groupPrio.set(l, "300000");
  for (const r of rules) r.prioGroup = derivePrioGroup(r, interfaces, groupPrio);

  return {
    baseline: {
      firewallId: "shared",
      loadedAt: sites.map((s) => s.snapshot.loadedAt).sort()[0] ?? new Date(0).toISOString(),
      rules,
      aliases,
      options: {
        interfaces,
        aliasTypes: (first?.snapshot.options.aliasTypes ?? []).filter((t) => SHARED_ALIAS_TYPES.includes(t.value)),
        protocols: first?.snapshot.options.protocols ?? [],
        wellKnownPorts: first?.snapshot.options.wellKnownPorts ?? [],
      },
      fingerprints,
    },
    drift,
    reference,
    blockedSites,
  };
}

// ---------------------------------------------------------------------------
// Projection: shared working copy -> per-site working copy

export interface Projection {
  siteId: string;
  wc: WorkingCopy;
  /** Human-readable placement notes ("inserted at top of DMZ"). */
  notes: string[];
  /** Problems that block this site. */
  errors: string[];
}

/** Uuids touched by the shared change set (create/modify/delete/reorder). */
export function touchedUuids(shared: WorkingCopy): Set<string> {
  return new Set(computeChangeSet(shared).changes.map((c) => objectUuid(c.id)));
}

export function projectToSite(site: SiteInput, shared: WorkingCopy): Projection {
  const notes: string[] = [];
  const errors: string[] = [...interfaceGuards(site.map, site.snapshot.options.interfaces)];
  const snap = site.snapshot;
  const touched = touchedUuids(shared);
  const groupPrio = groupPrioMap(snap);
  const markerOf = (cats: string[]) => [...new Set([...cats.filter((c) => c !== SHARED_CATEGORY_UUID), SHARED_CATEGORY_UUID])];

  // ---- aliases
  const desiredAliases = new Map(shared.current.aliases.map((a) => [objectUuid(a.id), a]));
  let aliases = snap.aliases.flatMap((a): Alias[] => {
    if (!touched.has(a.id)) return [a];
    const want = desiredAliases.get(a.id);
    if (!want) return []; // deleted
    return [{ ...a, name: want.name, type: want.type, enabled: want.enabled, entries: want.entries, description: want.description, categories: markerOf(a.categories) }];
  });
  for (const [uuid, a] of desiredAliases) {
    if (!touched.has(uuid) || snap.aliases.some((x) => x.id === uuid)) continue;
    if (snap.aliases.some((x) => x.name === a.name)) errors.push(`An alias named ${a.name} already exists here (not shared).`);
    aliases = [...aliases, { ...a, id: `new:${uuid}`, categories: [SHARED_CATEGORY_UUID], extra: {} }];
  }

  // ---- rules: localize desired shared rules
  const desired: FirewallRule[] = [];
  for (const r of shared.current.rules) {
    const uuid = objectUuid(r.id);
    try {
      const loc = localizeRule(r, site.map, site.siteId);
      const existing = snap.rules.find((x) => x.id === uuid);
      const base = existing ?? { ...loc, extra: {}, categories: [] as string[] };
      const merged: FirewallRule = {
        ...base,
        ...loc,
        id: existing ? uuid : `new:${uuid}`,
        origin: "mvc",
        categories: markerOf(existing?.categories ?? []),
        extra: { ...(existing?.extra ?? {}), ...pickExtra(loc.extra) },
        sequence: existing?.sequence ?? 0,
      };
      merged.prioGroup = derivePrioGroup(merged, snap.options.interfaces, groupPrio);
      desired.push(merged);
    } catch (err) {
      if (err instanceof MappingError) {
        if (touched.has(uuid)) errors.push(`"${r.description || uuid}": ${err.message}`);
      } else throw err;
    }
  }
  const desiredById = new Map(desired.map((r) => [objectUuid(r.id), r]));

  // Which priority groups need re-placement: those that contain a touched rule (before or after).
  const touchedGroups = new Set<string>();
  for (const r of snap.rules) if (touched.has(r.id)) touchedGroups.add(r.prioGroup ?? "");
  for (const r of desired) if (touched.has(objectUuid(r.id))) touchedGroups.add(r.prioGroup ?? "");

  // Walk the site's rules. In touched groups, shared slots are refilled with the
  // desired shared rules (in shared order) that already sit in that group.
  const queues = new Map<string, FirewallRule[]>();
  for (const r of desired) {
    const existing = snap.rules.find((x) => x.id === objectUuid(r.id));
    if (existing && isShared(existing) && (existing.prioGroup ?? "") === (r.prioGroup ?? "")) {
      const q = queues.get(r.prioGroup ?? "") ?? [];
      q.push(r);
      queues.set(r.prioGroup ?? "", q);
    }
  }
  const placed = new Set<string>();
  let rules: FirewallRule[] = [];
  for (const r of snap.rules) {
    const g = r.prioGroup ?? "";
    if (r.origin === "mvc" && isShared(r) && touchedGroups.has(g)) {
      const next = queues.get(g)?.shift();
      if (next) {
        rules.push(touched.has(objectUuid(next.id)) ? next : (snap.rules.find((x) => x.id === objectUuid(next.id)) ?? next));
        placed.add(objectUuid(next.id));
      }
      continue; // a freed slot (deleted or moved away) is dropped
    }
    if (r.origin === "mvc" && isShared(r) && touched.has(r.id)) {
      // Touched shared rule in an untouched group can't happen (its group is touched), kept for safety.
      const d = desiredById.get(r.id);
      if (d) {
        rules.push(d);
        placed.add(r.id);
      }
      continue;
    }
    if (r.origin === "mvc" && isShared(r) && !touched.has(r.id) && !desiredById.has(r.id)) {
      rules.push(r); // shared at this site but not in the shared view (drift); leave alone
      continue;
    }
    rules.push(r);
    if (desiredById.has(r.id)) placed.add(r.id);
  }

  // Insert desired shared rules that aren't placed yet (new here, or moved between groups).
  const order = shared.current.rules.map((r) => objectUuid(r.id));
  for (const uuid of order) {
    if (placed.has(uuid)) continue;
    const r = desiredById.get(uuid);
    if (!r) continue;
    const g = r.prioGroup ?? "";
    // After the nearest preceding shared rule in the same group...
    let idx = -1;
    for (let k = order.indexOf(uuid) - 1; k >= 0 && idx < 0; k--) {
      const prev = order[k]!;
      if (!placed.has(prev)) continue;
      const at = rules.findIndex((x) => objectUuid(x.id) === prev && (x.prioGroup ?? "") === g);
      if (at >= 0) idx = at + 1;
    }
    let note: string;
    if (idx < 0) {
      // ...else at the top of its group, before local rules (so a local catch-all can't shadow it).
      const firstInGroup = rules.findIndex((x) => x.origin === "mvc" && (x.prioGroup ?? "") === g);
      if (firstInGroup >= 0) {
        idx = firstInGroup;
        note = `"${r.description || uuid}" goes to the top of its group, before local rules.`;
      } else {
        idx = rules.findIndex((x) => x.origin === "mvc" && Number(x.prioGroup ?? 0) > Number(g || 0));
        if (idx < 0) idx = rules.length;
        note = `"${r.description || uuid}" is the first rule in its group here.`;
      }
      notes.push(note);
    }
    rules = [...rules.slice(0, idx), r, ...rules.slice(idx)];
    placed.add(uuid);
  }

  const current: WorkingState = { rules, aliases, nextLocalId: 1 };
  return { siteId: site.siteId, wc: { baseline: snap, current, past: [], future: [] }, notes, errors };
}

/** Did a site end up with exactly the shared state we wanted for these uuids? */
export function sharedStateMatches(site: SiteInput, shared: WorkingState, uuids: Iterable<string>): string[] {
  const problems: string[] = [];
  for (const uuid of uuids) {
    const wantRule = shared.rules.find((r) => objectUuid(r.id) === uuid);
    const wantAlias = shared.aliases.find((a) => objectUuid(a.id) === uuid);
    const liveRule = site.snapshot.rules.find((r) => r.id === uuid);
    const liveAlias = site.snapshot.aliases.find((a) => a.id === uuid);
    if (wantRule) {
      if (!liveRule || !isShared(liveRule)) problems.push(`Rule "${wantRule.description}" is missing.`);
      else {
        try {
          if (!sameRule(canonicalizeRule(liveRule, site.map, site.siteId), wantRule)) problems.push(`Rule "${wantRule.description}" differs.`);
        } catch (err) {
          problems.push((err as Error).message);
        }
      }
    } else if (wantAlias) {
      if (!liveAlias || !isShared(liveAlias)) problems.push(`Alias ${wantAlias.name} is missing.`);
      else if (!sameAlias(liveAlias, wantAlias)) problems.push(`Alias ${wantAlias.name} differs.`);
    } else if ((liveRule && isShared(liveRule)) || (liveAlias && isShared(liveAlias))) {
      problems.push(`Object ${uuid} should have been deleted.`);
    }
  }
  return problems;
}

