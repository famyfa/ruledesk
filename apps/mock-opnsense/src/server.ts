import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  ALIAS_DEFAULTS,
  ALIAS_TYPES,
  RULE_DEFAULTS,
  MockState,
  MockUserError,
  MockValidationError,
  OPTION_FIELDS,
  WELL_KNOWN_PORTS,
  type RawRecord,
} from "./state.ts";
import { MockAuth, type MockAuthOptions } from "./auth.ts";

export interface MockServerOptions extends MockAuthOptions {
  /** Shorthand for a single API key for the "root" user. */
  apiKey?: string;
  apiSecret?: string;
  version?: string;
  logger?: boolean;
  /** Interface key of the DMZ at this site. */
  dmzKey?: string;
  /** Distinct seed uuids per site. */
  uuidSalt?: string;
}

/** One change recorded with the user who made it, like OPNsense's config history. */
export interface HistoryEntry {
  user: string;
  endpoint: string;
}

export type FaultType = "validation" | "timeout" | "http500" | "unsupported" | "slow";

interface Fault {
  match: string;
  type: FaultType;
  count: number;
}

export interface MockServer {
  app: FastifyInstance;
  state: () => MockState;
  auth: MockAuth;
  history: () => HistoryEntry[];
  /** Make this mock an HA primary that syncs to `peer` (its secondary); null = no HA sync target. */
  linkSecondary: (peer: MockServer | null, peerAddress?: string) => void;
}

/** Turn an option-field value into OPNsense's `{key: {value, selected}}` map. */
function optionMap(options: Record<string, string>, selected: string) {
  const sel = new Set(selected.split(",").filter(Boolean));
  return Object.fromEntries(Object.entries(options).map(([k, label]) => [k, { value: label, selected: sel.has(k) ? 1 : 0 }]));
}

export function buildMockServer(opts: MockServerOptions = {}): MockServer {
  const auth = new MockAuth({
    ...opts,
    apiKeys: opts.apiKeys ?? { [opts.apiKey ?? "mock-key"]: { secret: opts.apiSecret ?? "mock-secret", user: "root" } },
  });
  const stateOpts = () => ({ version: opts.version, dmzKey: opts.dmzKey, uuidSalt: opts.uuidSalt });
  let state = new MockState(stateOpts());
  let secondary: { peer: MockServer; address: string } | null = null;
  let faults: Fault[] = [];
  let history: HistoryEntry[] = [];

  const app = Fastify({ logger: opts.logger ?? false, forceCloseConnections: true });

  // OPNsense tolerates empty POST bodies; so do we.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = String(body ?? "").trim();
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  auth.register(app);

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    const path = req.url.replace(/^\/api\//, "").split("?")[0]!;
    const user = auth.authenticateApi(req, reply, path);
    if (!user) return reply;
    if (req.method === "POST" && !/search|get_|list_/.test(path)) history.push({ user, endpoint: path });
    const idx = faults.findIndex((f) => path.startsWith(f.match) && f.count > 0);
    if (idx >= 0) {
      const fault = faults[idx]!;
      fault.count--;
      if (fault.count <= 0) faults.splice(idx, 1);
      switch (fault.type) {
        case "timeout":
          await new Promise((r) => setTimeout(r, 60_000).unref());
          return reply;
        case "slow":
          await new Promise((r) => setTimeout(r, 400).unref());
          break;
        case "http500":
          reply.code(500).send({ errorMessage: "Internal Error", errorTitle: "An error occurred" });
          return reply;
        case "unsupported":
          reply.code(404).send({ errorMessage: "Endpoint not found" });
          return reply;
        case "validation":
          reply.send({ result: "failed", validations: { [`${path.includes("alias") ? "alias" : "rule"}.description`]: "Injected validation error." } });
          return reply;
      }
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof MockValidationError) return reply.send({ result: "failed", validations: err.validations });
    if (err instanceof MockUserError) return reply.code(400).send({ errorMessage: err.message, errorTitle: err.title });
    reply.code(500).send({ errorMessage: "Internal Error", errorTitle: "An error occurred" });
  });

  // ---------------------------------------------------------------- control
  app.post("/__mock/reset", async (req) => {
    const body = (req.body ?? {}) as { version?: string };
    state = new MockState({ ...stateOpts(), version: body.version ?? opts.version });
    faults = [];
    history = [];
    auth.dnsRebind = opts.dnsRebind ?? false;
    return { status: "ok" };
  });
  app.post("/__mock/faults", async (req) => {
    const list = (req.body ?? []) as Partial<Fault>[];
    for (const f of list) faults.push({ match: f.match ?? "", type: f.type ?? "http500", count: f.count ?? 1 });
    return { status: "ok", queued: faults.length };
  });
  app.post("/__mock/external-edit", async (req) => {
    const body = (req.body ?? {}) as { uuid?: string; fields?: RawRecord };
    const uuid = body.uuid ?? [...state.rules.keys()][0]!;
    const rec = state.rules.get(uuid);
    if (!rec) return { status: "not found" };
    Object.assign(rec, body.fields ?? { description: `${rec.description} (edited elsewhere)` });
    state.pendingApply = true;
    return { status: "ok", uuid };
  });
  app.post("/__mock/expire-sessions", async () => {
    auth.expireSessions();
    return { status: "ok" };
  });
  app.post("/__mock/dns-rebind", async (req) => {
    auth.dnsRebind = Boolean((req.body as { on?: boolean } | undefined)?.on ?? true);
    return { status: "ok" };
  });
  /** Add read-only (automatic/legacy) rules, e.g. several that share one `ref` like real firewalls do. */
  app.post("/__mock/legacy-rules", async (req) => {
    const rows = ((req.body ?? []) as RawRecord[]).map((r, i) => ({
      legacy: "1",
      enabled: "1",
      action: "pass",
      direction: "in",
      ipprotocol: "inet",
      protocol: "any",
      source_net: "any",
      destination_net: "any",
      sort_order: `400000.1${String(2000 + i)}`,
      prio_group: "400000",
      ...r,
    }));
    state.legacyRules.push(...rows);
    return { status: "ok", count: state.legacyRules.length };
  });
  app.get("/__mock/history", async () => ({ history }));
  app.get("/__mock/state", async () => ({
    version: state.version,
    pendingApply: state.pendingApply,
    aliasPendingReconfigure: state.aliasPendingReconfigure,
    applyCount: state.applyCount,
    rules: state.allRulesSorted(),
    aliases: [...state.aliases.entries()].map(([uuid, a]) => ({ uuid, ...a })),
    categories: [...state.categories.entries()].map(([uuid, c]) => ({ uuid, ...c })),
  }));

  // ---------------------------------------------------------------- core
  app.get("/api/core/firmware/info", async () => ({
    product_id: "opnsense",
    product_version: state.version,
    package: [],
    plugin: [],
  }));

  // ---------------------------------------------------------------- filter
  const paramsOf = (req: FastifyRequest) => ({
    ...((req.query ?? {}) as Record<string, string>),
    ...((req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>),
  });

  function paginate<T>(rows: T[], params: Record<string, unknown>) {
    const rowCount = Number(params.rowCount ?? -1);
    const current = Math.max(1, Number(params.current ?? 1));
    const page = rowCount > 0 ? rows.slice((current - 1) * rowCount, current * rowCount) : rows;
    return { total: rows.length, rowCount: rowCount > 0 ? rowCount : rows.length, current, rows: page };
  }

  function matchesPhrase(row: RawRecord, phrase: string) {
    const tokens = phrase.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hay = Object.values(row).join(" ").toLowerCase();
    return tokens.every((t) => hay.includes(t));
  }

  const searchRule = async (req: FastifyRequest) => {
    const p = paramsOf(req);
    let rows = state.allRulesSorted();
    if ("interface" in p) {
      const want = String(p.interface ?? "").split(",").filter(Boolean);
      rows = rows.filter((r) => {
        const ifs = (r.interface ?? "").split(",").filter(Boolean);
        if (!r.interface) return true;
        if (want.length === 0) return ifs.length !== 1;
        return ifs.some((i) => want.includes(i));
      });
    }
    if (p.searchPhrase) rows = rows.filter((r) => matchesPhrase(r, String(p.searchPhrase)));
    const decorated = rows.map((r) => ({
      ...r,
      "%action": OPTION_FIELDS.action![r.action ?? ""] ?? r.action,
      "%direction": OPTION_FIELDS.direction![r.direction ?? ""] ?? r.direction,
      "%ipprotocol": OPTION_FIELDS.ipprotocol![r.ipprotocol ?? ""] ?? r.ipprotocol,
      category_colors: [],
    }));
    return paginate(decorated, p);
  };
  app.get("/api/firewall/filter/search_rule", searchRule);
  app.post("/api/firewall/filter/search_rule", searchRule);

  const getRule = async (req: FastifyRequest<{ Params: { uuid?: string } }>) => {
    const uuid = req.params.uuid;
    const rec = uuid ? state.rules.get(uuid) : { ...RULE_DEFAULTS };
    if (!rec) return [];
    const out: Record<string, unknown> = { ...rec };
    for (const [field, options] of Object.entries(OPTION_FIELDS)) out[field] = optionMap(options, rec[field] ?? "");
    out.interface = optionMap(Object.fromEntries(state.interfaces.filter((i) => i.key !== "lo0").map((i) => [i.key, i.descr])), rec.interface ?? "");
    if (uuid) {
      const d = state.decorate(uuid, rec);
      out.sort_order = d.sort_order;
      out.prio_group = d.prio_group;
    }
    return { rule: out };
  };
  app.get("/api/firewall/filter/get_rule", getRule);
  app.get("/api/firewall/filter/get_rule/:uuid", getRule);

  const ruleBody = (req: FastifyRequest): RawRecord => {
    const body = (req.body ?? {}) as { rule?: Record<string, unknown> };
    const out: RawRecord = {};
    for (const [k, v] of Object.entries(body.rule ?? {})) out[k] = Array.isArray(v) ? v.join(",") : String(v ?? "");
    return out;
  };

  app.post("/api/firewall/filter/add_rule", async (req) => ({ result: "saved", uuid: state.addRule(ruleBody(req)) }));
  app.post("/api/firewall/filter/set_rule/:uuid", async (req: FastifyRequest<{ Params: { uuid: string } }>) => {
    state.setRule(req.params.uuid, ruleBody(req));
    return { result: "saved" };
  });
  app.post("/api/firewall/filter/del_rule/:uuid", async (req: FastifyRequest<{ Params: { uuid: string } }>) => ({
    result: state.delRule(req.params.uuid) ? "deleted" : "not found",
  }));
  const toggle = async (req: FastifyRequest<{ Params: { uuid: string; enabled?: string } }>) => {
    const ok = state.toggleRule(req.params.uuid, req.params.enabled);
    return { result: ok ? "saved" : "failed", changed: ok };
  };
  app.post("/api/firewall/filter/toggle_rule/:uuid", toggle);
  app.post("/api/firewall/filter/toggle_rule/:uuid/:enabled", toggle);
  app.post("/api/firewall/filter/move_rule_before/:selected/:target", async (req: FastifyRequest<{ Params: { selected: string; target: string } }>) => {
    state.moveRuleBefore(req.params.selected, req.params.target);
    return { status: "ok" };
  });
  app.post("/api/firewall/filter/apply", async () => {
    state.apply();
    return { status: "OK\n\n" };
  });

  app.get("/api/firewall/filter/get_interface_list", async () => {
    const items = (type: "group" | "interface") =>
      state.interfaces
        .filter((i) => i.key !== "lo0" && (type === "group" ? i.type === "group" : i.type !== "group"))
        .map((i) => ({ value: i.key, label: i.descr, type }));
    return {
      floating: { label: "Floating", icon: "", items: [{ value: "__floating", label: "Floating", type: "floating" }] },
      groups: { label: "Groups", icon: "", items: items("group") },
      interfaces: { label: "Interfaces", icon: "", items: items("interface") },
      any: { label: "Any", icon: "", items: [{ value: "__any", label: "All rules", type: "any" }] },
    };
  });

  app.get("/api/firewall/filter/list_network_select_options", async () => {
    const networks: Record<string, string> = { any: "any", "(self)": "This Firewall" };
    for (const i of state.interfaces) {
      networks[i.key] = `${i.descr} network`;
      if (!i.virtual) networks[`${i.key}ip`] = `${i.descr} address`;
    }
    const aliases: Record<string, string> = {};
    for (const a of state.aliases.values()) if (a.type !== "port" && a.type !== "internal") aliases[a.name!] = a.name!;
    return {
      single: { label: "Single host or Network" },
      aliases: { label: "Aliases", items: aliases },
      networks: { label: "Networks", items: networks },
    };
  });

  app.get("/api/firewall/filter/list_port_select_options", async (_req, reply: FastifyReply) => {
    if (state.version.startsWith("25.")) return reply.code(404).send({ errorMessage: "Endpoint not found" });
    const ports: Record<string, string> = { "": "any" };
    for (const [svc, port] of Object.entries(WELL_KNOWN_PORTS)) ports[svc] = `${svc.toUpperCase()} (${port})`;
    const aliases: Record<string, string> = {};
    for (const a of state.aliases.values()) if (a.type === "port") aliases[a.name!] = a.name!;
    return { single: { label: "Single port or range" }, aliases: { label: "Aliases", items: aliases }, ports: { label: "Ports", items: ports } };
  });

  // ---------------------------------------------------------------- alias
  const searchAlias = async (req: FastifyRequest) => {
    const p = paramsOf(req);
    let rows: RawRecord[] = [...state.aliases.entries()]
      .map(([uuid, a]): RawRecord => ({ ...a, uuid }))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    if (p.searchPhrase) rows = rows.filter((r) => matchesPhrase(r, String(p.searchPhrase)));
    return paginate(
      rows.map((r) => ({ ...r, categories: state.categoryNames(r.categories), categories_uuid: (r.categories ?? "").split(",").filter(Boolean) })),
      p,
    );
  };
  app.get("/api/firewall/alias/search_item", searchAlias);
  app.post("/api/firewall/alias/search_item", searchAlias);

  const getAlias = async (req: FastifyRequest<{ Params: { uuid?: string } }>) => {
    const uuid = req.params.uuid;
    const rec = uuid ? state.aliases.get(uuid) : { ...ALIAS_DEFAULTS };
    if (!rec) return [];
    const content = Object.fromEntries(
      (rec.content ?? "").split("\n").filter(Boolean).map((e) => [e, { value: e, selected: 1, description: "" }]),
    );
    for (const a of state.aliases.values()) {
      if (!(a.name! in content)) content[a.name!] = { value: a.name!, selected: 0, description: a.description ?? "" };
    }
    return {
      alias: {
        ...rec,
        type: optionMap(ALIAS_TYPES, rec.type ?? ""),
        proto: optionMap({ IPv4: "IPv4", IPv6: "IPv6" }, rec.proto ?? ""),
        content,
      },
    };
  };
  app.get("/api/firewall/alias/get_item", getAlias);
  app.get("/api/firewall/alias/get_item/:uuid", getAlias);

  const aliasBody = (req: FastifyRequest): RawRecord => {
    const body = (req.body ?? {}) as { alias?: Record<string, unknown> };
    const out: RawRecord = {};
    for (const [k, v] of Object.entries(body.alias ?? {})) out[k] = Array.isArray(v) ? v.join(k === "content" ? "\n" : ",") : String(v ?? "");
    return out;
  };
  app.post("/api/firewall/alias/add_item", async (req) => ({ result: "saved", uuid: state.addAlias(aliasBody(req)) }));
  app.post("/api/firewall/alias/set_item/:uuid", async (req: FastifyRequest<{ Params: { uuid: string } }>) => {
    state.setAlias(req.params.uuid, aliasBody(req));
    return { result: "saved" };
  });
  app.post("/api/firewall/alias/del_item/:uuid", async (req: FastifyRequest<{ Params: { uuid: string } }>) => ({
    result: state.delAlias(req.params.uuid) ? "deleted" : "not found",
  }));
  app.get("/api/firewall/alias/get_alias_u_u_i_d/:name", async (req: FastifyRequest<{ Params: { name: string } }>) => {
    for (const [uuid, a] of state.aliases) if (a.name === req.params.name) return { uuid };
    return [];
  });
  app.post("/api/firewall/alias/reconfigure", async () => {
    state.aliasPendingReconfigure = false;
    return { status: "ok" };
  });

  // ---------------------------------------------------------------- category
  const searchCategory = async (req: FastifyRequest) =>
    paginate(
      [...state.categories].map(([uuid, c]) => ({ uuid, ...c })),
      paramsOf(req),
    );
  app.get("/api/firewall/category/search_item", searchCategory);
  app.post("/api/firewall/category/search_item", searchCategory);
  app.post("/api/firewall/category/set_item/:uuid", async (req: FastifyRequest<{ Params: { uuid: string } }>) => {
    const body = (req.body ?? {}) as { category?: { name?: string; color?: string } };
    state.setCategory(req.params.uuid, body.category ?? {});
    return { result: "saved" };
  });

  // ---------------------------------------------------------------- HA (core/hasync, core/hasync_status)
  app.get("/api/core/hasync/get", async () => ({
    hasync: {
      synchronizetoip: secondary?.address ?? "",
      pfsyncinterface: secondary ? "lan" : "",
      syncitems: {},
    },
  }));
  app.get("/api/core/hasync_status/version", async (_req, reply) => {
    if (!secondary) return reply.send({ status: "error", message: "no peer configured" });
    return { response: { firmware: { version: secondary.peer.state().version } } };
  });
  app.post("/api/core/hasync_status/restart_all", async () => {
    if (!secondary) return { status: "failed" };
    state.syncTo(secondary.peer.state());
    return { status: "ok", count: 3 };
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ errorMessage: "Endpoint not found" }));

  return {
    app,
    state: () => state,
    auth,
    history: () => history,
    linkSecondary: (peer, address = "10.0.0.2") => {
      secondary = peer ? { peer, address } : null;
    },
  };
}
