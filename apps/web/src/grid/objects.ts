import {
  addressItemToken,
  isAddressLiteral,
  isLocalId,
  isPortLiteral,
  validateAliasName,
  type AddressItem,
  type AddressSpec,
  type Alias,
  type PortSpec,
  type SelectionOptions,
} from "@ruledeck/core";

/** What the pickers know about: interfaces, aliases (incl. pending) and well-known ports. */
export interface ObjectContext {
  options: SelectionOptions;
  aliases: Alias[];
}

export type SuggestionKind = "any" | "self" | "iface" | "ifaceAddr" | "alias" | "literal" | "port" | "create";

export interface Suggestion {
  key: string;
  kind: SuggestionKind;
  label: string;
  detail?: string;
  /** For address pickers. */
  item?: AddressItem | "any";
  /** For port pickers. */
  port?: PortSpec;
  /** For "create alias" entries. */
  createName?: string;
}

export function aliasPreview(a: Alias, max = 3): string {
  const shown = a.entries.slice(0, max).join(", ");
  const more = a.entries.length > max ? ` +${a.entries.length - max}` : "";
  return `${a.type}${a.entries.length ? " · " + shown + more : ""}${isLocalId(a.id) ? " · pending" : ""}`;
}

function ifaces(ctx: ObjectContext) {
  return ctx.options.interfaces.filter((i) => i.kind === "interface" || i.kind === "group");
}

/** Resolve one typed/pasted token to an address item, or null if unknown. */
export function resolveAddressToken(raw: string, ctx: ObjectContext): AddressItem | "any" | null {
  const t = raw.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (lower === "any") return "any";
  if (lower === "(self)" || lower === "self" || lower === "this firewall") return { kind: "self" };
  if (isAddressLiteral(t)) return { kind: "literal", value: t };
  const alias = ctx.aliases.find((a) => a.name === t) ?? ctx.aliases.find((a) => a.name.toLowerCase() === lower);
  if (alias && alias.type !== "port") return { kind: "alias", name: alias.name };
  for (const i of ifaces(ctx)) {
    if (i.key.toLowerCase() === lower || i.label.toLowerCase() === lower || `${i.label} net`.toLowerCase() === lower) {
      return { kind: "interfaceNet", iface: i.key };
    }
    if (`${i.key}ip` === lower || `${i.label} address`.toLowerCase() === lower) return { kind: "interfaceAddr", iface: i.key };
  }
  return null;
}

export function resolvePortToken(raw: string, ctx: ObjectContext): PortSpec | null {
  const t = raw.trim();
  if (!t || t.toLowerCase() === "any") return { kind: "any" };
  const alias = ctx.aliases.find((a) => a.name === t) ?? ctx.aliases.find((a) => a.name.toLowerCase() === t.toLowerCase());
  if (alias && alias.type === "port") return { kind: "alias", name: alias.name };
  const wk = ctx.options.wellKnownPorts.find((p) => p.value.toLowerCase() === t.toLowerCase());
  if (wk) return { kind: "literal", value: wk.value };
  if (isPortLiteral(t, new Set(ctx.options.wellKnownPorts.map((p) => p.value)))) return { kind: "literal", value: t };
  if (/^\d+([-:]\d+)?$/.test(t) && isPortLiteral(t)) return { kind: "literal", value: t };
  return null;
}

export function itemLabel(item: AddressItem, ctx: ObjectContext): string {
  switch (item.kind) {
    case "self":
      return "This Firewall";
    case "interfaceNet":
      return `${ctx.options.interfaces.find((i) => i.key === item.iface)?.label ?? item.iface} net`;
    case "interfaceAddr":
      return `${ctx.options.interfaces.find((i) => i.key === item.iface)?.label ?? item.iface} address`;
    case "alias":
      return item.name;
    case "literal":
      return item.value;
  }
}

function matches(q: string, ...texts: string[]) {
  return texts.some((t) => t.toLowerCase().includes(q));
}

function canCreate(name: string, ctx: ObjectContext) {
  return validateAliasName(name, ctx.aliases.map((a) => a.name)).length === 0;
}

export function addressSuggestions(query: string, ctx: ObjectContext, current: AddressSpec): Suggestion[] {
  const q = query.trim().toLowerCase();
  const chosen = new Set(current.items.map(addressItemToken));
  const out: Suggestion[] = [];
  if (!q || matches(q, "any")) out.push({ key: "any", kind: "any", label: "any", detail: "Any address", item: "any" });
  if (!chosen.has("(self)") && (!q || matches(q, "self", "this firewall"))) {
    out.push({ key: "(self)", kind: "self", label: "This Firewall", detail: "(self)", item: { kind: "self" } });
  }
  const aliasMatches = ctx.aliases
    .filter((a) => a.type !== "port" && !chosen.has(a.name) && (!q || matches(q, a.name, a.description)))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name));
  for (const a of aliasMatches) {
    out.push({ key: `alias:${a.name}`, kind: "alias", label: a.name, detail: aliasPreview(a), item: { kind: "alias", name: a.name } });
  }
  for (const i of ifaces(ctx)) {
    if (!chosen.has(i.key) && (!q || matches(q, i.key, i.label, "net"))) {
      out.push({ key: `if:${i.key}`, kind: "iface", label: `${i.label} net`, detail: `Interface network (${i.key})`, item: { kind: "interfaceNet", iface: i.key } });
    }
    if (!chosen.has(`${i.key}ip`) && (!q || matches(q, `${i.key}ip`, i.label, "address"))) {
      out.push({ key: `ifip:${i.key}`, kind: "ifaceAddr", label: `${i.label} address`, detail: `Interface address (${i.key}ip)`, item: { kind: "interfaceAddr", iface: i.key } });
    }
  }
  if (q && isAddressLiteral(query.trim())) {
    out.unshift({ key: `lit:${q}`, kind: "literal", label: query.trim(), detail: "Address / network", item: { kind: "literal", value: query.trim() } });
  }
  if (q && canCreate(query.trim(), ctx)) {
    out.push({ key: `create:${q}`, kind: "create", label: `Create alias "${query.trim()}"`, detail: "New alias, staged locally", createName: query.trim() });
  } else if (!q) {
    out.push({ key: "create:", kind: "create", label: "Create new alias…", detail: "New alias, staged locally", createName: "" });
  }
  return out;
}

export function portSuggestions(query: string, ctx: ObjectContext): Suggestion[] {
  const q = query.trim().toLowerCase();
  const out: Suggestion[] = [];
  if (!q || matches(q, "any")) out.push({ key: "any", kind: "any", label: "any", detail: "Any port", port: { kind: "any" } });
  for (const a of ctx.aliases.filter((x) => x.type === "port" && (!q || matches(q, x.name, x.description)))) {
    out.push({ key: `alias:${a.name}`, kind: "alias", label: a.name, detail: aliasPreview(a), port: { kind: "alias", name: a.name } });
  }
  for (const p of ctx.options.wellKnownPorts.filter((x) => !q || matches(q, x.value, x.label)).slice(0, 30)) {
    out.push({ key: `wk:${p.value}`, kind: "port", label: p.label, detail: "Well-known port", port: { kind: "literal", value: p.value } });
  }
  const t = query.trim();
  if (t && /^\d+([-:]\d+)?$/.test(t) && isPortLiteral(t)) {
    out.unshift({ key: `lit:${t}`, kind: "literal", label: t, detail: t.match(/[-:]/) ? "Port range" : "Port", port: { kind: "literal", value: t } });
  }
  if (t && canCreate(t, ctx)) {
    out.push({ key: `create:${t}`, kind: "create", label: `Create port alias "${t}"`, detail: "New alias, staged locally", createName: t });
  } else if (!t) {
    out.push({ key: "create:", kind: "create", label: "Create new port alias…", detail: "New alias, staged locally", createName: "" });
  }
  return out;
}
