import {
  flattenModel,
  itemFingerprint,
  unflatten,
  type CertificateInfo,
  type GridDef,
  type Item,
  type ServiceDef,
  type ServiceSnapshot,
} from "@ruledeck/core";
import type { Alias, FirewallLogEntry, HaState, FirewallRule, InterfaceInfo, SelectionOptions } from "@ruledeck/core";
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
  // High availability (CARP). Verified in the 26.7 source and read-only on the lab, see docs/api-compatibility.md
  vipStatus: "diagnostics/interface/get_vip_status",
  carpStatus: "diagnostics/interface/carp_status",
  certSearch: "trust/cert/search",
  caSearch: "trust/ca/search",
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

  // ---------------------------------------------------------------- high availability (CARP)

  /** CARP state of this node: its virtual IPs, demotion, allow flag and maintenance mode. */
  async readHaState(): Promise<HaState> {
    const raw = (await this.http.get(EP.vipStatus)) as { rows?: unknown; carp?: Record<string, unknown> } | null;
    if (!raw || !Array.isArray(raw.rows) || !raw.carp || typeof raw.carp !== "object") {
      throw new OpnsenseError("protocol", `Unexpected response shape from ${EP.vipStatus}: expected rows and a carp section.`, { endpoint: EP.vipStatus });
    }
    const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
    const vips = raw.rows
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map((r) => ({ interface: str(r.interface), vhid: str(r.vhid), subnet: str(r.subnet), status: str(r.status), mode: str(r.mode) }));
    const demotion = Number(str(raw.carp.demotion));
    return {
      vips,
      demotion: Number.isFinite(demotion) ? demotion : 0,
      allow: str(raw.carp.allow) !== "0",
      maintenance: raw.carp.maintenancemode === true || raw.carp.maintenancemode === 1 || raw.carp.maintenancemode === "1",
    };
  }

  /**
   * Toggle CARP maintenance mode. This is a TOGGLE on the firewall, so never call it
   * twice for one switch: read the state first and again afterwards. Returns what the
   * firewall says it did (`enter_maintenance` / `leave_maintenance`).
   */
  async toggleCarpMaintenance(): Promise<"enter_maintenance" | "leave_maintenance"> {
    const raw = (await this.http.post(EP.carpStatus, { params: ["maintenance"] })) as { status?: unknown; action?: unknown } | null;
    if (raw?.status !== "ok" || (raw.action !== "enter_maintenance" && raw.action !== "leave_maintenance")) {
      throw new OpnsenseError("rejected", `The firewall did not confirm the CARP change (answer: ${JSON.stringify(raw)?.slice(0, 120)}).`, { endpoint: EP.carpStatus });
    }
    return raw.action;
  }

  /** True when this node can reach its HA peer over the sync link (it asks the peer for its version). */
  async peerReachable(): Promise<boolean> {
    try {
      const raw = (await this.http.get(EP.haVersion)) as { response?: { firmware?: { version?: unknown } } } | null;
      return typeof raw?.response?.firmware?.version === "string" && raw.response.firmware.version !== "";
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- services (generic OPNsense MVC models)

  private static readonly UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  private static readonly MAX_ROWS = 500;

  private async readRoot(endpoint: string, root: string, params: string[] = []) {
    const raw = (await this.http.get(endpoint, { params })) as Record<string, unknown> | null;
    const node = raw?.[root];
    if (!node || typeof node !== "object") {
      throw new OpnsenseError("protocol", `Unexpected response shape from ${endpoint}: expected "${root}".`, { endpoint });
    }
    return flattenModel(node);
  }

  /** Read a whole service: its settings tree and every table, as flat maps. Secret fields come back empty. */
  async readServiceSnapshot(def: ServiceDef, siteId: string): Promise<ServiceSnapshot> {
    const snap: ServiceSnapshot = {
      serviceId: def.id,
      siteId,
      loadedAt: new Date().toISOString(),
      settings: null,
      grids: {},
      options: {},
      defaults: {},
      secrets: [],
      fingerprints: {},
    };
    const secrets = new Set<string>();
    if (def.settings) {
      const f = await this.readRoot(def.settings.get, def.settings.root);
      snap.settings = f.values;
      snap.fingerprints.settings = itemFingerprint(f.values);
      for (const [k, v] of Object.entries(f.options)) snap.options[`settings:${k}`] = v;
      f.secrets.forEach((x) => secrets.add(x));
    }
    for (const g of def.grids) {
      const rows = (await this.searchAll(g.search)).filter((r) => typeof r.uuid === "string" && OpnsenseClient.UUID.test(r.uuid));
      if (rows.length > OpnsenseClient.MAX_ROWS) {
        throw new OpnsenseError("protocol", `${g.label} has more than ${OpnsenseClient.MAX_ROWS} entries; RuleDeck doesn't load that many.`, { endpoint: g.search });
      }
      const defaults = await this.readRoot(g.get, g.root);
      snap.defaults[g.id] = defaults.values;
      for (const [k, v] of Object.entries(defaults.options)) snap.options[`${g.id}:${k}`] = v;
      defaults.secrets.forEach((x) => secrets.add(x));
      const items: { id: string; item: Item }[] = [];
      for (let i = 0; i < rows.length; i += 8) {
        const batch = await Promise.all(
          rows.slice(i, i + 8).map(async (r) => {
            const id = r.uuid as string;
            const f = await this.readRoot(g.get, g.root, [id]);
            f.secrets.forEach((x) => secrets.add(x));
            for (const [k, v] of Object.entries(f.options)) snap.options[`${g.id}:${k}`] ??= v;
            return { id, item: f.values };
          }),
        );
        items.push(...batch);
      }
      snap.grids[g.id] = items;
      for (const it of items) snap.fingerprints[`${g.id}:${it.id}`] = itemFingerprint(it.item);
    }
    snap.secrets = [...secrets].sort();
    return snap;
  }

  private async saveGeneric(endpoint: string, root: string, patch: Item, params: string[] = []): Promise<string | undefined> {
    const raw = (await this.http.post(endpoint, { params, body: { [root]: unflatten(patch) } })) as { result?: unknown; uuid?: unknown; validations?: unknown } | null;
    if (raw?.result !== "saved") {
      const v = raw?.validations && typeof raw.validations === "object" ? (raw.validations as Record<string, string | string[]>) : undefined;
      const detail = v ? " " + Object.entries(v).map(([k, m]) => `${k}: ${Array.isArray(m) ? m.join(", ") : m}`).join("; ") : "";
      throw new OpnsenseError("rejected", `The firewall did not save the change (${String(raw?.result ?? "no answer")}).${detail}`, { endpoint, validations: v });
    }
    return typeof raw.uuid === "string" ? raw.uuid : undefined;
  }

  async saveServiceSettings(def: ServiceDef, patch: Item): Promise<void> {
    if (!def.settings) throw new OpnsenseError("rejected", `${def.label} has no general settings.`);
    await this.saveGeneric(def.settings.set, def.settings.root, patch);
  }

  async addServiceItem(g: GridDef, patch: Item): Promise<string> {
    const uuid = await this.saveGeneric(g.add, g.root, patch);
    if (!uuid) throw new OpnsenseError("protocol", `${g.add} returned no uuid.`, { endpoint: g.add });
    return uuid;
  }

  async setServiceItem(g: GridDef, uuid: string, patch: Item): Promise<void> {
    await this.saveGeneric(g.set, g.root, patch, [uuid]);
  }

  async deleteServiceItem(g: GridDef, uuid: string): Promise<void> {
    const raw = (await this.http.post(g.del, { params: [uuid] })) as { result?: unknown } | null;
    if (raw?.result !== "deleted") throw new OpnsenseError("rejected", `The firewall did not delete the entry (${String(raw?.result ?? "no answer")}).`, { endpoint: g.del });
  }

  /** Activate the saved configuration of a service. */
  async reconfigureService(def: ServiceDef): Promise<void> {
    if (!def.reconfigure) return;
    const raw = (await this.http.post(def.reconfigure)) as { status?: unknown } | null;
    if (String(raw?.status ?? "").toLowerCase() !== "ok") {
      throw new OpnsenseError("rejected", `The firewall did not activate the change (${String(raw?.status ?? "no answer")}).`, { endpoint: def.reconfigure });
    }
  }

  // ---------------------------------------------------------------- certificates (read-only, whitelisted)

  /**
   * Certificates and CAs for the expiry overview. The firewall's list includes private
   * keys and PEM payloads; only the fields named here are kept, nothing else leaves this method.
   */
  async listCertificates(): Promise<CertificateInfo[]> {
    const iso = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
    };
    const s = (v: unknown, max = 200) => (typeof v === "string" || typeof v === "number" ? String(v).slice(0, max) : "");
    const map = (isCa: boolean) => (r: Record<string, unknown>): CertificateInfo => ({
      uuid: s(r.uuid, 64),
      refid: s(r.refid, 64),
      description: s(r.descr),
      commonName: s(r.commonname),
      subject: s(r.name),
      type: s(r.cert_type, 32),
      validFrom: iso(r.valid_from),
      validTo: iso(r.valid_to),
      inUse: r.in_use === 1 || r.in_use === "1" || r.in_use === true,
      caRef: s(r.caref, 64),
      altNames: [s(r.altnames_dns), s(r.altnames_ip)].flatMap((x) => x.split(/[\n,]+/)).map((x) => x.trim()).filter(Boolean).slice(0, 10),
      isCa,
    });
    const certs = (await this.searchAll(EP.certSearch)).map(map(false));
    const cas = (await this.searchAll(EP.caSearch)).map(map(true));
    return [...certs, ...cas];
  }
}
