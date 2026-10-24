import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { OpnsenseError } from "@ruledeck/opnsense-client";
import type { AppConfig } from "./config.ts";
import { RateLimiter, safeEqual, SessionStore, verifyPassword, type Session } from "./auth.ts";
import { AuditLog } from "./audit.ts";
import { FirewallRegistry } from "./firewalls.ts";
import { ApplyRequestSchema } from "./schemas.ts";

export const SESSION_COOKIE = "ruledeck_session";
export const CSRF_HEADER = "x-csrf-token";

declare module "fastify" {
  interface FastifyRequest {
    session?: Session;
  }
}

export interface AppDeps {
  config: AppConfig;
  audit?: AuditLog;
  registry?: FirewallRegistry;
  sessions?: SessionStore;
  logger?: boolean;
}

const LoginBody = z.object({ username: z.string().min(1).max(128), password: z.string().min(1).max(1024) });
const FirewallParams = z.object({ id: z.string().regex(/^[a-z0-9_-]{1,32}$/) });

/** Routes that don't need a session. */
const PUBLIC_ROUTES = new Set(["/api/health", "/api/auth/login", "/api/auth/session"]);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const audit = deps.audit ?? new AuditLog(config.dataDir);
  const registry = deps.registry ?? new FirewallRegistry(config.firewalls);
  const sessions = deps.sessions ?? new SessionStore();
  const loginLimiter = new RateLimiter(5, 60_000);
  const applyLimiter = new RateLimiter(config.applyRateLimit ?? 10, 60_000);

  const app = Fastify({
    logger:
      deps.logger === false
        ? false
        : {
            level: config.production ? "info" : "debug",
            redact: ["req.headers.authorization", "req.headers.cookie", `req.headers["${CSRF_HEADER}"]`, "res.headers['set-cookie']"],
          },
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });

  await app.register(cookie);

  // Basic hardening headers for API and static responses.
  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  });

  // Authentication + CSRF for everything under /api.
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    const path = req.url.split("?")[0]!;
    req.session = sessions.get(req.cookies[SESSION_COOKIE]);
    if (PUBLIC_ROUTES.has(path)) return;
    if (!req.session) {
      return reply.code(401).send({ error: { kind: "unauthenticated", message: "Please sign in." } });
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      const token = req.headers[CSRF_HEADER];
      if (typeof token !== "string" || !safeEqual(token, req.session.csrfToken)) {
        return reply.code(403).send({ error: { kind: "csrf", message: "Missing or invalid CSRF token." } });
      }
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof OpnsenseError) {
      return reply.code(502).send({ error: err.toJSON() });
    }
    const e = err as { validation?: unknown; statusCode?: number; message?: string };
    if (e.validation || e.statusCode === 400) {
      return reply.code(400).send({ error: { kind: "bad_request", message: e.message ?? "Bad request." } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { kind: "internal", message: "Internal error." } });
  });

  const setSessionCookie = (reply: FastifyReply, value: string, maxAgeSeconds: number) =>
    reply.setCookie(SESSION_COOKIE, value, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.cookieSecure,
      path: "/",
      maxAge: maxAgeSeconds,
    });

  // ------------------------------------------------------------------ auth
  app.get("/api/health", async () => ({ status: "ok" }));

  app.post("/api/auth/login", async (req, reply) => {
    // Only failed attempts count towards the limit.
    if (loginLimiter.isLimited(req.ip)) {
      return reply.code(429).send({ error: { kind: "rate_limited", message: "Too many login attempts. Try again in a minute." } });
    }
    const body = LoginBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { kind: "bad_request", message: "Username and password are required." } });
    const userOk = safeEqual(body.data.username, config.adminUser);
    const pwOk = await verifyPassword(body.data.password, config.adminPasswordHash);
    if (!userOk || !pwOk) {
      loginLimiter.take(req.ip);
      audit.record({ user: body.data.username.slice(0, 64), action: "auth.login", firewallId: null, outcome: "failure", details: { ip: req.ip } });
      return reply.code(401).send({ error: { kind: "invalid_credentials", message: "Wrong username or password." } });
    }
    sessions.destroy(req.cookies[SESSION_COOKIE]);
    const s = sessions.create(config.adminUser);
    setSessionCookie(reply, s.id, 12 * 60 * 60);
    audit.record({ user: s.user, action: "auth.login", firewallId: null, outcome: "success", details: { ip: req.ip } });
    return { user: s.user, csrfToken: s.csrfToken };
  });

  app.get("/api/auth/session", async (req, reply) => {
    if (!req.session) return reply.code(401).send({ error: { kind: "unauthenticated", message: "Please sign in." } });
    return { user: req.session.user, csrfToken: req.session.csrfToken };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    sessions.destroy(req.session?.id);
    setSessionCookie(reply, "", 0);
    return { status: "ok" };
  });

  // ------------------------------------------------------------- firewalls
  const firewallId = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const p = FirewallParams.safeParse(req.params);
    if (!p.success || !registry.has(p.data.id)) {
      reply.code(404).send({ error: { kind: "not_found", message: "Unknown firewall." } });
      return null;
    }
    return p.data.id;
  };

  app.get("/api/firewalls", async () => ({ firewalls: registry.list() }));

  app.post("/api/firewalls/:id/connect", async (req, reply) => {
    const id = firewallId(req, reply);
    if (!id) return;
    return { state: await registry.connect(id) };
  });

  app.get("/api/firewalls/:id/snapshot", async (req, reply) => {
    const id = firewallId(req, reply);
    if (!id) return;
    return { snapshot: await registry.snapshot(id) };
  });

  app.post("/api/firewalls/:id/apply", { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    const id = firewallId(req, reply);
    if (!id) return;
    const user = req.session!.user;
    if (!applyLimiter.take(user)) {
      return reply.code(429).send({ error: { kind: "rate_limited", message: "Too many apply attempts. Wait a minute." } });
    }
    if (!config.allowWrites) {
      return reply.code(403).send({
        error: { kind: "writes_disabled", message: "Sending changes to firewalls is disabled on this server (RULEDECK_ALLOW_WRITES is not true)." },
      });
    }
    const body = ApplyRequestSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: { kind: "bad_request", message: "Invalid change set: " + body.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ") } });
    }
    if (body.data.baseline.firewallId !== id) {
      return reply.code(400).send({ error: { kind: "bad_request", message: "The changes were made for a different firewall." } });
    }
    const conn = await registry.ensureConnected(id);
    if (conn.status !== "connected") return reply.code(502).send({ error: { kind: "network", message: "The firewall is not reachable." } });
    const f = conn.info.features;
    if (!f.rulesWrite || !f.aliasesWrite) {
      return reply.code(403).send({ error: { kind: "unsupported", message: f.notes[0] ?? "Editing is not supported for this firewall version." } });
    }

    const wc = { baseline: body.data.baseline, current: body.data.current, past: [], future: [] };
    let result;
    try {
      result = await registry.apply(id, wc, { acknowledgeRisks: body.data.acknowledgeRisks });
    } catch (err) {
      audit.record({ user, action: "firewall.apply", firewallId: id, outcome: "failure", details: { error: err instanceof Error ? err.message : "error" } });
      throw err;
    }
    audit.record({
      user,
      action: "firewall.apply",
      firewallId: id,
      outcome: result.outcome === "success" ? "success" : result.state.written > 0 ? "partial" : "failure",
      details: {
        outcome: result.outcome,
        writes: `${result.state.written}/${result.state.totalWrites}`,
        activated: result.state.activated,
        verified: result.state.verified,
        conflicts: result.conflicts?.length ?? 0,
        steps: result.steps.map((s) => `${s.status}: ${s.label}`),
        problems: result.verificationProblems,
      },
    });
    return { result };
  });

  app.get("/api/audit", async () => ({ events: audit.list() }));

  // ------------------------------------------------------- static web app
  const webDist = config.webDist ? resolve(config.webDist) : undefined;
  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: { kind: "not_found", message: "Not found." } });
      return reply.sendFile("index.html");
    });
  }

  app.addHook("onClose", async () => {
    await registry.close();
    audit.close();
  });

  return app;
}
