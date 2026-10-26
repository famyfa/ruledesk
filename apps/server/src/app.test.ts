import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildMockServer, type MockServer } from "../../mock-opnsense/src/server.ts";
import { buildApp, CSRF_HEADER, SESSION_COOKIE } from "./app.ts";
import { IDLE_TIMEOUT_MS, RateLimiter, SessionStore } from "./auth.ts";
import { ConfigError, loadConfig, type AppConfig } from "./config.ts";
import { parseTopology, publicTopology } from "./topology.ts";

/** Two sites, each a mock firewall. */
let ber: MockServer;
let muc: MockServer;
let app: FastifyInstance;
const urlOf = (m: MockServer) => `http://127.0.0.1:${(m.app.server.address() as { port: number }).port}`;

beforeAll(async () => {
  ber = buildMockServer();
  muc = buildMockServer({ users: { alice: { password: "alice-pass-1", privileges: ["*"] } } });
  await ber.app.listen({ port: 0, host: "127.0.0.1" });
  await muc.app.listen({ port: 0, host: "127.0.0.1" });
  const topology = parseTopology(
    JSON.stringify({
      version: 1,
      sites: [
        { id: "ber", name: "Berlin", primary: { url: urlOf(ber) } },
        { id: "muc", name: "Munich", primary: { url: urlOf(muc) } },
      ],
    }),
  );
  const config: AppConfig = { production: false, host: "127.0.0.1", port: 0, cookieSecure: false, allowWrites: true, applyRateLimit: 100, siteLoginFailures: 100, topology };
  app = await buildApp({ config, logger: false });
});

afterAll(async () => {
  await app.close();
  await ber.app.close();
  await muc.app.close();
});

beforeEach(async () => {
  for (const m of [ber, muc]) await fetch(`${urlOf(m)}/__mock/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
});

const pw = (username: string, password: string) => ({ method: "password" as const, username, password });

/** Cookie + CSRF token from a response that (re)issued the session. */
function sessionOf(res: { cookies: { name: string; value: string }[]; json: () => { csrfToken: string } }) {
  return { cookie: `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`, csrf: res.json().csrfToken };
}

async function login(sites: Record<string, unknown>, ip = "10.0.0.1") {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { sites }, remoteAddress: ip });
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE);
  const body = res.json();
  return { res, body, cookie: c ? `${SESSION_COOKIE}=${c.value}` : "", csrf: body.csrfToken as string };
}

describe("topology", () => {
  it("is public but reveals no URLs", async () => {
    const res = await app.inject({ method: "GET", url: "/api/topology" });
    expect(res.json().sites.map((s: { id: string }) => s.id)).toEqual(["ber", "muc"]);
    expect(res.body).not.toContain("127.0.0.1");
  });

  it("validates the file", () => {
    const site = (id: string, url: string, extra = {}) => ({ id, name: id, primary: { url }, ...extra });
    const t = (sites: unknown[]) => () => parseTopology(JSON.stringify({ version: 1, sites }));
    expect(t([site("a", "https://a"), site("a", "https://b")])).toThrow(/Duplicate site/);
    expect(t([site("a", "http://fw.lan")])).toThrow(/https/);
    expect(t([site("a", "https://a"), site("b", "https://a")])).toThrow(/used twice/);
    expect(t([site("a", "https://a", { interfaces: { LAN: { key: "lan", label: "LAN" } } }), site("b", "https://b")])).toThrow(/every site/);
    expect(t([site("a", "https://a", { interfaces: { LAN: { key: "lan", label: "LAN" }, DMZ: { key: "lan", label: "DMZ" } } })])).toThrow(/same key/);
    expect(t([{ ...site("a", "https://a"), password: "x" }])).toThrow(/Invalid topology/);
    const pub = publicTopology(parseTopology(JSON.stringify({ version: 1, sites: [site("a", "https://a", { secondary: { url: "https://a2" } })] })));
    expect(pub.sites[0]).toEqual({ id: "a", name: "a", hasSecondary: true, interfaces: null });
    // The interface map is public (names, keys, labels), nothing else of a site is.
    const mapped = parseTopology(JSON.stringify({ version: 1, sites: [site("a", "https://a", { interfaces: { DMZ: { key: "opt1", label: "DMZ" } } })] }));
    const withMap = publicTopology(mapped, true);
    expect(withMap.sites[0]!.interfaces).toEqual({ DMZ: { key: "opt1", label: "DMZ" } });
    expect(publicTopology(mapped).sites[0]!.interfaces).toBeNull(); // not before sign-in
    expect(JSON.stringify(withMap)).not.toContain("https://a");
  });

  it("refuses old settings that would store secrets", () => {
    const load = () => parseTopology(JSON.stringify({ version: 1, sites: [{ id: "a", name: "A", primary: { url: "https://a" } }] }));
    expect(() => loadConfig({ OPNSENSE_API_SECRET: "x" }, load)).toThrow(ConfigError);
    expect(() => loadConfig({ RULEDECK_ADMIN_PASSWORD_HASH: "x" }, load)).toThrow(/no longer used/);
    const cfg = loadConfig({ NODE_ENV: "production" }, load);
    expect(cfg.cookieSecure).toBe(true);
    expect(cfg.allowWrites).toBe(false);
  });
});

describe("signing in with OPNsense accounts", () => {
  it("rejects API calls without a session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/sites/ber/snapshot" })).statusCode).toBe(401);
  });

  it("signs in to each site with that site's own account, and reports per-site failures", async () => {
    const { res, body } = await login({ ber: pw("admin", "ruledeck-dev"), muc: pw("alice", "wrong-password") });
    expect(res.statusCode).toBe(200);
    const sites = Object.fromEntries(body.sites.map((s: { id: string }) => [s.id, s]));
    expect(sites.ber).toMatchObject({ signedIn: true, user: "admin", method: "password" });
    expect(sites.ber.info.productVersion).toBe("26.7.7");
    expect(sites.muc).toMatchObject({ signedIn: false });
    expect(body.siteErrors.muc.kind).toBe("invalid_credentials");
    const c = res.cookies.find((x) => x.name === SESSION_COOKIE)!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe("Strict");
  });

  it("fails when no site accepts the credentials", async () => {
    const { res } = await login({ ber: pw("admin", "nope-nope-1") }, "10.0.0.2");
    expect(res.statusCode).toBe(401);
  });

  it("supports an API key instead of a password", async () => {
    const { body } = await login({ ber: { method: "apikey", apiKey: "mock-key", apiSecret: "mock-secret" } });
    expect(body.sites[0]).toMatchObject({ signedIn: true, user: "API key …-key", method: "apikey" });
  });

  it("never returns passwords, secrets or firewall cookies", async () => {
    const { res, cookie } = await login({ ber: pw("admin", "ruledeck-dev"), muc: { method: "apikey", apiKey: "mock-key", apiSecret: "mock-secret" } });
    const session = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } });
    for (const text of [res.body, session.body]) {
      expect(text).not.toContain("ruledeck-dev");
      expect(text).not.toContain("mock-secret");
      expect(text).not.toContain("PHPSESSID");
    }
  });

  it("rate-limits failed sign-ins per IP and site", async () => {
    const codes: string[] = [];
    for (let i = 0; i < 7; i++) {
      const { body } = await login({ ber: pw("admin", "bad-bad-bad") }, "10.9.9.9");
      codes.push(body.siteErrors.ber.kind);
    }
    expect(codes.slice(0, 5).every((k) => k === "invalid_credentials")).toBe(true);
    expect(codes.slice(5)).toEqual(["rate_limited", "rate_limited"]);
  });

  it("requires the CSRF token on state-changing requests", async () => {
    const { cookie, csrf } = await login({ ber: pw("admin", "ruledeck-dev") });
    expect((await app.inject({ method: "POST", url: "/api/sites/ber/connect", headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/sites/ber/connect", headers: { cookie, [CSRF_HEADER]: csrf } })).statusCode).toBe(200);
  });

  it("adds a second site later, and signs out of a single site", async () => {
    const { cookie, csrf } = await login({ ber: pw("admin", "ruledeck-dev") });
    const add = await app.inject({ method: "POST", url: "/api/auth/sites/muc", headers: { cookie, [CSRF_HEADER]: csrf }, payload: pw("alice", "alice-pass-1") });
    expect(add.json().sites.find((s: { id: string }) => s.id === "muc").signedIn).toBe(true);
    expect(muc.auth.signedInSessions()).toBe(1);
    const next = sessionOf(add);
    const out = await app.inject({ method: "POST", url: "/api/auth/sites/muc/logout", headers: { cookie: next.cookie, [CSRF_HEADER]: next.csrf } });
    expect(out.json().sites.find((s: { id: string }) => s.id === "muc").signedIn).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(muc.auth.signedInSessions()).toBe(0); // logged out of the firewall too
  });

  it("logs out of the firewalls when RuleDeck's session ends", async () => {
    const before = ber.auth.signedInSessions();
    const { cookie, csrf } = await login({ ber: pw("admin", "ruledeck-dev") });
    expect(ber.auth.signedInSessions()).toBe(before + 1);
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie, [CSRF_HEADER]: csrf } });
    await new Promise((r) => setTimeout(r, 50));
    expect(ber.auth.signedInSessions()).toBe(before);
    expect((await app.inject({ method: "GET", url: "/api/sites/ber/snapshot", headers: { cookie } })).statusCode).toBe(401);
  });
});

describe("working with a site", () => {
  it("reads a snapshot through the user's firewall session", async () => {
    const { cookie } = await login({ ber: pw("admin", "ruledeck-dev") });
    const res = await app.inject({ method: "GET", url: "/api/sites/ber/snapshot", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().snapshot.rules).toHaveLength(8);
  });

  it("says which site needs a new sign-in when the firewall session ends", async () => {
    const { cookie, csrf } = await login({ ber: pw("admin", "ruledeck-dev") });
    await fetch(`${urlOf(ber)}/__mock/expire-sessions`, { method: "POST" });
    const res = await app.inject({ method: "GET", url: "/api/sites/ber/snapshot", headers: { cookie } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({ kind: "site_signed_out", siteId: "ber" });
    // RuleDeck's own session is still alive; re-auth just that site.
    const again = await app.inject({ method: "POST", url: "/api/auth/sites/ber", headers: { cookie, [CSRF_HEADER]: csrf }, payload: pw("admin", "ruledeck-dev") });
    expect(again.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/sites/ber/snapshot", headers: { cookie: sessionOf(again).cookie } })).statusCode).toBe(200);
  });

  it("applies as the signed-in OPNsense user (shows up in its config history)", async () => {
    const { cookie, csrf } = await login({ ber: pw("admin", "ruledeck-dev") });
    const snap = (await app.inject({ method: "GET", url: "/api/sites/ber/snapshot", headers: { cookie } })).json().snapshot;
    const rules = snap.rules.map((r: { description: string; log: boolean }) => (r.description === "Block DMZ to LAN" ? { ...r, log: true } : r));
    const res = await app.inject({
      method: "POST",
      url: "/api/sites/ber/apply",
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { baseline: snap, current: { rules, aliases: snap.aliases, nextLocalId: 1 }, confirm: true },
    });
    expect(res.json().result.outcome).toBe("success");
    expect(ber.history().length).toBeGreaterThan(0);
    expect(ber.history().every((h) => h.user === "admin")).toBe(true);
  });

  it("reports missing privileges instead of signing the user out", async () => {
    const { cookie, csrf } = await login({ ber: pw("viewer", "viewer-pass") });
    const snap = (await app.inject({ method: "GET", url: "/api/sites/ber/snapshot", headers: { cookie } })).json().snapshot;
    const rules = snap.rules.map((r: { description: string; log: boolean }) => (r.description === "Block DMZ to LAN" ? { ...r, log: true } : r));
    const res = await app.inject({
      method: "POST",
      url: "/api/sites/ber/apply",
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { baseline: snap, current: { rules, aliases: snap.aliases, nextLocalId: 1 }, confirm: true },
    });
    const result = res.json().result;
    expect(result.outcome).toBe("failed");
    expect(result.steps[0].error).toMatch(/missing privilege/);
  });

  it("refuses sites you're not signed in to, and unknown sites", async () => {
    const { cookie } = await login({ ber: pw("admin", "ruledeck-dev") });
    expect((await app.inject({ method: "GET", url: "/api/sites/muc/snapshot", headers: { cookie } })).json().error.kind).toBe("site_signed_out");
    expect((await app.inject({ method: "GET", url: "/api/sites/nope/snapshot", headers: { cookie } })).statusCode).toBe(404);
  });

  it("sets security headers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("helpers", () => {
  it("expires idle sessions and ends their firewall sessions", () => {
    let t = 0;
    const ended: string[] = [];
    const store = new SessionStore(() => t, (s) => ended.push(s.siteId));
    const s = store.create()!;
    s.sites.set("ber", { siteId: "ber" } as never);
    t = IDLE_TIMEOUT_MS - 1;
    expect(store.get(s.id)).toBeDefined();
    t += IDLE_TIMEOUT_MS + 1;
    expect(store.get(s.id)).toBeUndefined();
    expect(ended).toEqual(["ber"]);
    store.close();
  });

  it("resets the rate limit window", () => {
    let t = 0;
    const rl = new RateLimiter(1, 1000, () => t);
    expect(rl.take("a")).toBe(true);
    expect(rl.take("a")).toBe(false);
    t = 1000;
    expect(rl.take("a")).toBe(true);
  });
});

describe("hardening (review findings)", () => {
  async function appWith(over: Partial<AppConfig>, sessions?: SessionStore) {
    const topology = parseTopology(JSON.stringify({ version: 1, sites: [{ id: "ber", name: "Berlin", primary: { url: urlOf(ber) } }] }));
    return buildApp({ config: { production: false, host: "127.0.0.1", port: 0, cookieSecure: false, allowWrites: true, applyRateLimit: 100, siteLoginFailures: 100, topology, ...over }, sessions, logger: false });
  }

  it("caps parallel password guesses (slots are reserved before the attempt)", async () => {
    const a = await appWith({});
    const attempts = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        a.inject({ method: "POST", url: "/api/auth/login", payload: { sites: { ber: pw("admin", `guess-${i}-xx`) } }, remoteAddress: "10.7.7.7" }),
      ),
    );
    const kinds = attempts.map((r) => r.json().siteErrors.ber.kind);
    expect(kinds.filter((k) => k === "invalid_credentials").length).toBeLessThanOrEqual(5);
    expect(kinds.filter((k) => k === "rate_limited").length).toBeGreaterThanOrEqual(7);
    await a.close();
  });

  it("limits failed sign-ins per site across all IPs (stays under OPNsense's lockout)", async () => {
    const a = await appWith({ siteLoginFailures: 2 });
    const kinds: string[] = [];
    for (const ip of ["10.1.1.1", "10.1.1.2", "10.1.1.3"]) {
      const r = await a.inject({ method: "POST", url: "/api/auth/login", payload: { sites: { ber: pw("admin", "wrong-wrong-1") } }, remoteAddress: ip });
      kinds.push(r.json().siteErrors.ber.kind);
    }
    expect(kinds).toEqual(["invalid_credentials", "invalid_credentials", "rate_limited"]);
    await a.close();
  });

  it("doesn't let an encoded path skip authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/%61pi/sites/ber/snapshot" });
    expect(res.statusCode).toBe(401);
    const post = await app.inject({ method: "POST", url: "/%61pi/auth/sites/ber", payload: pw("admin", "ruledeck-dev") });
    expect(post.statusCode).toBe(401);
  });

  it("refuses new sign-ins when full instead of signing other people out", async () => {
    const store = new SessionStore(Date.now, () => {}, 1);
    const a = await appWith({}, store);
    const first = await a.inject({ method: "POST", url: "/api/auth/login", payload: { sites: { ber: pw("admin", "ruledeck-dev") } } });
    const second = await a.inject({ method: "POST", url: "/api/auth/login", payload: { sites: { ber: pw("admin", "ruledeck-dev") } } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(503);
    const cookie = `${SESSION_COOKIE}=${first.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
    expect((await a.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } })).statusCode).toBe(200);
    await a.close();
  });

  it("issues a new session id when a site is added", async () => {
    const { cookie, csrf } = await login({ ber: pw("admin", "ruledeck-dev") });
    const add = await app.inject({ method: "POST", url: "/api/auth/sites/muc", headers: { cookie, [CSRF_HEADER]: csrf }, payload: pw("alice", "alice-pass-1") });
    const fresh = add.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(`${SESSION_COOKIE}=${fresh.value}`).not.toBe(cookie);
    expect(add.json().csrfToken).not.toBe(csrf);
    expect((await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } })).statusCode).toBe(401);
  });

  it("lets a running apply finish when the user signs out meanwhile", async () => {
    const { cookie, csrf } = await login({ ber: pw("admin", "ruledeck-dev") });
    const snap = (await app.inject({ method: "GET", url: "/api/sites/ber/snapshot", headers: { cookie } })).json().snapshot;
    const rules = snap.rules.map((r: { description: string; log: boolean }) => (r.description === "Block DMZ to LAN" ? { ...r, log: true } : r));
    await fetch(`${urlOf(ber)}/__mock/faults`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ match: "firewall/filter/set_rule", type: "slow" }]) });
    const applying = app.inject({
      method: "POST",
      url: "/api/sites/ber/apply",
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { baseline: snap, current: { rules, aliases: snap.aliases, nextLocalId: 1 }, confirm: true },
    });
    await new Promise((r) => setTimeout(r, 150));
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie, [CSRF_HEADER]: csrf } });
    const res = await applying;
    expect(res.json().result.outcome).toBe("success");
  });

  it("ends a site session that arrives after its RuleDeck session is gone", () => {
    const ended: string[] = [];
    const store = new SessionStore(Date.now, (s) => ended.push(s.siteId));
    const s = store.create()!;
    store.destroy(s.id);
    expect(store.attachSite(s, { siteId: "ber" } as never)).toBe(false);
    expect(ended).toEqual(["ber"]);
    store.close();
  });
});

describe("firewall log route", () => {
  it("returns the log of the site's primary, newest first, and only newer lines on request", async () => {
    const { cookie } = await login({ ber: pw("admin", "ruledeck-dev") });
    const first = (await app.inject({ method: "GET", url: "/api/sites/ber/log?limit=5", headers: { cookie } })).json();
    expect(first.entries).toHaveLength(5);
    expect(Object.keys(first.entries[0]).sort()).toEqual(
      ["action", "digest", "dir", "dst", "dstPort", "host", "interface", "ipVersion", "length", "protocol", "reason", "ruleId", "ruleLabel", "src", "srcPort", "tcpFlags", "time"].sort(),
    );
    const none = (await app.inject({ method: "GET", url: `/api/sites/ber/log?digest=${first.entries[0].digest}`, headers: { cookie } })).json();
    expect(none).toEqual({ entries: [], missed: false });
    await fetch(`${urlOf(ber)}/__mock/log`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ src: "198.51.100.7", action: "block" }]) });
    const newer = (await app.inject({ method: "GET", url: `/api/sites/ber/log?digest=${first.entries[0].digest}`, headers: { cookie } })).json();
    expect(newer.entries.map((e: { src: string }) => e.src)).toEqual(["198.51.100.7"]);
  });

  it("validates the query", async () => {
    const { cookie } = await login({ ber: pw("admin", "ruledeck-dev") });
    for (const q of ["limit=0", "limit=99999", "limit=abc", "digest=zzz", "digest=0123", "digest=../../etc"]) {
      expect((await app.inject({ method: "GET", url: `/api/sites/ber/log?${q}`, headers: { cookie } })).statusCode, q).toBe(400);
    }
  });

  it("needs a session and a signed-in site", async () => {
    expect((await app.inject({ method: "GET", url: "/api/sites/ber/log" })).statusCode).toBe(401);
    const { cookie } = await login({ ber: pw("admin", "ruledeck-dev") });
    expect((await app.inject({ method: "GET", url: "/api/sites/muc/log", headers: { cookie } })).json().error.kind).toBe("site_signed_out");
  });

  it("reports a missing privilege to the browser as 'forbidden'", async () => {
    const { cookie } = await login({ ber: pw("nolog", "nolog-pass") }, "10.5.5.5");
    const res = await app.inject({ method: "GET", url: "/api/sites/ber/log", headers: { cookie } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.kind).toBe("forbidden");
  });

  it("asks for a new sign-in when the firewall session ended", async () => {
    const { cookie } = await login({ ber: pw("admin", "ruledeck-dev") }, "10.5.5.6");
    await fetch(`${urlOf(ber)}/__mock/expire-sessions`, { method: "POST" });
    const res = await app.inject({ method: "GET", url: "/api/sites/ber/log", headers: { cookie } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({ kind: "site_signed_out", siteId: "ber" });
  });
});

describe("HA routes", () => {
  const peer = buildMockServer();

  it("shows the CARP state with the switch checks", async () => {
    ber.linkSecondary(peer);
    const { cookie } = await login({ ber: pw("admin", "ruledeck-dev") }, "10.6.6.1");
    const res = await app.inject({ method: "GET", url: "/api/sites/ber/ha", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: "master", peerReachable: true, enter: { allowed: true }, state: { maintenance: false } });
  });

  it("switches over and back, needs CSRF, and refuses without a reachable peer", async () => {
    const { cookie, csrf } = await login({ ber: pw("admin", "ruledeck-dev") }, "10.6.6.2");
    const post = (enter: unknown, withCsrf = true) =>
      app.inject({ method: "POST", url: "/api/sites/ber/ha/switch", headers: { cookie, ...(withCsrf ? { [CSRF_HEADER]: csrf } : {}) }, payload: { enter } });
    expect((await post(true, false)).statusCode).toBe(403);
    expect((await post("yes")).statusCode).toBe(400);

    ber.linkSecondary(null);
    expect((await post(true)).json().result.outcome).toBe("refused");

    ber.linkSecondary(peer);
    expect((await post(true)).json().result).toMatchObject({ outcome: "done", after: { maintenance: true } });
    expect((await post(false)).json().result).toMatchObject({ outcome: "done", after: { maintenance: false } });
  });

  it("is off when writes are disabled, but the state can still be read", async () => {
    const topology = parseTopology(JSON.stringify({ version: 1, sites: [{ id: "ber", name: "Berlin", primary: { url: urlOf(ber) } }] }));
    const ro = await buildApp({ config: { production: false, host: "127.0.0.1", port: 0, cookieSecure: false, allowWrites: false, applyRateLimit: 100, siteLoginFailures: 100, topology }, logger: false });
    const res = await ro.inject({ method: "POST", url: "/api/auth/login", payload: { sites: { ber: pw("admin", "ruledeck-dev") } }, remoteAddress: "10.6.6.3" });
    const cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
    const csrf = res.json().csrfToken as string;
    const sw = await ro.inject({ method: "POST", url: "/api/sites/ber/ha/switch", headers: { cookie, [CSRF_HEADER]: csrf }, payload: { enter: true } });
    expect(sw.statusCode).toBe(403);
    expect(sw.json().error.kind).toBe("writes_disabled");
    expect((await ro.inject({ method: "GET", url: "/api/sites/ber/ha", headers: { cookie } })).statusCode).toBe(200);
    await ro.close();
  });
});

describe("security headers", () => {
  it("are set on every answer", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    for (const h of ["content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy", "cross-origin-opener-policy", "permissions-policy"]) {
      expect(res.headers[h], h).toBeTruthy();
    }
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});
