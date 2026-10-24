import type { AddressItem, AddressSpec, PortSpec } from "./domain.ts";
import { isAddressLiteral, isPortLiteral } from "./validation.ts";

/** What we know about the firewall when classifying raw tokens. */
export interface AddressContext {
  interfaces: ReadonlySet<string>;
  aliases: ReadonlySet<string>;
}

/** Classify a single raw token from source_net/destination_net. */
export function classifyAddressItem(token: string, ctx: AddressContext): AddressItem {
  if (token === "(self)") return { kind: "self" };
  if (isAddressLiteral(token)) return { kind: "literal", value: token };
  if (ctx.aliases.has(token)) return { kind: "alias", name: token };
  if (ctx.interfaces.has(token)) return { kind: "interfaceNet", iface: token };
  if (token.endsWith("ip") && ctx.interfaces.has(token.slice(0, -2))) {
    return { kind: "interfaceAddr", iface: token.slice(0, -2) };
  }
  // Unknown names are treated as alias references; validation flags missing ones.
  return { kind: "alias", name: token };
}

export function parseAddress(raw: string, negate: boolean, ctx: AddressContext): AddressSpec {
  const tokens = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t !== "any");
  return { negate, items: tokens.map((t) => classifyAddressItem(t, ctx)) };
}

export function addressItemToken(item: AddressItem): string {
  switch (item.kind) {
    case "self":
      return "(self)";
    case "interfaceNet":
      return item.iface;
    case "interfaceAddr":
      return `${item.iface}ip`;
    case "alias":
      return item.name;
    case "literal":
      return item.value;
  }
}

export function serializeAddress(spec: AddressSpec): { net: string; not: boolean } {
  if (spec.items.length === 0) return { net: "any", not: spec.negate };
  return { net: spec.items.map(addressItemToken).join(","), not: spec.negate };
}

export function formatAddress(spec: AddressSpec): string {
  const body = spec.items.length === 0 ? "any" : spec.items.map(addressItemToken).join(", ");
  return spec.negate ? `!${body}` : body;
}

export function parsePort(raw: string, aliases: ReadonlySet<string>): PortSpec {
  const v = raw.trim();
  if (v === "" || v === "any") return { kind: "any" };
  if (aliases.has(v)) return { kind: "alias", name: v };
  if (isPortLiteral(v)) return { kind: "literal", value: v };
  return { kind: "alias", name: v };
}

export function serializePort(spec: PortSpec): string {
  switch (spec.kind) {
    case "any":
      return "";
    case "literal":
      return spec.value;
    case "alias":
      return spec.name;
  }
}

export function formatPort(spec: PortSpec): string {
  return spec.kind === "any" ? "any" : serializePort(spec);
}

export function aliasNamesInAddress(spec: AddressSpec): string[] {
  return spec.items.flatMap((i) => (i.kind === "alias" ? [i.name] : []));
}

export function addressEquals(a: AddressSpec, b: AddressSpec): boolean {
  return formatAddress(a) === formatAddress(b);
}

export function portEquals(a: PortSpec, b: PortSpec): boolean {
  return formatPort(a) === formatPort(b);
}
