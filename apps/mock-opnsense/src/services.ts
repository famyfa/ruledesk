import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { SERVICES, unflatten, type GridDef, type Item, type ServiceDef } from "@ruledeck/core";

/**
 * Generic mock of the OPNsense MVC services in the catalogue (DHCP, DNS, gateways, ...).
 * It follows the real pattern: option fields come back as `{key: {value, selected}}` maps,
 * saves answer `{result: "saved", uuid}` or `{result: "failed", validations}`, and
 * `reconfigure` only answers ok to a POST (a GET answers `{status: "failed"}`).
 */

interface MockService {
  settings: Item | null;
  grids: Map<string, Map<string, Item>>;
  /** Saved but not yet activated. */
  pending: boolean;
  reconfigureCount: number;
}

const OPTIONS: Record<string, { value: string; label: string }[]> = {
  "general.interfaces": [{ value: "lan", label: "LAN" }, { value: "opt1", label: "DMZ" }],
  "general.active_interface": [{ value: "lan", label: "LAN" }, { value: "opt1", label: "DMZ" }],
  interface: [{ value: "lan", label: "LAN" }, { value: "opt1", label: "DMZ" }],
  rr: [{ value: "A", label: "A (IPv4 address)" }, { value: "AAAA", label: "AAAA (IPv6 address)" }],
  mode: [{ value: "carp", label: "CARP" }, { value: "ipalias", label: "IP Alias" }],
  transport: [{ value: "udp4", label: "UDP(4)" }, { value: "tcp4", label: "TCP(4)" }],
};

const SEED_SETTINGS: Record<string, Item> = {
  kea4: { "general.enabled": "0", "general.interfaces": "", "general.valid_lifetime": "4000", "general.ddns_domain_key_secret": "mock-secret-do-not-leak" },
  kea6: { "general.enabled": "0", "general.interfaces": "", "general.valid_lifetime": "4000" },
  dnsmasq: { enable: "1", regdhcp: "0", "dhcp.fqdn": "1", interface: "lan", port: "53" },
  unbound: { "general.enabled": "1", "general.port": "53", "general.active_interface": "", "general.outgoing_interface": "" },
  syslog: { "general.enabled": "1", "general.loglocal": "1", "general.maxpreserve": "31" },
};

const SEED_GRIDS: Record<string, Record<string, Item[]>> = {
  kea4: { subnets: [{ subnet: "192.168.1.0/24", pools: "192.168.1.100-192.168.1.200", description: "LAN clients" }] },
  dnsmasq: {
    hosts: [
      { host: "nas", domain: "lan", ip: "192.168.1.5", hwaddr: "", descr: "Storage" },
      { host: "printer", domain: "lan", ip: "192.168.1.6", hwaddr: "", descr: "" },
    ],
  },
  unbound: { host_overrides: [{ enabled: "1", hostname: "fw", domain: "lan", rr: "A", server: "192.168.1.1", description: "Firewall" }] },
  gateways: { gateways: [{ disabled: "0", name: "WAN_GW", interface: "lan", gateway: "10.0.0.1", priority: "255", descr: "Default gateway" }] },
  routes: { routes: [{ disabled: "0", network: "10.9.0.0/16", gateway: "WAN_GW", descr: "Remote office" }] },
  nat: { port_forward: [{ disabled: "0", interface: "wan", protocol: "TCP", destination_net: "wanip", destination_port: "443", target: "192.168.1.10", "local-port": "443", descr: "HTTPS to web" }] },
  wireguard: {
    servers: [{ enabled: "1", name: "wg0", pubkey: "MOCKPUBKEY", privkey: "mock-wg-private-do-not-leak", port: "51820", tunneladdress: "10.8.0.1/24" }],
    clients: [{ enabled: "1", name: "laptop", pubkey: "PEERPUBKEY", psk: "mock-psk-do-not-leak", serveraddress: "vpn.example", serverport: "51820", tunneladdress: "10.8.0.2/32" }],
  },
  access: { users: [{ disabled: "0", name: "admin", scope: "system", descr: "System Administrator", user_dn: "", password: "mock-hash-do-not-leak", otp_seed: "MOCKOTPSEED" }], groups: [{ name: "admins", scope: "system", description: "Administrators", member: "admin" }] },
  vips: { vips: [{ interface: "lan", mode: "carp", subnet: "192.168.1.1", vhid: "1", password: "mock-carp-password", descr: "LAN VIP" }] },
};

const SECRET = /(password|secret)/i;

export class MockServices {
  private svc = new Map<string, MockService>();

  constructor() {
    for (const def of SERVICES) {
      const grids = new Map<string, Map<string, Item>>();
      for (const g of def.grids) {
        const m = new Map<string, Item>();
        for (const item of SEED_GRIDS[def.id]?.[g.id] ?? []) m.set(randomUUID(), { ...item });
        grids.set(g.id, m);
      }
      this.svc.set(def.id, { settings: SEED_SETTINGS[def.id] ? { ...SEED_SETTINGS[def.id]! } : def.settings ? {} : null, grids, pending: false, reconfigureCount: 0 });
    }
  }

  get(id: string) {
    return this.svc.get(id)!;
  }

  dump() {
    return Object.fromEntries(
      [...this.svc].map(([id, s]) => [id, { settings: s.settings, pending: s.pending, reconfigureCount: s.reconfigureCount, grids: Object.fromEntries([...s.grids].map(([g, m]) => [g, Object.fromEntries(m)])) }]),
    );
  }
}

const fieldsOf = (g: GridDef, items: Item[]): string[] => [...new Set([...g.columns, ...g.nameFields, ...items.flatMap((i) => Object.keys(i))])];

/** Render a flat item as the nested raw JSON the firewall sends (option fields as option maps). */
function raw(item: Item, extraFields: string[], multi: string[] = []): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const k of new Set([...extraFields, ...Object.keys(item)])) {
    const v = item[k] ?? "";
    const opts = OPTIONS[k];
    if (opts && (v === "" || !multi.includes(k))) {
      flat[k] = Object.fromEntries(opts.map((o) => [o.value, { value: o.label, selected: v.split(",").includes(o.value) ? 1 : 0 }]));
    } else if (opts) {
      flat[k] = Object.fromEntries(opts.map((o) => [o.value, { value: o.label, selected: v.split(",").includes(o.value) ? 1 : 0 }]));
    } else {
      flat[k] = v;
    }
  }
  return unflatten(flat as Item);
}

/** Mock validation: values containing INVALID are refused (so tests can trigger the firewall's validation errors). */
function validate(root: string, patch: Item): Record<string, string> | null {
  const bad = Object.entries(patch).filter(([, v]) => v.includes("INVALID"));
  if (!bad.length) return null;
  return Object.fromEntries(bad.map(([k]) => [`${root}.${k}`, "Mock validation: this value is not allowed."]));
}

function flattenBody(body: unknown, root: string): Item {
  const node = (body as Record<string, unknown> | null)?.[root];
  const out: Item = {};
  const walk = (n: unknown, path: string) => {
    if (n && typeof n === "object") {
      for (const [k, v] of Object.entries(n)) if (!["__proto__", "constructor", "prototype"].includes(k)) walk(v, path ? `${path}.${k}` : k);
    } else if (path) out[path] = String(n ?? "");
  };
  walk(node, "");
  return out;
}

export function registerServiceRoutes(app: FastifyInstance, store: () => MockServices) {
  const row = (g: GridDef, uuid: string, item: Item) => ({ uuid, ...Object.fromEntries(Object.entries(item).filter(([k]) => !SECRET.test(k))) });

  const registered = new Set<string>();
  for (const def of SERVICES) {
    const s = () => store().get(def.id);

    if (def.settings) {
      const set = def.settings;
      app.get(`/api/${set.get}`, async () => ({ [set.root]: raw(s().settings ?? {}, [], def.multi) }));
      app.post(`/api/${set.set}`, async (req) => {
        const patch = flattenBody(req.body, set.root);
        const bad = validate(set.root, patch);
        if (bad) return { result: "failed", validations: bad };
        s().settings = { ...(s().settings ?? {}), ...patch };
        s().pending = true;
        return { result: "saved" };
      });
    }

    for (const g of def.grids) {
      const items = () => s().grids.get(g.id)!;
      const fields = () => fieldsOf(g, [...items().values()]);
      const defaults = () => Object.fromEntries(fields().map((f) => [f, g.root === "route" || f === "enabled" ? (f === "enabled" ? "1" : "") : ""])) as Item;

      const search = async () => {
        const rows = [...items()].map(([uuid, item]) => row(g, uuid, item));
        return { rows, rowCount: rows.length, total: rows.length, current: 1 };
      };
      app.post(`/api/${g.search}`, search);
      app.get(`/api/${g.search}`, search);
      app.get(`/api/${g.get}`, async () => ({ [g.root]: raw(defaults(), fields(), g.multi) }));
      app.get(`/api/${g.get}/:uuid`, async (req, reply) => {
        const it = items().get((req.params as { uuid: string }).uuid);
        if (!it) return reply.send({});
        return { [g.root]: raw(it, fields(), g.multi) };
      });
      app.post(`/api/${g.add}`, async (req) => {
        const patch = flattenBody(req.body, g.root);
        const bad = validate(g.root, patch);
        if (bad) return { result: "failed", validations: bad };
        const uuid = randomUUID();
        items().set(uuid, { ...defaults(), ...patch });
        s().pending = true;
        return { result: "saved", uuid };
      });
      app.post(`/api/${g.set}/:uuid`, async (req) => {
        const uuid = (req.params as { uuid: string }).uuid;
        const cur = items().get(uuid);
        if (!cur) return { result: "failed", validations: { [g.root]: "not found" } };
        const patch = flattenBody(req.body, g.root);
        const bad = validate(g.root, patch);
        if (bad) return { result: "failed", validations: bad };
        items().set(uuid, { ...cur, ...patch });
        s().pending = true;
        return { result: "saved" };
      });
      app.post(`/api/${g.del}/:uuid`, async (req) => {
        const ok = items().delete((req.params as { uuid: string }).uuid);
        if (ok) s().pending = true;
        return { result: ok ? "deleted" : "not found" };
      });
    }

    if (def.reconfigure && !registered.has(def.reconfigure)) {
      registered.add(def.reconfigure);
      const path = def.reconfigure;
      app.all(`/api/${path}`, async (req) => {
        if (req.method !== "POST") return { status: "failed" };
        // One endpoint can serve several services (Kea v4 and v6).
        for (const d of SERVICES.filter((x) => x.reconfigure === path)) {
          store().get(d.id).pending = false;
          store().get(d.id).reconfigureCount++;
        }
        return { status: "ok" };
      });
    }
  }

  // Certificates. Like the real list, the rows also carry the private key and PEM payloads (RuleDeck must drop them).
  const now = Math.floor(Date.now() / 1000);
  const certRow = (n: number, descr: string, daysLeft: number, extra: Record<string, unknown> = {}) => ({
    uuid: `00000000-0000-4000-8000-00000000000${n}`,
    refid: `ref${n}`,
    descr,
    caref: "",
    commonname: `${descr.toLowerCase().replace(/\W+/g, "-")}.example`,
    cert_type: "server_cert",
    name: `/CN=${descr}`,
    valid_from: now - 86400,
    valid_to: now + daysLeft * 86400,
    in_use: n === 1 ? "1" : "0",
    altnames_dns: "a.example\nb.example",
    altnames_ip: "",
    crt_payload: "-----BEGIN CERTIFICATE-----MOCKCERT",
    prv: "MOCKPRIVATEKEY-do-not-leak",
    prv_payload: "-----BEGIN PRIVATE KEY-----MOCKPRIVATEKEY-do-not-leak",
    ...extra,
  });
  const certs = async () => {
    const rows = [certRow(1, "Web GUI TLS certificate", 400), certRow(2, "VPN certificate", 12), certRow(3, "Old certificate", -5)];
    return { rows, rowCount: rows.length, total: rows.length, current: 1 };
  };
  app.post("/api/trust/cert/search", certs);
  app.get("/api/trust/cert/search", certs);
  const cas = async () => ({ rows: [certRow(9, "Internal CA", 3000, { cert_type: "ca" })], rowCount: 1, total: 1, current: 1 });
  app.post("/api/trust/ca/search", cas);
  app.get("/api/trust/ca/search", cas);

  // Test control: an edit made "elsewhere" (not through RuleDeck).
  app.post("/__mock/service-edit", async (req) => {
    const b = (req.body ?? {}) as { service: string; grid?: string; match?: Item; fields?: Item; remove?: boolean };
    const s = store().get(b.service);
    if (!s) return { status: "unknown service" };
    if (!b.grid) {
      s.settings = { ...(s.settings ?? {}), ...(b.fields ?? {}) };
      return { status: "ok" };
    }
    for (const [uuid, item] of s.grids.get(b.grid) ?? []) {
      if (Object.entries(b.match ?? {}).every(([k, v]) => item[k] === v)) {
        if (b.remove) s.grids.get(b.grid)!.delete(uuid);
        else Object.assign(item, b.fields ?? {});
        return { status: "ok" };
      }
    }
    return { status: "not found" };
  });
  app.get("/__mock/services", async () => store().dump());
}

export type { ServiceDef };
