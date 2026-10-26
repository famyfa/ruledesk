import type { FieldChange } from "./diff.ts";
import { gridById, type GridDef, type ServiceDef } from "./service-catalog.ts";
import { addGridItem, itemLabel, updateGridItem, type Item, type OptionChoice, type ServiceSnapshot, type ServiceWc } from "./service.ts";

/**
 * Copy settings and table entries of a service from one site to another, as staged
 * changes at the target (reviewed and applied there like any other edit).
 *
 *  - entries are matched by the natural key of their table (e.g. host+domain, subnet, name)
 *  - choice fields (interfaces, linked subnets, ...) are translated by label: what is "LAN" at the
 *    source becomes the target's "LAN", whatever its internal id. No match -> the entry is blocked
 *  - secret fields (passwords, keys) are never copied; the target keeps its own
 */

export type ServiceSyncKind = "create" | "update" | "same" | "blocked";

export interface ServiceSyncItem {
  /** `settings` or a grid id. */
  area: string;
  kind: ServiceSyncKind;
  label: string;
  /** Id of the entry at the source (null for settings). */
  sourceId: string | null;
  /** Id of the matching entry at the target. */
  targetId?: string;
  changes: FieldChange[];
  /** Fields (already translated for the target) that will be written. */
  values: Item;
  reasons: string[];
  warnings: string[];
}

export interface ServiceSyncPlan {
  items: ServiceSyncItem[];
  counts: Record<ServiceSyncKind, number>;
}

const norm = (v: string) => v.trim().toLowerCase();

function keyOf(g: GridDef, item: Item): string {
  const parts = g.keyFields.map((f) => norm(item[f] ?? ""));
  return parts.every((p) => p === "") ? "" : parts.join("\u0000");
}

/** Translate the value of a choice field for the target. Returns the value or a reason it can't be done. */
function translate(value: string, from: OptionChoice[] | undefined, to: OptionChoice[] | undefined): { value: string } | { missing: string } {
  if (!to || !value) return { value };
  const out: string[] = [];
  for (const v of value.split(",")) {
    if (v === "" || to.some((o) => o.value === v)) {
      // Same id at both sites: it only counts as the same thing if the label agrees (or there is no label to compare).
      const srcLabel = from?.find((o) => o.value === v)?.label;
      const dstLabel = to.find((o) => o.value === v)?.label;
      if (!srcLabel || !dstLabel || norm(srcLabel) === norm(dstLabel)) {
        out.push(v);
        continue;
      }
    }
    const label = from?.find((o) => o.value === v)?.label;
    const match = label ? to.find((o) => norm(o.label) === norm(label)) : undefined;
    if (!match) return { missing: label || v };
    out.push(match.value);
  }
  return { value: out.join(",") };
}

function translateItem(
  item: Item,
  prefix: string,
  source: ServiceSnapshot,
  target: ServiceSnapshot,
  secrets: ReadonlySet<string>,
): { values: Item; reasons: string[] } {
  const values: Item = {};
  const reasons: string[] = [];
  for (const [field, raw] of Object.entries(item)) {
    if (secrets.has(field)) continue;
    const t = translate(raw, source.options[`${prefix}:${field}`], target.options[`${prefix}:${field}`]);
    if ("missing" in t) reasons.push(`${field}: "${t.missing}" doesn't exist at the target.`);
    else values[field] = t.value;
  }
  return { values, reasons };
}

function diff(before: Item, values: Item): { changes: FieldChange[]; patch: Item } {
  const changes: FieldChange[] = [];
  const patch: Item = {};
  for (const [k, v] of Object.entries(values)) {
    if ((before[k] ?? "") !== v) {
      changes.push({ field: k, label: k, before: before[k] ?? "", after: v });
      patch[k] = v;
    }
  }
  return { changes, patch };
}

export function planServiceSync(
  def: ServiceDef,
  source: ServiceSnapshot,
  target: ServiceWc,
  selection: { settings: boolean; grids: Record<string, string[]> },
): ServiceSyncPlan {
  const items: ServiceSyncItem[] = [];
  const secrets = new Set([...source.secrets, ...target.baseline.secrets]);

  if (selection.settings && source.settings && target.settings) {
    const { values, reasons } = translateItem(source.settings, "settings", source, target.baseline, secrets);
    const { changes } = diff(target.settings, values);
    items.push({
      area: "settings",
      kind: reasons.length ? "blocked" : changes.length ? "update" : "same",
      label: "General settings",
      sourceId: null,
      changes,
      values: Object.fromEntries(changes.map((c) => [c.field, c.after ?? ""])),
      reasons,
      warnings: [],
    });
  }

  for (const [gridId, ids] of Object.entries(selection.grids)) {
    const g = gridById(def, gridId);
    if (!g) continue;
    const targetRows = target.grids[gridId] ?? [];
    const byKey = new Map<string, typeof targetRows>();
    for (const r of targetRows) {
      const k = keyOf(g, r.item);
      if (k) byKey.set(k, [...(byKey.get(k) ?? []), r]);
    }
    for (const row of source.grids[gridId] ?? []) {
      if (!ids.includes(row.id)) continue;
      const label = itemLabel(row.item, g.nameFields, row.id);
      const { values, reasons } = translateItem(row.item, gridId, source, target.baseline, secrets);
      const key = keyOf(g, row.item);
      if (!key) reasons.push(`It has no ${g.keyFields.join(" / ")}, so it can't be matched at the target.`);
      const matches = key ? (byKey.get(key) ?? []) : [];
      if (matches.length > 1) reasons.push(`${matches.length} entries match at the target; can't tell which one to update.`);
      const existing = matches.length === 1 ? matches[0] : undefined;
      let kind: ServiceSyncKind = existing ? "same" : "create";
      let changes: FieldChange[] = [];
      let out: Item = values;
      if (existing) {
        const d = diff(existing.item, values);
        changes = d.changes;
        out = d.patch;
        if (changes.length) kind = "update";
      } else {
        const base = target.baseline.defaults[gridId] ?? {};
        out = { ...base, ...values };
        changes = Object.entries(values).filter(([, v]) => v !== "").map(([field, v]) => ({ field, label: field, after: v }));
      }
      if (reasons.length) kind = "blocked";
      items.push({ area: gridId, kind, label, sourceId: row.id, targetId: existing?.id, changes, values: out, reasons, warnings: [] });
    }
  }

  const counts: Record<ServiceSyncKind, number> = { create: 0, update: 0, same: 0, blocked: 0 };
  for (const i of items) counts[i.kind]++;
  return { items, counts };
}

/** Stage a plan in the target's working copy. Blocked and unchanged items are skipped. */
export function applyServiceSync(wc: ServiceWc, plan: ServiceSyncPlan): ServiceWc {
  let cur = wc;
  for (const item of plan.items) {
    if (item.kind !== "create" && item.kind !== "update") continue;
    if (item.area === "settings") {
      if (cur.settings) cur = { ...cur, settings: { ...cur.settings, ...item.values } };
    } else if (item.kind === "update" && item.targetId) {
      cur = updateGridItem(cur, item.area, item.targetId, item.values);
    } else {
      cur = addGridItem(cur, item.area, item.values).wc;
    }
  }
  return cur;
}
