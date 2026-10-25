import type { Alias, FirewallLogEntry, FirewallRule, InterfaceInfo, SelectionOptions } from "@ruledeck/core";
import { OpnsenseError } from "./errors.ts";
import { OpnsenseHttp, type ConnectionConfig } from "./http.ts";
import {
  SaveResponse,
  StatusResponse,
  FirmwareInfo,
  GetItemResponse,
  optionKeys,
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
  logEntryFromRecord,
  ruleFromRecord,
  RULE_VOLATILE,
  uniqueRuleIds,
  type FlatRecord,
} from "./adapter.ts";

/** Fixed list of endpoints the client is allowed to call. */
export const EP = {
  firmwareInfo: "core/firmware/info",
  firmwareStatus: "core/firmware/status",
  searchRule: "firewall/filter/search_rule",
  getRule: "firewall/filter/get_rule",
  interfaceList: "firewall/filter/get_interface_list",
  networkOptions: "firewall/filter/list_network_select_options",
  portOptions: "firewall/filter/list_port_select_options",
  searchAlias: "firewall/alias/search_item",
  getAlias: "firewall/alias/get_item",
  // Writes (verified against 26.1.11 / 26.7.7 source, see docs/api-compatibility.md)
  addRule: "firewall/filter/add_rule",
  setRule: "firewall/filter/set_rule",
  delRule: "firewall/filter/del_rule",
  applyFilter: "firewall/filter/apply",
  addAlias: "firewall/alias/add_item",
  setAlias: "firewall/alias/set_item",
  delAlias: "firewall/alias/del_item",
  reconfigureAliases: "firewall/alias/reconfigure",
  // Multi-site (verified against 26.7.7 source)
  searchCategory: "firewall/category/search_item",
  setCategory: "firewall/category/set_item",
  haGet: "core/hasync/get",
  haVersion: "core/hasync_status/version",
  haRestartAll: "core/hasync_status/restart_all",
  // Monitoring (read-only; verified against 26.7.7 source: Diagnostics FirewallController::logAction)
  firewallLog: "diagnostics/firewall/log",
} as const;

const PAGE = 500;

export interface ReadResult {
  rules: FirewallRule[];
  aliases: Alias[];
  options: SelectionOptions;
  fingerprints: Record<string, string>;
}

/**
 * Typed OPNsense client. Every call goes to a fixed endpoint from `EP`.
 * Write methods send only the fields given; callers decide what changed.
 */
export class OpnsenseClient {
  readonly http: OpnsenseHttp;

  /** The credentials this client signs in with (kept in memory only, never sent to the browser). */
  readonly credentials: ConnectionConfig["auth"];

  constructor(cfg: ConnectionConfig) {
    this.http = new OpnsenseHttp(cfg);
    this.credentials = cfg.auth;
  }

  async close() {
    await this.http.close();
  }

  /** OPNsense version, e.g. "26.7.7". Reads firmware/info, falling back to firmware/status. */
  async getVersion(): Promise<string> {
    const pick = (raw: unknown) => {
      const info = parseOrThrow(FirmwareInfo, raw, EP.firmwareInfo);
      const v = info.product_version ?? info.product?.product_version;
      return v && v !== "unknown" ? v : null;
    };
    const fromInfo = pick(await this.http.get(EP.firmwareInfo));
    if (fromInfo) return fromInfo;
    const fromStatus = pick(await this.http.get(EP.firmwareStatus));
    if (fromStatus) return fromStatus;
    throw new OpnsenseError("protocol", "The firewall didn't report its version.", { endpoint: EP.firmwareInfo });
  }

  /**
   * Prove the credentials work and read the version. OPNsense has no "whoami",
   * so listing one rule is the proof (it needs the rules privilege anyway).
   * The version needs the firmware privilege; without it, `version` is null.
   */
  async probe(): Promise<{ version: string | null }> {
    let version: string | null = null;
    try {
      version = await this.getVersion();
    } catch (err) {
      // No privilege, or an answer we don't understand: sign in anyway, read-only (version unknown).
      if (!(err instanceof OpnsenseError && (err.kind === "forbidden" || err.kind === "protocol" || err.kind === "unsupported"))) throw err;
    }
    await this.http.post(EP.searchRule, { body: { current: 1, rowCount: 1, searchPhrase: "", sort: {} } });
    return { version };
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
    return optionKeys((raw.alias as Record<string, unknown>).type);
  }

  /** Protocols offered by this firewall for rules (from get_rule defaults). */
  async getProtocols(): Promise<string[]> {
    const raw = parseOrThrow(GetItemResponse("rule"), await this.http.get(EP.getRule), EP.getRule);
    const keys = optionKeys((raw.rule as Record<string, unknown>).protocol).map((o) => o.value);
    return keys.length ? keys : ["any", "TCP", "UDP", "TCP/UDP", "ICMP"];
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
    const rules = uniqueRuleIds(rawRules.map((r, i) => ruleFromRecord(r, ctx, i)));
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

  // ------------------------------------------------------------------ writes

  private async save(endpoint: string, key: "rule" | "alias", body: FlatRecord, params: string[] = []): Promise<string | undefined> {
    const res = parseOrThrow(SaveResponse, await this.http.post(endpoint, { params, body: { [key]: body } }), endpoint);
    if (res.result !== "saved") throw new OpnsenseError("rejected", `The firewall did not save the ${key} (result: ${res.result}).`, { endpoint });
    return res.uuid;
  }

  private async remove(endpoint: string, uuid: string): Promise<void> {
    const res = parseOrThrow(SaveResponse, await this.http.post(endpoint, { params: [uuid] }), endpoint);
    if (res.result !== "deleted") throw new OpnsenseError("rejected", `The firewall did not delete the object (result: ${res.result}).`, { endpoint });
  }

  async addRule(fields: FlatRecord): Promise<string> {
    const uuid = await this.save(EP.addRule, "rule", fields);
    if (!uuid) throw new OpnsenseError("protocol", "add_rule returned no uuid.", { endpoint: EP.addRule });
    return uuid;
  }

  async setRule(uuid: string, fields: FlatRecord): Promise<void> {
    await this.save(EP.setRule, "rule", fields, [uuid]);
  }

  async deleteRule(uuid: string): Promise<void> {
    await this.remove(EP.delRule, uuid);
  }

  async addAlias(fields: FlatRecord): Promise<string> {
    const uuid = await this.save(EP.addAlias, "alias", fields);
    if (!uuid) throw new OpnsenseError("protocol", "add_item returned no uuid.", { endpoint: EP.addAlias });
    return uuid;
  }

  async setAlias(uuid: string, fields: FlatRecord): Promise<void> {
    await this.save(EP.setAlias, "alias", fields, [uuid]);
  }

  async deleteAlias(uuid: string): Promise<void> {
    await this.remove(EP.delAlias, uuid);
  }

  /** Reload filter rules. Returns the raw configd status text. */
  async applyFilter(): Promise<string> {
    return parseOrThrow(StatusResponse, await this.http.post(EP.applyFilter), EP.applyFilter).status;
  }

  /** Reload alias tables (needed after alias changes). */
  async reconfigureAliases(): Promise<string> {
    return parseOrThrow(StatusResponse, await this.http.post(EP.reconfigureAliases), EP.reconfigureAliases).status;
  }

  // ------------------------------------------------------------- multi-site

  /**
   * Create-or-update by uuid. set_rule/{uuid} is an upsert in OPNsense
   * (ApiMutableModelControllerBase::setBase), which lets the same rule be
   * pushed to several firewalls under the same uuid.
   */
  async upsertRule(uuid: string, fields: FlatRecord): Promise<void> {
    await this.save(EP.setRule, "rule", fields, [uuid]);
  }

  async upsertAlias(uuid: string, fields: FlatRecord): Promise<void> {
    await this.save(EP.setAlias, "alias", fields, [uuid]);
  }

  async listCategories(): Promise<{ uuid: string; name: string; color: string }[]> {
    const rows = await this.searchAll(EP.searchCategory);
    return rows.map((r) => ({ uuid: String(r.uuid ?? ""), name: String(r.name ?? ""), color: String(r.color ?? "") }));
  }

  async upsertCategory(uuid: string, cat: { name: string; color: string }): Promise<void> {
    const res = parseOrThrow(SaveResponse, await this.http.post(EP.setCategory, { params: [uuid], body: { category: cat } }), EP.setCategory);
    if (res.result !== "saved") throw new OpnsenseError("rejected", `The firewall did not save the category (result: ${res.result}).`, { endpoint: EP.setCategory });
  }

  /** HA settings: a primary has a peer to synchronize to. */
  async getHaSync(): Promise<{ synchronizeToIp: string }> {
    const raw = (await this.http.get(EP.haGet)) as { hasync?: { synchronizetoip?: unknown } };
    return { synchronizeToIp: typeof raw?.hasync?.synchronizetoip === "string" ? raw.hasync.synchronizetoip : "" };
  }

  /**
   * Push the configuration to the HA secondary and reload its services
   * (same as "Synchronize and reconfigure all" in the OPNsense UI).
   */
  async haSyncNow(): Promise<string> {
    const raw = (await this.http.post(EP.haRestartAll)) as { status?: unknown };
    return typeof raw?.status === "string" ? raw.status : "unknown";
  }

  // ---------------------------------------------------------------- monitoring

  /**
   * Read the firewall log, newest first. With `sinceDigest`, only lines newer
   * than that one are returned (the firewall stops at the digest and includes
   * it as the last row, which is cut off here). `missed` is true when the
   * digest wasn't found within `limit` rows, so lines in between may be missing.
   */
  async readFirewallLog(opts: { limit: number; sinceDigest?: string }): Promise<{ entries: FirewallLogEntry[]; missed: boolean }> {
    const query: Record<string, string> = { limit: String(opts.limit) };
    if (opts.sinceDigest) query.digest = opts.sinceDigest;
    const raw = await this.http.get(EP.firewallLog, { query });
    if (!Array.isArray(raw)) {
      throw new OpnsenseError("protocol", `Unexpected response shape from ${EP.firewallLog}: expected a list of log lines.`, { endpoint: EP.firewallLog });
    }
    let entries = raw
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r))
      .map(logEntryFromRecord);
    let missed = false;
    if (opts.sinceDigest) {
      const at = entries.findIndex((e) => e.digest === opts.sinceDigest);
      if (at >= 0) entries = entries.slice(0, at);
      else missed = entries.length >= opts.limit;
    }
    return { entries, missed };
  }
}
