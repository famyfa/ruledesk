import type { Alias, FirewallRule, InterfaceInfo, SelectionOptions } from "@ruledeck/core";
import { OpnsenseError } from "./errors.ts";
import { OpnsenseHttp, type ConnectionConfig } from "./http.ts";
import {
  FirmwareInfo,
  GetItemResponse,
  InterfaceList,
  NetworkSelectOptions,
  parseOrThrow,
  PortSelectOptions,
  SearchResponse,
} from "./schemas.ts";
import {
  aliasFromRecord,
  ALIAS_VOLATILE,
  fingerprint,
  flattenRecord,
  ruleFromRecord,
  RULE_VOLATILE,
  type FlatRecord,
} from "./adapter.ts";

/** Fixed list of endpoints the client is allowed to call. */
export const EP = {
  firmwareInfo: "core/firmware/info",
  searchRule: "firewall/filter/search_rule",
  getRule: "firewall/filter/get_rule",
  interfaceList: "firewall/filter/get_interface_list",
  networkOptions: "firewall/filter/list_network_select_options",
  portOptions: "firewall/filter/list_port_select_options",
  searchAlias: "firewall/alias/search_item",
  getAlias: "firewall/alias/get_item",
} as const;

const PAGE = 500;

export interface ReadResult {
  rules: FirewallRule[];
  aliases: Alias[];
  options: SelectionOptions;
  fingerprints: Record<string, string>;
}

/**
 * Typed, read-only OPNsense client. Write operations are added in Phase 4
 * once each endpoint has been verified against a live instance.
 */
export class OpnsenseClient {
  readonly http: OpnsenseHttp;

  constructor(cfg: ConnectionConfig) {
    this.http = new OpnsenseHttp(cfg);
  }

  async close() {
    await this.http.close();
  }

  async getVersion(): Promise<string> {
    const info = parseOrThrow(FirmwareInfo, await this.http.get(EP.firmwareInfo), EP.firmwareInfo);
    return info.product_version;
  }

  /** Page through a search endpoint until all rows are read. */
  private async searchAll(endpoint: string, query: Record<string, string> = {}): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (let current = 1; current < 1000; current++) {
      const raw = await this.http.post(endpoint, { query, body: { current, rowCount: PAGE, searchPhrase: "", sort: {} } });
      const page = parseOrThrow(SearchResponse, raw, endpoint);
      rows.push(...page.rows);
      if (page.rows.length < PAGE || rows.length >= page.total) return rows;
    }
    throw new OpnsenseError("protocol", "Too many pages returned.", { endpoint });
  }

  async listRawRules(): Promise<FlatRecord[]> {
    return (await this.searchAll(EP.searchRule)).map((r) => flattenRecord(r));
  }

  async listRawAliases(): Promise<FlatRecord[]> {
    return (await this.searchAll(EP.searchAlias)).map((r) => flattenRecord(r, { content: "\n" }));
  }

  async getInterfaces(): Promise<InterfaceInfo[]> {
    const raw = parseOrThrow(InterfaceList, await this.http.get(EP.interfaceList), EP.interfaceList);
    const out: InterfaceInfo[] = [];
    for (const section of Object.values(raw)) {
      for (const item of section.items) {
        if (item.type === "interface" || item.type === "group") out.push({ key: item.value, label: item.label, kind: item.type });
      }
    }
    return out;
  }

  /** Interface keys that are valid in source/destination fields (from network select options). */
  async getNetworkKeys(): Promise<string[]> {
    const raw = parseOrThrow(NetworkSelectOptions, await this.http.get(EP.networkOptions), EP.networkOptions);
    const items = raw.networks.items;
    return items && !Array.isArray(items) ? Object.keys(items) : [];
  }

  async getWellKnownPorts(): Promise<{ value: string; label: string }[]> {
    try {
      const raw = parseOrThrow(PortSelectOptions, await this.http.get(EP.portOptions), EP.portOptions);
      const items = raw.ports.items;
      if (!items || Array.isArray(items)) return [];
      return Object.entries(items)
        .filter(([k]) => k !== "")
        .map(([value, label]) => ({ value, label }));
    } catch (err) {
      if (err instanceof OpnsenseError && err.kind === "unsupported") return [];
      throw err;
    }
  }

  /** Alias types offered by this firewall (read from the model defaults). */
  async getAliasTypes(): Promise<{ value: string; label: string }[]> {
    const raw = parseOrThrow(GetItemResponse("alias"), await this.http.get(EP.getAlias), EP.getAlias);
    const type = (raw.alias as Record<string, unknown>).type;
    if (!type || typeof type !== "object") return [];
    return Object.entries(type as Record<string, { value: unknown }>).map(([value, o]) => ({ value, label: String(o.value) }));
  }

  /** Protocols offered by this firewall for rules (from get_rule defaults). */
  async getProtocols(): Promise<string[]> {
    const raw = parseOrThrow(GetItemResponse("rule"), await this.http.get(EP.getRule), EP.getRule);
    const proto = (raw.rule as Record<string, unknown>).protocol;
    if (!proto || typeof proto !== "object") return ["any", "TCP", "UDP", "TCP/UDP", "ICMP"];
    return Object.keys(proto);
  }

  /** Read everything RuleDeck needs, normalized to domain objects. */
  async readAll(): Promise<ReadResult> {
    const [rawRules, rawAliases, interfaces, networkKeys, wellKnownPorts, aliasTypes, protocols] = await Promise.all([
      this.listRawRules(),
      this.listRawAliases(),
      this.getInterfaces(),
      this.getNetworkKeys(),
      this.getWellKnownPorts(),
      this.getAliasTypes(),
      this.getProtocols(),
    ]);
    const aliases = rawAliases.map(aliasFromRecord);
    const ifaceKeys = new Set([
      ...interfaces.map((i) => i.key),
      ...networkKeys.filter((k) => k !== "any" && k !== "(self)" && !k.endsWith("ip")),
    ]);
    const ctx = { interfaces: ifaceKeys, aliases: new Set(aliases.map((a) => a.name)) };
    const rules = rawRules.map((r, i) => ruleFromRecord(r, ctx, i));
    const fingerprints: Record<string, string> = {};
    rawRules.forEach((r, i) => (fingerprints[rules[i]!.id] = fingerprint(r, RULE_VOLATILE)));
    rawAliases.forEach((r, i) => (fingerprints[aliases[i]!.id] = fingerprint(r, ALIAS_VOLATILE)));
    return {
      rules,
      aliases,
      options: { interfaces, aliasTypes, protocols, wellKnownPorts },
      fingerprints,
    };
  }
}
