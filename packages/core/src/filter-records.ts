import type { Alias, AddressItem, AddressSpec, FirewallLogEntry, FirewallRule, PortSpec } from "./domain.ts";
import { addressItemToken } from "./address.ts";
import type { FilterRecord } from "./filter.ts";

/** Turn domain objects into per-field value lists for the filter engine. */

const yn = (b: boolean) => (b ? "yes" : "no");

export function logRecord(e: FirewallLogEntry, siteName = ""): FilterRecord {
  return (field) => {
    switch (field) {
      case "addr.src": return [e.src];
      case "addr.dst": return [e.dst];
      case "addr": return [e.src, e.dst];
      case "port.src": return e.srcPort ? [e.srcPort] : [];
      case "port.dst": return e.dstPort ? [e.dstPort] : [];
      case "port": return [e.srcPort, e.dstPort].filter(Boolean);
      case "action": return [e.action];
      case "dir": return [e.dir];
      case "interface": return [e.interface];
      case "proto": return [e.protocol];
      case "rule": return [e.ruleLabel, e.ruleId].filter(Boolean);
      case "site": return siteName ? [siteName] : [];
      default: return undefined;
    }
  };
}

export type AliasIndex = ReadonlyMap<string, Alias>;

export function indexAliases(aliases: readonly Alias[]): AliasIndex {
  return new Map(aliases.map((a) => [a.name, a]));
}

/** An alias's own entries plus those of aliases nested in it (names are included too). */
function expandAlias(name: string, aliases: AliasIndex, seen: Set<string>, out: string[]) {
  if (seen.has(name)) return;
  seen.add(name);
  out.push(name);
  const a = aliases.get(name);
  if (!a) return;
  for (const entry of a.entries) {
    if (aliases.has(entry)) expandAlias(entry, aliases, seen, out);
    else out.push(entry);
  }
}

function addressValues(spec: AddressSpec, aliases: AliasIndex): string[] {
  if (!spec.items.length) return ["any"];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of spec.items as AddressItem[]) {
    if (item.kind === "alias") expandAlias(item.name, aliases, seen, out);
    else out.push(addressItemToken(item));
  }
  return out;
}

function portValues(spec: PortSpec, aliases: AliasIndex): string[] {
  if (spec.kind === "any") return ["any"];
  if (spec.kind === "literal") return [spec.value];
  const out: string[] = [];
  expandAlias(spec.name, aliases, new Set(), out);
  return out;
}

function aliasNamesIn(rule: FirewallRule): string[] {
  const names: string[] = [];
  for (const i of [...rule.source.items, ...rule.destination.items]) if (i.kind === "alias") names.push(i.name);
  for (const p of [rule.sourcePort, rule.destinationPort]) if (p.kind === "alias") names.push(p.name);
  return names;
}

export function ruleRecord(r: FirewallRule, aliases: AliasIndex, siteName = "", categoryNames?: ReadonlyMap<string, string>): FilterRecord {
  const srcA = addressValues(r.source, aliases);
  const dstA = addressValues(r.destination, aliases);
  const srcP = portValues(r.sourcePort, aliases);
  const dstP = portValues(r.destinationPort, aliases);
  return (field) => {
    switch (field) {
      case "addr.src": return srcA;
      case "addr.dst": return dstA;
      case "addr": return [...srcA, ...dstA];
      case "port.src": return srcP;
      case "port.dst": return dstP;
      case "port": return [...srcP, ...dstP];
      case "action": return [r.action];
      case "dir": return [r.direction];
      case "interface": return r.interfaces.length ? r.interfaces : ["any"];
      case "proto": return [r.protocol || "any"];
      case "rule": return [r.description];
      case "alias": return aliasNamesIn(r);
      case "enabled": return [yn(r.enabled)];
      case "log": return [yn(r.log)];
      case "category": return r.categories.map((c) => categoryNames?.get(c) ?? c);
      case "site": return siteName ? [siteName] : [];
      default: return undefined;
    }
  };
}

export function aliasRecord(a: Alias, aliases: AliasIndex, siteName = ""): FilterRecord {
  const expanded: string[] = [];
  for (const entry of a.entries) {
    if (aliases.has(entry)) expandAlias(entry, aliases, new Set([a.name]), expanded);
    else expanded.push(entry);
  }
  return (field) => {
    switch (field) {
      case "name": return [a.name];
      case "type": return [a.type];
      case "addr": return expanded;
      case "port": return expanded;
      case "entry": return a.entries;
      case "enabled": return [yn(a.enabled)];
      case "description": return [a.description];
      case "site": return siteName ? [siteName] : [];
      default: return undefined;
    }
  };
}
