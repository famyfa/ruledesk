import type { FieldChange } from "./diff.ts";
import { gridById, isSecretField, type ServiceDef } from "./service-catalog.ts";
import { shortHash } from "./shared.ts";

/**
 * Generic model for OPNsense services (DHCP, DNS, gateways, ...): every setting
 * tree and every table row is a flat map of field name -> string. Option fields
 * (drop-downs) are flattened to their selected keys, joined by comma, which is also
 * what OPNsense accepts when saving. Secret fields never leave the server.
 */

export type Item = Record<string, string>;
export interface OptionChoice {
  value: string;
  label: string;
}
export interface GridRow {
  id: string;
  item: Item;
}

export interface ServiceSnapshot {
  serviceId: string;
  siteId: string;
  loadedAt: string;
  settings: Item | null;
  grids: Record<string, GridRow[]>;
  /** Choices per field: `settings:<path>` or `<gridId>:<field>`. */
  options: Record<string, OptionChoice[]>;
  /** Field values of a new item per table (the firewall's defaults). */
  defaults: Record<string, Item>;
  /** Fields the firewall holds secrets in (write-only here). */
  secrets: string[];
  /** id -> fingerprint of the item at load time (`settings` for the settings tree). */
  fingerprints: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Flattening of raw OPNsense JSON

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function isOptionMap(v: Record<string, unknown>): boolean {
  const vals = Object.values(v);
  return vals.length > 0 && vals.every((x) => isObj(x) && "value" in x && "selected" in x);
}

const isSelected = (s: unknown) => s === 1 || s === "1" || s === true;

export interface Flattened {
  values: Item;
  options: Record<string, OptionChoice[]>;
  secrets: string[];
}

/** Flatten one `{root: {...}}` payload (or the inside of it). Table-like children (uuid keys) are skipped. */
export function flattenModel(node: unknown, prefix = ""): Flattened {
  const out: Flattened = { values: {}, options: {}, secrets: [] };
  const walk = (n: unknown, path: string) => {
    if (n === null || n === undefined) {
      if (path) out.values[path] = "";
      return;
    }
    if (Array.isArray(n)) {
      if (path) out.values[path] = "";
      return;
    }
    if (isObj(n)) {
      const keys = Object.keys(n);
      if (path && isOptionMap(n)) {
        out.options[path] = keys.map((k) => ({ value: k, label: String((n[k] as { value: unknown }).value ?? k) }));
        out.values[path] = keys.filter((k) => isSelected((n[k] as { selected: unknown }).selected)).join(",");
        if (isSecretField(path)) {
          out.values[path] = "";
          out.secrets.push(path);
        }
        return;
      }
      if (keys.length > 0 && keys.every((k) => UUID_RE.test(k))) return; // a table inside the tree
      for (const k of keys) {
        if (FORBIDDEN_KEYS.has(k)) continue; // never let a firewall answer reach a prototype
        walk(n[k], path ? `${path}.${k}` : k);
      }
      return;
    }
    if (isSecretField(path)) {
      out.values[path] = "";
      out.secrets.push(path);
      return;
    }
    out.values[path] = String(n);
  };
  walk(node, prefix);
  return out;
}

/**
 * Keys that would reach an object's prototype. Field names come from the browser and from
 * firewalls, so they are refused (prototype pollution).
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** True when no segment of a dotted field path is a prototype key. */
export function isSafeFieldPath(path: string): boolean {
  return path.split(".").every((p) => !FORBIDDEN_KEYS.has(p));
}

/** `{ "general.enabled": "1" }` -> `{ general: { enabled: "1" } }` */
export function unflatten(item: Item): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(item)) {
    if (!isSafeFieldPath(path)) throw new Error(`Field name not allowed: ${path.slice(0, 100)}`);
    const parts = path.split(".");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]!;
      if (!Object.hasOwn(cur, p) || !isObj(cur[p])) cur[p] = {};
      cur = cur[p] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]!] = value;
  }
  return root;
}

export function itemFingerprint(item: Item): string {
  const keys = Object.keys(item).sort();
  return shortHash(JSON.stringify(keys.map((k) => [k, item[k]])));
}

// ---------------------------------------------------------------------------
// Working copy

export interface ServiceWc {
  baseline: ServiceSnapshot;
  settings: Item | null;
  grids: Record<string, GridRow[]>;
}

export function createServiceWc(snapshot: ServiceSnapshot): ServiceWc {
  return { baseline: snapshot, settings: snapshot.settings, grids: snapshot.grids };
}

export function setSetting(wc: ServiceWc, key: string, value: string): ServiceWc {
  if (!wc.settings) return wc;
  return { ...wc, settings: { ...wc.settings, [key]: value } };
}

export function updateGridItem(wc: ServiceWc, gridId: string, id: string, patch: Item): ServiceWc {
  return { ...wc, grids: { ...wc.grids, [gridId]: (wc.grids[gridId] ?? []).map((r) => (r.id === id ? { id, item: { ...r.item, ...patch } } : r)) } };
}

export function newServiceItemId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return `new:${c?.randomUUID ? c.randomUUID() : Math.random().toString(16).slice(2) + Date.now().toString(16)}`;
}

export function addGridItem(wc: ServiceWc, gridId: string, item: Item): { wc: ServiceWc; id: string } {
  const id = newServiceItemId();
  return { id, wc: { ...wc, grids: { ...wc.grids, [gridId]: [...(wc.grids[gridId] ?? []), { id, item }] } } };
}

export function deleteGridItem(wc: ServiceWc, gridId: string, id: string): ServiceWc {
  return { ...wc, grids: { ...wc.grids, [gridId]: (wc.grids[gridId] ?? []).filter((r) => r.id !== id) } };
}

export function discardService(wc: ServiceWc): ServiceWc {
  return createServiceWc(wc.baseline);
}

export const isNewId = (id: string) => id.startsWith("new:");

// ---------------------------------------------------------------------------
// Change set

export interface ServiceChange {
  /** `settings` or a grid id. */
  area: string;
  kind: "create" | "modify" | "delete";
  id: string;
  label: string;
  fields: FieldChange[];
  /** What is sent to the firewall: changed fields (modify) or all non-empty fields (create). Contains secrets, never log it. */
  patch: Item;
}

const MASK = "••••••";

export function itemLabel(item: Item, nameFields: string[], fallback: string): string {
  const parts = nameFields.map((f) => item[f]).filter((v): v is string => !!v);
  return parts.length ? parts.join(" ") : fallback;
}

function diffItems(before: Item, after: Item, secrets: ReadonlySet<string>): { fields: FieldChange[]; patch: Item } {
  const fields: FieldChange[] = [];
  const patch: Item = {};
  for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = before[k] ?? "";
    const b = after[k] ?? "";
    if (a === b) continue;
    patch[k] = b;
    const secret = secrets.has(k);
    fields.push({ field: k, label: k, before: secret ? "" : a, after: secret ? (b ? MASK : "") : b });
  }
  return { fields, patch };
}

export function computeServiceChanges(def: ServiceDef, wc: ServiceWc): ServiceChange[] {
  const secrets = new Set(wc.baseline.secrets);
  const out: ServiceChange[] = [];
  if (wc.baseline.settings && wc.settings) {
    const d = diffItems(wc.baseline.settings, wc.settings, secrets);
    if (d.fields.length) out.push({ area: "settings", kind: "modify", id: "settings", label: "General settings", ...d });
  }
  for (const g of def.grids) {
    const base = new Map((wc.baseline.grids[g.id] ?? []).map((r) => [r.id, r.item]));
    const cur = wc.grids[g.id] ?? [];
    for (const r of cur) {
      const b = base.get(r.id);
      if (!b) {
        const patch = Object.fromEntries(Object.entries(r.item).filter(([, v]) => v !== ""));
        out.push({
          area: g.id,
          kind: "create",
          id: r.id,
          label: itemLabel(r.item, g.nameFields, "new"),
          fields: Object.entries(patch).map(([field, v]) => ({ field, label: field, after: secrets.has(field) ? MASK : v })),
          patch,
        });
      } else {
        const d = diffItems(b, r.item, secrets);
        if (d.fields.length) out.push({ area: g.id, kind: "modify", id: r.id, label: itemLabel(r.item, g.nameFields, r.id), ...d });
      }
    }
    const curIds = new Set(cur.map((r) => r.id));
    for (const [id, item] of base) {
      if (!curIds.has(id)) out.push({ area: g.id, kind: "delete", id, label: itemLabel(item, g.nameFields, id), fields: [], patch: {} });
    }
  }
  return out;
}

/** Redacted copy for logs and API answers: secrets removed. */
export function redactChange(c: ServiceChange): Omit<ServiceChange, "patch"> {
  const { patch: _patch, ...rest } = c;
  return rest;
}

export function describeGrid(def: ServiceDef, gridId: string): string {
  return gridById(def, gridId)?.label ?? gridId;
}

// ---------------------------------------------------------------------------
// Certificates: a strict whitelist. The firewall's list includes private keys; they never get here.

export interface CertificateInfo {
  uuid: string;
  refid: string;
  description: string;
  commonName: string;
  subject: string;
  type: string;
  /** ISO dates. */
  validFrom: string | null;
  validTo: string | null;
  inUse: boolean;
  caRef: string;
  altNames: string[];
  isCa: boolean;
}

export type CertStatus = "expired" | "expiring" | "ok" | "unknown";

/** `expiring` = valid for less than `warnDays` more days. */
export function certStatus(c: Pick<CertificateInfo, "validTo">, now = Date.now(), warnDays = 30): CertStatus {
  if (!c.validTo) return "unknown";
  const t = Date.parse(c.validTo);
  if (Number.isNaN(t)) return "unknown";
  if (t < now) return "expired";
  return t - now < warnDays * 86_400_000 ? "expiring" : "ok";
}

export function daysLeft(c: Pick<CertificateInfo, "validTo">, now = Date.now()): number | null {
  const t = c.validTo ? Date.parse(c.validTo) : NaN;
  return Number.isNaN(t) ? null : Math.floor((t - now) / 86_400_000);
}
