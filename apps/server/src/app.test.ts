import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildMockServer, type MockServer } from "../../mock-opnsense/src/server.ts";
import { buildApp, CSRF_HEADER, SESSION_COOKIE } from "./app.ts";
import { hashPassword, SessionStore, RateLimiter, IDLE_TIMEOUT_MS } from "./auth.ts";
import { AuditLog } from "./audit.ts";
import { loadConfig, ConfigError, type AppConfig } from "./config.ts";

const SECRET = "super-secret-value-123";
let mock: MockServer;
let app: FastifyInstance;
let audit: AuditLog;

beforeAll(async () => {
  mock = buildMockServer({ apiKey: "k1", apiSecret: SECRET });
  await mock.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = mock.app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  const config: AppConfig = {
    production: false,
    host: "127.0.0.1",
    port: 0,
    dataDir: ":memory:",
    adminUser: "admin",
    adminPasswordHash: await hashPassword("correct horse battery"),
    cookieSecure: false,
    firewalls: [{ id: "default", name: "Mock", baseUrl: `http://127.0.0.1:${addr.port}`, apiKey: "k1", apiSecret: SECRET, timeoutMs: 5000 }],
  };
  audit = new AuditLog(":memory:");
  app = await buildApp({ config, audit, logger: false });
});

afterAll(async () => {
  await app.close();
  await mock.app.close();
});

async function login(password = "correct horse battery", ip = "10.0.0.1") {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password }, remoteAddress: ip });
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  return { res, cookie: cookie ? `${SESSION_COOKIE}=${cookie.value}` : "", csrf: res.json().csrfToken as string };
}

describe("authentication", () => {
  it("rejects API calls without a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/firewalls" });
    expect(res.statusCode).toBe(401);
  });

  it("logs in and sets a hardened cookie", async () => {
    const { res } = await login();
    expect(res.statusCode).toBe(200);
    const c = res.cookies.find((x) => x.name === SESSION_COOKIE)!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe("Strict");
    expect(res.json().csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it("rejects wrong passwords and records the failure", async () => {
    const { res } = await login("wrong password", "10.0.0.2");
    expect(res.statusCode).toBe(401);
    expect(audit.list().some((e) => e.action === "auth.login" && e.outcome === "failure")).toBe(true);
  });

  it("rate-limits login attempts per IP", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await login("nope nope nope", "10.9.9.9")).res.statusCode);
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it("requires the CSRF token on state-changing requests", async () => {
    const { cookie, csrf } = await login(undefined, "10.0.0.3");
    const without = await app.inject({ method: "POST", url: "/api/firewalls/default/connect", headers: { cookie } });
    expect(without.statusCode).toBe(403);
    const wrong = await app.inject({ method: "POST", url: "/api/firewalls/default/connect", headers: { cookie, [CSRF_HEADER]: "x".repeat(43) } });
    expect(wrong.statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", url: "/api/firewalls/default/connect", headers: { cookie, [CSRF_HEADER]: csrf } });
    expect(ok.statusCode).toBe(200);
  });

  it("ends the session on logout", async () => {
    const { cookie, csrf } = await login(undefined, "10.0.0.4");
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie, [CSRF_HEADER]: csrf } });
    const res = await app.inject({ method: "GET", url: "/api/firewalls", headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });
});

describe("firewall endpoints", () => {
  it("connects, detects version and features", async () => {
    const { cookie, csrf } = await login(undefined, "10.0.1.1");
    const res = await app.inject({ method: "POST", url: "/api/firewalls/default/connect", headers: { cookie, [CSRF_HEADER]: csrf } });
    const state = res.json().state;
    expect(state.status).toBe("connected");
    expect(state.info.productVersion).toBe("26.7.7");
    expect(state.info.features.rulesWrite).toBe(true);
    expect(state.info.features.rollbackTimer).toBe(false);
  });

  it("returns a normalized snapshot", async () => {
    const { cookie } = await login(undefined, "10.0.1.2");
    const res = await app.inject({ method: "GET", url: "/api/firewalls/default/snapshot", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const snap = res.json().snapshot;
    expect(snap.rules).toHaveLength(8);
    expect(snap.aliases).toHaveLength(3);
  });

  it("returns 404 for unknown firewalls", async () => {
    const { cookie } = await login(undefined, "10.0.1.3");
    const res = await app.inject({ method: "GET", url: "/api/firewalls/nope/snapshot", headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });

  it("maps firewall errors to 502 with a safe message", async () => {
    const { cookie } = await login(undefined, "10.0.1.4");
    const addr = mock.app.server.address() as { port: number };
    await fetch(`http://127.0.0.1:${addr.port}/__mock/faults`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ match: "firewall/filter/search_rule", type: "http500" }]) });
    const res = await app.inject({ method: "GET", url: "/api/firewalls/default/snapshot", headers: { cookie } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.kind).toBe("server");
  });

  it("never sends the API secret or key to the browser", async () => {
    const { cookie, csrf } = await login(undefined, "10.0.1.5");
    const bodies = await Promise.all([
      app.inject({ method: "GET", url: "/api/firewalls", headers: { cookie } }),
      app.inject({ method: "POST", url: "/api/firewalls/default/connect", headers: { cookie, [CSRF_HEADER]: csrf } }),
      app.inject({ method: "GET", url: "/api/firewalls/default/snapshot", headers: { cookie } }),
      app.inject({ method: "GET", url: "/api/audit", headers: { cookie } }),
    ]);
    const basic = Buffer.from(`k1:${SECRET}`).toString("base64");
    for (const b of bodies) {
      expect(b.body).not.toContain(SECRET);
      expect(b.body).not.toContain(basic);
    }
  });

  it("sets security headers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });
});

describe("helpers", () => {
  it("expires idle sessions", () => {
    let t = 0;
    const store = new SessionStore(() => t);
    const s = store.create("admin");
    t = IDLE_TIMEOUT_MS - 1;
    expect(store.get(s.id)).toBeDefined();
    t += IDLE_TIMEOUT_MS + 1;
    expect(store.get(s.id)).toBeUndefined();
  });

  it("resets the rate limit window", () => {
    let t = 0;
    const rl = new RateLimiter(1, 1000, () => t);
    expect(rl.take("a")).toBe(true);
    expect(rl.take("a")).toBe(false);
    t = 1000;
    expect(rl.take("a")).toBe(true);
  });

  it("validates configuration", () => {
    const base = { RULEDECK_ADMIN_PASSWORD_HASH: "scrypt$a$b" };
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, OPNSENSE_URL: "http://fw.lan", OPNSENSE_API_KEY: "k", OPNSENSE_API_SECRET: "s" })).toThrow(/https/);
    expect(() => loadConfig({ ...base, OPNSENSE_URL: "https://fw.lan" })).toThrow(/API_KEY/);
    const cfg = loadConfig({ ...base, NODE_ENV: "production", OPNSENSE_URL: "https://fw.lan", OPNSENSE_API_KEY: "k", OPNSENSE_API_SECRET: "s" });
    expect(cfg.cookieSecure).toBe(true);
    expect(cfg.firewalls).toHaveLength(1);
  });
});
