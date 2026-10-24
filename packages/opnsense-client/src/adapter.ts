import { createHash } from "node:crypto";
import type { Alias, FirewallRule, IpProtocol, RuleAction, RuleDirection } from "@ruledeck/core";
import { IP_PROTOCOLS, RULE_ACTIONS, RULE_DIRECTIONS, parseAddress, parsePort, serializeAddress, serializePort, type AddressContext } from "@ruledeck/core";

/**
 * Mapping between OPNsense records and domain objects. See docs/field-mapping.md.
 */

export type FlatRecord = Record<string, string>;

/** Keys that are UI decoration or runtime statistics; never part of config. */
function isDecoration(key: string): boolean {
  return (
    key.startsWith("%") ||
    key.startsWith("alias_meta_") ||
    key === "category_colors" ||
    key === "categories_uuid" ||
    ["evaluations", "states", "packets", "bytes", "pf_rules", "is_alias", "audit"].includes(key)
  );
}

/** Rule fields computed by OPNsense; read but never written. */
export const RULE_VOLATILE = new Set(["sort_order", "prio_group", "uuid", "legacy", "ref", "audit"]);
/** Alias fields that are runtime data, never written. */
export const ALIAS_VOLATILE = new Set([
  "uuid", "current_items", "last_updated", "eval_nomatch", "eval_match",
  "in_block_p", "in_block_b", "in_pass_p", "in_pass_b", "out_block_p", "out_block_b", "out_pass_p", "out_pass_b",
]);

/**
 * Flatten a raw record: option maps `{k: {value, selected}}` become the
 * comma-joined selected keys; decorations are dropped. `listSeparator` is used
 * for multi-select fields (alias content uses newlines).
 */
export function flattenRecord(raw: Record<string, unknown>, listSeparator: Record<string, string> = {}): FlatRecord {
  const out: FlatRecord = {};
  for (const [k, v] of Object.entries(raw)) {
    if (isDecoration(k)) continue;
    const sep = listSeparator[k] ?? ",";
    if (v === null || v === undefined) out[k] = "";
    else if (typeof v === "boolean") out[k] = v ? "1" : "0";
    else if (typeof v === "string" || typeof v === "number") out[k] = String(v);
    else if (Array.isArray(v)) out[k] = v.map(String).join(sep);
    else if (typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>);
      const isOptionMap = entries.every(([, e]) => e && typeof e === "object" && "selected" in (e as object));
      if (isOptionMap) {
        out[k] = entries
          .filter(([, e]) => {
            const s = (e as { selected: unknown }).selected;
            return s === 1 || s === true || s === "1";
          })
          .map(([key]) => key)
          .join(sep);
      }
      // Other nested objects are not config values we understand; skip them.
    }
  }
  return out;
}

const bool = (v: string | undefined) => v === "1" || v === "true";
const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

const MAPPED_RULE_KEYS = new Set([
  "enabled", "action", "quick", "interface", "interfacenot", "direction", "ipprotocol", "protocol",
  "source_net", "source_not", "source_port", "destination_net", "destination_not", "destination_port",
  "description", "log", "categories", "sequence",
]);

export function ruleFromRecord(rec: FlatRecord, ctx: AddressContext, index = 0): FirewallRule {
  const legacy = !rec.uuid || bool(rec.legacy);
  const id = rec.uuid && !legacy ? rec.uuid : `legacy:${rec.ref || rec.uuid || `${index}:${rec.description ?? ""}`}`;
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (!MAPPED_RULE_KEYS.has(k) && !RULE_VOLATILE.has(k)) extra[k] = v;
  }
  const action = (RULE_ACTIONS as readonly string[]).includes(rec.action ?? "") ? (rec.action as RuleAction) : "pass";
  const direction = (RULE_DIRECTIONS as readonly string[]).includes(rec.direction ?? "") ? (rec.direction as RuleDirection) : "in";
  const ipProtocol = (IP_PROTOCOLS as readonly string[]).includes(rec.ipprotocol ?? "") ? (rec.ipprotocol as IpProtocol) : "inet";
  return {
    id,
    origin: legacy ? "legacy" : "mvc",
    enabled: rec.enabled === undefined ? true : bool(rec.enabled),
    action,
    quick: rec.quick === undefined ? true : bool(rec.quick),
    interfaces: list(rec.interface),
    interfaceNot: bool(rec.interfacenot),
    direction,
    ipProtocol,
    protocol: rec.protocol || "any",
    source: parseAddress(rec.source_net ?? "any", bool(rec.source_not), ctx),
    sourcePort: parsePort(rec.source_port ?? "", ctx.aliases),
    destination: parseAddress(rec.destination_net ?? "any", bool(rec.destination_not), ctx),
    destinationPort: parsePort(rec.destination_port ?? "", ctx.aliases),
    description: rec.description ?? "",
    log: bool(rec.log),
    categories: list(rec.categories),
    sequence: Number(rec.sequence ?? 0) || 0,
    prioGroup: rec.prio_group,
    sortOrder: rec.sort_order,
    extra,
  };
}

/** Full writable record for a rule (used for add_rule). Volatile fields excluded. */
export function ruleToRecord(rule: FirewallRule): FlatRecord {
  const src = serializeAddress(rule.source);
  const dst = serializeAddress(rule.destination);
  const rec: FlatRecord = {
    ...Object.fromEntries(Object.entries(rule.extra).filter(([k]) => !RULE_VOLATILE.has(k))),
    enabled: rule.enabled ? "1" : "0",
    action: rule.action,
    quick: rule.quick ? "1" : "0",
    interface: rule.interfaces.join(","),
    interfacenot: rule.interfaceNot ? "1" : "0",
    direction: rule.direction,
    ipprotocol: rule.ipProtocol,
    protocol: rule.protocol,
    source_net: src.net,
    source_not: src.not ? "1" : "0",
    source_port: serializePort(rule.sourcePort),
    destination_net: dst.net,
    destination_not: dst.not ? "1" : "0",
    destination_port: serializePort(rule.destinationPort),
    description: rule.description,
    log: rule.log ? "1" : "0",
    categories: rule.categories.join(","),
  };
  if (rule.sequence > 0) rec.sequence = String(rule.sequence);
  return rec;
}

/**
 * Only the fields that differ between two versions of a rule (used for
 * set_rule). Fields the user didn't touch are never sent, so nothing we don't
 * understand can be overwritten.
 */
export function ruleChangedFields(before: FirewallRule, after: FirewallRule): FlatRecord {
  const a = ruleToRecord(before);
  const b = ruleToRecord(after);
  const out: FlatRecord = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a[k] ?? "") !== (b[k] ?? "")) out[k] = b[k] ?? "";
  }
  return out;
}

const MAPPED_ALIAS_KEYS = new Set(["name", "type", "enabled", "content", "description", "categories"]);

export function aliasFromRecord(rec: FlatRecord): Alias {
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) if (!MAPPED_ALIAS_KEYS.has(k) && !ALIAS_VOLATILE.has(k)) extra[k] = v;
  return {
    id: rec.uuid ?? "",
    name: rec.name ?? "",
    type: rec.type ?? "",
    enabled: rec.enabled === undefined ? true : bool(rec.enabled),
    // search_item returns content comma-joined, get_item newline-joined.
    entries: (rec.content ?? "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
    description: rec.description ?? "",
    categories: list(rec.categories),
    extra,
  };
}

export function aliasToRecord(alias: Alias): FlatRecord {
  return {
    ...Object.fromEntries(Object.entries(alias.extra).filter(([k]) => !ALIAS_VOLATILE.has(k))),
    name: alias.name,
    type: alias.type,
    enabled: alias.enabled ? "1" : "0",
    content: alias.entries.join("\n"),
    description: alias.description,
    categories: alias.categories.join(","),
  };
}

/** Stable hash of a record's config fields, for conflict detection. */
export function fingerprint(rec: FlatRecord, volatile: ReadonlySet<string>): string {
  const keys = Object.keys(rec).filter((k) => !volatile.has(k) && !isDecoration(k)).sort();
  const h = createHash("sha256");
  for (const k of keys) h.update(`${k}\u0000${rec[k]}\u0001`);
  return h.digest("hex").slice(0, 32);
}
