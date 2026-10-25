import { createHash, randomUUID } from "node:crypto";
import { isAddressLiteral, isPortLiteral, validateAliasEntries, validateAliasName } from "@ruledeck/core";

/**
 * In-memory OPNsense-like state. Field names and value formats follow the
 * 26.7 Filter.xml / Alias.xml models (see docs/api-compatibility.md).
 */

export type RawRecord = Record<string, string>;

export interface MockInterface {
  key: string;
  descr: string;
  type?: "group";
  virtual?: boolean;
}

export const RULE_DEFAULTS: RawRecord = {
  enabled: "1",
  statetype: "keep",
  "state-policy": "",
  sequence: "1",
  action: "pass",
  quick: "1",
  interfacenot: "0",
  interface: "",
  "received-on-not": "0",
  "received-on": "",
  direction: "in",
  ipprotocol: "inet",
  protocol: "any",
  icmptype: "",
  source_net: "any",
  source_not: "0",
  source_port: "",
  destination_net: "any",
  destination_not: "0",
  destination_port: "",
  gateway: "",
  disablereplyto: "0",
  log: "0",
  allowopts: "0",
  nosync: "0",
  nopfsync: "0",
  statetimeout: "",
  max: "",
  tag: "",
  tagged: "",
  categories: "",
  sched: "",
  description: "",
};

export const OPTION_FIELDS: Record<string, Record<string, string>> = {
  action: { pass: "Pass", block: "Block", reject: "Reject", match: "Match" },
  direction: { in: "In", out: "Out", any: "Any" },
  ipprotocol: { inet: "IPv4", inet6: "IPv6", inet46: "IPv4+IPv6" },
  statetype: { keep: "Keep", sloppy: "Sloppy", modulate: "Modulate", synproxy: "Synproxy", none: "None" },
  protocol: { any: "any", TCP: "TCP", UDP: "UDP", "TCP/UDP": "TCP/UDP", ICMP: "ICMP", IPV6: "IPV6", "IPV6-ICMP": "IPV6-ICMP", ESP: "ESP", AH: "AH", GRE: "GRE" },
};

export const ALIAS_TYPES: Record<string, string> = {
  host: "Host(s)",
  network: "Network(s)",
  port: "Port(s)",
  url: "URL (IPs)",
  urltable: "URL Table (IPs)",
  urljson: "URL Table in JSON format (IPs)",
  geoip: "GeoIP",
  networkgroup: "Network group",
  mac: "MAC address",
  asn: "BGP ASN",
  dynipv6host: "Dynamic IPv6 Host",
  authgroup: "OpenVPN group",
  internal: "Internal (automatic)",
  external: "External (advanced)",
};

export const ALIAS_DEFAULTS: RawRecord = {
  enabled: "1",
  name: "",
  type: "host",
  proto: "",
  interface: "",
  counters: "0",
  updatefreq: "",
  content: "",
  categories: "",
  description: "",
};

export const WELL_KNOWN_PORTS: Record<string, number> = {
  ftp: 21, ssh: 22, telnet: 23, smtp: 25, domain: 53, http: 80, pop3: 110, ntp: 123, imap: 143,
  snmp: 161, ldap: 389, https: 443, smtps: 465, submission: 587, imaps: 993, pop3s: 995,
  "ms-sql-s": 1433, openvpn: 1194, mysql: 3306, rdp: 3389, postgresql: 5432,
};

export class MockValidationError extends Error {
  constructor(public readonly validations: Record<string, string>) {
    super("validation failed");
  }
}

export class MockUserError extends Error {
  constructor(message: string, public readonly title: string) {
    super(message);
  }
}

export interface MockStateOptions {
  version?: string;
  /** Interface key of the DMZ at this site (sites differ: opt1, opt2, ...). */
  dmzKey?: string;
  /** Replaces the first 8 hex digits of seed uuids, so different sites don't share uuids. */
  uuidSalt?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MockCategory {
  name: string;
  color: string;
}

export class MockState {
  version: string;
  interfaces: MockInterface[];
  rules = new Map<string, RawRecord>();
  aliases = new Map<string, RawRecord>();
  categories = new Map<string, MockCategory>();
  /** Firewall log, newest first. Each row has the fields of the real filterlog parser. */
  logRows: RawRecord[] = [];
  private logCounter = 0;
  dmzKey: string;
  private salt?: string;
  legacyRules: RawRecord[] = [];
  /** True after a write and before filter/apply. */
  pendingApply = false;
  aliasPendingReconfigure = false;
  applyCount = 0;

  constructor(opts: MockStateOptions = {}) {
    this.version = opts.version ?? "26.7.7";
    this.dmzKey = opts.dmzKey ?? "opt1";
    this.salt = opts.uuidSalt;
    this.interfaces = [
      { key: "lan", descr: "LAN" },
      { key: "wan", descr: "WAN" },
      { key: this.dmzKey, descr: "DMZ" },
      { key: "lo0", descr: "Loopback", virtual: true },
    ];
    if (this.dmzKey !== "opt1") this.interfaces.splice(2, 0, { key: "opt1", descr: "GUEST" });
    this.seed();
    this.seedLog();
  }

  /** Add a log line for the given rule (or none). Newest first, like the firewall returns them. */
  addLog(partial: RawRecord = {}, at = new Date()): RawRecord {
    this.logCounter++;
    const n = this.logCounter;
    const row: RawRecord = {
      rulenr: "1",
      subrulenr: "",
      anchorname: "",
      rid: "0",
      interface: "vtnet0",
      reason: "match",
      action: "pass",
      dir: "in",
      ipversion: "4",
      protonum: "6",
      protoname: "tcp",
      length: "60",
      src: `192.168.1.${10 + (n % 200)}`,
      dst: "10.0.0.5",
      srcport: String(40000 + n),
      dstport: "443",
      tcpflags: "S",
      label: "",
      ...partial,
    };
    row.__timestamp__ = at.toISOString().slice(0, 19);
    row.__host__ = "mock-fw";
    row.__digest__ = createHash("md5").update(`${row.__timestamp__}|${n}|${row.src}|${row.dst}|${row.dstport}`).digest("hex");
    this.logRows.unshift(row);
    return row;
  }

  private seedLog() {
    const rules = [...this.rules.entries()];
    const now = Date.now();
    for (let i = 0; i < 30; i++) {
      const [uuid, rule] = rules[(29 - i) % rules.length]!;
      this.addLog(
        {
          rid: uuid,
          label: rule.description ?? "",
          action: rule.action === "block" ? "block" : "pass",
          interface: rule.interface === this.dmzKey ? "vtnet2" : rule.interface === "wan" ? "vtnet1" : "vtnet0",
          dstport: rule.destination_port && /^\d+$/.test(rule.destination_port) ? rule.destination_port : String([443, 80, 53, 22][i % 4]),
        },
        new Date(now - (30 - i) * 15_000),
      );
    }
  }

  private id(u: string) {
    return this.salt ? this.salt + u.slice(8) : u;
  }

  private seed() {
    this.addAliasRaw(this.id("8b1b7ae5-6c35-4b8e-9b55-3d2b6b2a0001"), {
      name: "RFC1918",
      type: "network",
      content: "10.0.0.0/8\n172.16.0.0/12\n192.168.0.0/16",
      description: "Private networks",
    });
    this.addAliasRaw(this.id("8b1b7ae5-6c35-4b8e-9b55-3d2b6b2a0002"), {
      name: "WEB_PORTS",
      type: "port",
      content: "80\n443",
      description: "HTTP and HTTPS",
    });
    this.addAliasRaw(this.id("8b1b7ae5-6c35-4b8e-9b55-3d2b6b2a0003"), {
      name: "ADMIN_HOSTS",
      type: "host",
      content: "192.168.1.5\n192.168.1.6",
      description: "Admin workstations",
    });

    const seed: [string, RawRecord][] = [
      ["0c6f0f84-1b2a-4c1e-8f0e-000000000001", { sequence: "10", interface: "", action: "block", quick: "1", direction: "in", ipprotocol: "inet46", source_net: "RFC1918", description: "Floating: block private sources", interfacenot: "0", log: "1" }],
      ["0c6f0f84-1b2a-4c1e-8f0e-000000000002", { sequence: "100", interface: "lan", protocol: "TCP", source_net: "ADMIN_HOSTS", destination_net: "(self)", destination_port: "443", description: "Admin access to firewall GUI" }],
      ["0c6f0f84-1b2a-4c1e-8f0e-000000000003", { sequence: "200", interface: "lan", source_net: "lan", description: "Default allow LAN to any" }],
      ["0c6f0f84-1b2a-4c1e-8f0e-000000000004", { sequence: "300", interface: "lan", ipprotocol: "inet6", source_net: "lan", description: "Default allow LAN IPv6 to any" }],
      ["0c6f0f84-1b2a-4c1e-8f0e-000000000005", { sequence: "400", interface: "opt1", protocol: "TCP", destination_net: "opt1", destination_port: "WEB_PORTS", description: "Allow web to DMZ", log: "1" }],
      ["0c6f0f84-1b2a-4c1e-8f0e-000000000006", { sequence: "500", interface: "opt1", action: "block", destination_net: "lan", description: "Block DMZ to LAN" }],
      ["0c6f0f84-1b2a-4c1e-8f0e-000000000007", { sequence: "600", interface: "wan", enabled: "0", protocol: "TCP", destination_net: "wanip", destination_port: "22", description: "SSH from WAN (disabled)" }],
    ];
    for (const [uuid, rec] of seed) {
      const r = { ...RULE_DEFAULTS, ...rec };
      for (const f of ["interface", "source_net", "destination_net"]) if (r[f] === "opt1") r[f] = this.dmzKey;
      this.rules.set(this.id(uuid), r);
    }

    this.legacyRules = [
      {
        legacy: "1",
        enabled: "1",
        action: "pass",
        interface: "lan",
        direction: "in",
        ipprotocol: "inet",
        protocol: "any",
        source_net: "any",
        destination_net: "any",
        description: "Anti-Lockout Rule",
        sort_order: "400000.1000000",
        prio_group: "400000",
        ref: "anti-lockout",
      },
    ];
  }

  private addAliasRaw(uuid: string, rec: RawRecord) {
    this.aliases.set(uuid, { ...ALIAS_DEFAULTS, ...rec });
  }

  // -------------------------------------------------------------------------

  private ifaceExists(key: string) {
    return this.interfaces.some((i) => i.key === key);
  }

  priority(rec: RawRecord): number {
    const ifs = rec.interface ? rec.interface.split(",").filter(Boolean) : [];
    if (ifs.length && !ifs.some((i) => this.ifaceExists(i))) return 600000;
    if (ifs.length !== 1 || rec.interfacenot === "1") return 200000;
    const iface = this.interfaces.find((i) => i.key === ifs[0]);
    if (iface?.type === "group") return 300000;
    return 400000;
  }

  /** Rule with volatile fields filled in. */
  decorate(uuid: string, rec: RawRecord): RawRecord {
    const prio = this.priority(rec);
    return {
      uuid,
      ...rec,
      sort_order: `${prio}.0${String(rec.sequence).padStart(6, "0")}`,
      prio_group: String(prio),
    };
  }

  allRulesSorted(): RawRecord[] {
    const rows = [...this.rules.entries()].map(([u, r]) => this.decorate(u, r));
    rows.push(...this.legacyRules);
    return rows.sort((a, b) => (a.sort_order ?? "").localeCompare(b.sort_order ?? "", undefined, { numeric: true }));
  }

  aliasNames(): Set<string> {
    return new Set([...this.aliases.values()].map((a) => a.name!));
  }

  private aliasByName(name: string): RawRecord | undefined {
    return [...this.aliases.values()].find((a) => a.name === name);
  }

  // -------------------------------------------------------------------------
  // Rules

  validateRule(rec: RawRecord): Record<string, string> {
    const v: Record<string, string> = {};
    for (const [field, opts] of Object.entries(OPTION_FIELDS)) {
      if (rec[field] !== undefined && !(rec[field]! in opts)) v[`rule.${field}`] = "Option not in list.";
    }
    for (const i of (rec.interface ?? "").split(",").filter(Boolean)) {
      if (!this.ifaceExists(i) || i === "lo0") v["rule.interface"] = `Option ${i} not in list.`;
    }
    for (const f of ["source_net", "destination_net"]) {
      for (const t of (rec[f] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
        if (t === "any" || t === "(self)" || isAddressLiteral(t)) continue;
        if (this.ifaceExists(t) || (t.endsWith("ip") && this.ifaceExists(t.slice(0, -2)))) continue;
        const a = this.aliasByName(t);
        if (a && a.type !== "port") continue;
        v[`rule.${f}`] = `${t} is not a valid source IP address or alias.`;
      }
    }
    for (const f of ["source_port", "destination_port"]) {
      const p = rec[f] ?? "";
      if (p === "") continue;
      if (isPortLiteral(p, new Set(Object.keys(WELL_KNOWN_PORTS)))) continue;
      const a = this.aliasByName(p);
      if (a && a.type === "port") continue;
      v[`rule.${f}`] = "Please specify a valid port number, range or alias.";
    }
    if ((rec.source_port || rec.destination_port) && !["TCP", "UDP", "TCP/UDP"].includes(rec.protocol ?? "")) {
      v["rule.protocol"] = "Ports can only be used with TCP and/or UDP.";
    }
    if ((rec.description ?? "").length > 255) v["rule.description"] = "Description too long.";
    for (const c of (rec.categories ?? "").split(",").filter(Boolean)) {
      if (!this.categories.has(c)) v["rule.categories"] = "Related category not found.";
    }
    const seq = Number(rec.sequence);
    if (!Number.isInteger(seq) || seq < 1 || seq > 999999) v["rule.sequence"] = "Provide a valid sequence for sorting";
    return v;
  }

  private stripVolatile(input: RawRecord): RawRecord {
    const out: RawRecord = {};
    for (const [k, val] of Object.entries(input)) {
      if (k === "uuid" || k === "sort_order" || k === "prio_group" || k.startsWith("%")) continue;
      if (k in RULE_DEFAULTS) out[k] = String(val);
    }
    return out;
  }

  addRule(input: RawRecord): string {
    const rec = { ...RULE_DEFAULTS, ...this.stripVolatile(input) };
    const errs = this.validateRule(rec);
    if (Object.keys(errs).length) throw new MockValidationError(errs);
    const uuid = randomUUID();
    this.rules.set(uuid, rec);
    this.pendingApply = true;
    return uuid;
  }

  /** set_rule is an upsert: an unknown but valid uuid creates the rule (ApiMutableModelControllerBase::setBase). */
  setRule(uuid: string, input: RawRecord) {
    const existing = this.rules.get(uuid);
    if (!existing && !UUID_RE.test(uuid)) throw new MockUserError("invalid uuid, upsert not allowed", "Filter");
    const cur = existing ?? { ...RULE_DEFAULTS };
    const rec = { ...cur, ...this.stripVolatile(input) };
    const errs = this.validateRule(rec);
    if (Object.keys(errs).length) throw new MockValidationError(errs);
    this.rules.set(uuid, rec);
    this.pendingApply = true;
  }

  delRule(uuid: string): boolean {
    const ok = this.rules.delete(uuid);
    if (ok) this.pendingApply = true;
    return ok;
  }

  toggleRule(uuid: string, enabled?: string) {
    const r = this.rules.get(uuid);
    if (!r) return false;
    r.enabled = enabled === undefined ? (r.enabled === "1" ? "0" : "1") : enabled === "1" ? "1" : "0";
    this.pendingApply = true;
    return true;
  }

  /** Mirrors FilterController::moveRuleBeforeAction (26.7). */
  moveRuleBefore(selected: string, target: string) {
    const sel = this.rules.get(selected);
    const tgt = this.rules.get(target);
    if (!sel || !tgt) throw new MockUserError("Either source or destination is not a rule managed with this component", "Filter");
    if (this.priority(sel) !== this.priority(tgt)) throw new MockUserError("Cannot move rules across groups.", "Filter");
    if (selected === target) throw new MockUserError("Cannot move to the same spot.", "Filter");
    const group = [...this.rules.entries()]
      .filter(([, r]) => this.priority(r) === this.priority(tgt))
      .sort(([, a], [, b]) => Number(a.sequence) - Number(b.sequence));
    const step = 50;
    let newKey: number | null = null;
    let prev: RawRecord | null = null;
    for (const [uuid, rec] of group) {
      if (uuid === target) {
        const prevSeq = prev ? Number(prev.sequence) : 1;
        const distance = Number(rec.sequence) - prevSeq;
        if (distance > 2) {
          newKey = Math.floor(distance / 2) + prevSeq;
          break;
        }
        newKey = prev === null ? 1 : prevSeq + step;
        rec.sequence = String(newKey + step);
      } else if (newKey !== null && prev && Number(rec.sequence) < Number(prev.sequence)) {
        rec.sequence = String(Number(prev.sequence) + step);
      }
      prev = rec;
    }
    if (newKey !== null) {
      sel.sequence = String(newKey);
      this.pendingApply = true;
    }
  }

  apply() {
    this.pendingApply = false;
    this.applyCount++;
  }

  // -------------------------------------------------------------------------
  // Aliases

  validateAlias(rec: RawRecord, ownUuid?: string): Record<string, string> {
    const v: Record<string, string> = {};
    const others = [...this.aliases.entries()].filter(([u]) => u !== ownUuid).map(([, a]) => a.name!);
    const nameIssues = validateAliasName(rec.name ?? "", others);
    if (nameIssues.length) v["alias.name"] = nameIssues.join(" ");
    if (!(rec.type! in ALIAS_TYPES)) v["alias.type"] = "Option not in list.";
    const entries = (rec.content ?? "").split("\n").filter(Boolean);
    const entryIssues = validateAliasEntries(rec.type!, entries, this.aliasNames()).filter((m) => !m.startsWith("Add at least"));
    if (entryIssues.length) v["alias.content"] = entryIssues.join(" ");
    for (const c of (rec.categories ?? "").split(",").filter(Boolean)) {
      if (!this.categories.has(c)) v["alias.categories"] = "Related category not found.";
    }
    return v;
  }

  private cleanAlias(input: RawRecord): RawRecord {
    const out: RawRecord = {};
    for (const [k, val] of Object.entries(input)) if (k in ALIAS_DEFAULTS) out[k] = String(val);
    return out;
  }

  addAlias(input: RawRecord): string {
    const rec = { ...ALIAS_DEFAULTS, ...this.cleanAlias(input) };
    const errs = this.validateAlias(rec);
    if (Object.keys(errs).length) throw new MockValidationError(errs);
    const uuid = randomUUID();
    this.aliases.set(uuid, rec);
    this.aliasPendingReconfigure = true;
    return uuid;
  }

  setAlias(uuid: string, input: RawRecord) {
    const existing = this.aliases.get(uuid);
    if (!existing && !UUID_RE.test(uuid)) throw new MockUserError("invalid uuid, upsert not allowed", "Alias");
    const cur = existing ?? { ...ALIAS_DEFAULTS };
    const rec = { ...cur, ...this.cleanAlias(input) };
    const errs = this.validateAlias(rec, uuid);
    if (Object.keys(errs).length) throw new MockValidationError(errs);
    if (existing && rec.name !== cur.name) this.refactorAlias(cur.name!, rec.name!);
    this.aliases.set(uuid, rec);
    this.aliasPendingReconfigure = true;
  }

  /** OPNsense renames references in rules when an alias is renamed. */
  private refactorAlias(from: string, to: string) {
    for (const r of this.rules.values()) {
      for (const f of ["source_net", "destination_net", "source_port", "destination_port"]) {
        if (!r[f]) continue;
        r[f] = r[f]!.split(",").map((t) => (t === from ? to : t)).join(",");
      }
    }
    for (const a of this.aliases.values()) {
      a.content = (a.content ?? "").split("\n").map((t) => (t === from ? to : t)).join("\n");
    }
  }

  whereUsed(name: string): string[] {
    const uses: string[] = [];
    for (const [u, r] of this.rules) {
      for (const f of ["source_net", "destination_net", "source_port", "destination_port"]) {
        if ((r[f] ?? "").split(",").includes(name)) uses.push(`[${u}] ${r.description}`);
      }
    }
    for (const a of this.aliases.values()) if ((a.content ?? "").split("\n").includes(name)) uses.push(`[alias] ${a.name}`);
    return uses;
  }

  delAlias(uuid: string): boolean {
    const a = this.aliases.get(uuid);
    if (!a) return false;
    const uses = this.whereUsed(a.name!);
    if (uses.length) throw new MockUserError(`Cannot delete alias ${a.name}. Currently in use by ${uses.join("\n")}`, "Alias in use");
    this.aliases.delete(uuid);
    this.aliasPendingReconfigure = true;
    return true;
  }

  // -------------------------------------------------------------------------
  // Categories

  setCategory(uuid: string, input: Partial<MockCategory>) {
    if (!UUID_RE.test(uuid)) throw new MockUserError("invalid uuid, upsert not allowed", "Category");
    const name = (input.name ?? this.categories.get(uuid)?.name ?? "").trim();
    if (!name) throw new MockValidationError({ "category.name": "A name is required." });
    for (const [u, c] of this.categories) {
      if (u !== uuid && c.name === name) throw new MockValidationError({ "category.name": "A category with this name already exists." });
    }
    this.categories.set(uuid, { name, color: input.color ?? this.categories.get(uuid)?.color ?? "" });
  }

  categoryNames(csv: string | undefined): string {
    return (csv ?? "").split(",").filter(Boolean).map((u) => this.categories.get(u)?.name ?? u).join(",");
  }

  // -------------------------------------------------------------------------
  // HA: what XMLRPC sync copies to the secondary (rules without nosync, aliases, categories)

  syncTo(peer: MockState) {
    peer.categories = new Map([...this.categories].map(([u, c]) => [u, { ...c }]));
    peer.aliases = new Map([...this.aliases].map(([u, a]) => [u, { ...a }]));
    const kept = [...peer.rules].filter(([, r]) => r.nosync === "1");
    peer.rules = new Map([...[...this.rules].filter(([, r]) => r.nosync !== "1").map(([u, r]) => [u, { ...r }] as [string, RawRecord]), ...kept]);
    peer.applyCount++;
    peer.pendingApply = false;
  }
}
