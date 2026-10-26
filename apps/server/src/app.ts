import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { OpnsenseError } from "@ruledeck/opnsense-client";
import type { AppConfig } from "./config.ts";
import { RateLimiter, safeEqual, SessionStore, track, type Session, type SiteSession } from "./auth.ts";
import { applyServiceToSite, applyToSite, endSiteSession, haSwitchSite, signInError, signInSite, snapshotOf, type SignInError } from "./sites.ts";
import { readHa } from "./ha.ts";
import { publicTopology, type SiteConfig } from "./topology.ts";
import { ApplyRequestSchema, HaSwitchSchema, ServiceApplySchema, SharedRequestSchema } from "./schemas.ts";
import { isNewId, serviceById, type ServiceWc } from "@ruledeck/core";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { sharedApply, sharedPreflight } from "./shared-apply.ts";

export const SESSION_COOKIE = "ruledeck_session";
export const CSRF_HEADER = "x-csrf-token";

declare module "fastify" {
  interface FastifyRequest {
    session?: Session;
  }
}

export interface AppDeps {
  config: AppConfig;
  sessions?: SessionStore;
  logger?: boolean;
}

const SiteLoginSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("password"), username: z.string().min(1).max(256), password: z.string().min(1).max(1024) }),
  z.object({ method: z.literal("apikey"), apiKey: z.string().min(1).max(256), apiSecret: z.string().min(1).max(256) }),
]);
const LoginBody = z.object({ sites: z.record(z.string().max(32), SiteLoginSchema) });
const SiteParams = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/) });
const LogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(2000).default(200),
  /** md5 digest of the newest line the browser already has */
  digest: z.string().regex(/^[0-9a-f]{32}$/).optional(),
});

/** Routes that don't need a session. */
const PUBLIC_ROUTES = new Set(["/api/health", "/api/topology", "/api/auth/login", "/api/auth/session"]);

/** What the browser may know about a signed-in site (no secrets, no cookies). */
function siteView(site: SiteConfig, s: SiteSession | undefined) {
  return {
    id: site.id,
    name: site.name,
    hasSecondary: !!site.secondary,
    signedIn: !!s && s.status === "ok",
    status: s?.status ?? "signed_out",
    user: s?.user ?? null,
    method: s?.method ?? null,
    host: s ? new URL(site.primary.baseUrl).host : null,
    info: s?.info ?? null,
    /** Logical interface -> this site's key/label (from the topology; no secrets). */
    interfaces: s ? (site.interfaces ?? null) : null,
  };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const topology = config.topology;
  const sessions = deps.sessions ?? new SessionStore(Date.now, (s) => void endSiteSession(s));
  // Failed sign-ins: per client and site, and per site for everyone (OPNsense lockout).
  const loginLimiter = new RateLimiter(5, 60_000);
  const siteFailureLimiter = new RateLimiter(config.siteLoginFailures ?? 4, 60 * 60_000);
  const applyLimiter = new RateLimiter(config.applyRateLimit ?? 10, 60_000);
  // Live log polling: generous, but a runaway browser tab must not hammer the firewall.
  const logLimiter = new RateLimiter(120, 60_000);

  const app = Fastify({
    logger:
      deps.logger === false
        ? false
        : {
            level: config.production ? "info" : "debug",
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                `req.headers["${CSRF_HEADER}"]`,
                "res.headers['set-cookie']",
                "body.sites.*.password",
                "body.sites.*.apiKey",
                "body.sites.*.apiSecret",
              ],
              censor: "[redacted]",
            },
          },
    bodyLimit: 1024 * 1024,
    trustProxy: config.trustProxy ?? false,
  });

  await app.register(cookie);

  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("cross-origin-resource-policy", "same-origin");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(), usb=(), payment=()");
    // Only when served over HTTPS (secure cookies): tell browsers to keep using HTTPS.
    if (config.cookieSecure) reply.header("strict-transport-security", "max-age=31536000");
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  });

  // Authentication + CSRF for every API route. Decided by the matched route
  // pattern, not the raw URL, so encoded paths (/%61pi/...) can't skip it.
  app.addHook("preHandler", async (req, reply) => {
    const route = req.routeOptions.url;
    if (!route || !route.startsWith("/api/")) return;
    req.session = sessions.get(req.cookies[SESSION_COOKIE]);
    if (PUBLIC_ROUTES.has(route)) return;
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
    reply.setCookie(SESSION_COOKIE, value, { httpOnly: true, sameSite: "strict", secure: config.cookieSecure, path: "/", maxAge: maxAgeSeconds });

  const sessionView = (s: Session) => ({
    csrfToken: s.csrfToken,
    topologyHash: topology.hash,
    sites: topology.sites.map((site) => siteView(site, s.sites.get(site.id))),
  });

  /**
   * Sign in to several sites in parallel. Attempt slots are reserved BEFORE
   * talking to the firewall (so parallel requests can't bypass the limits) and
   * given back when the attempt didn't fail on credentials.
   */
  async function signInMany(ip: string, logins: Record<string, z.infer<typeof SiteLoginSchema>>) {
    const results: Record<string, { ok: true; session: SiteSession } | { ok: false; error: SignInError }> = {};
    await Promise.all(
      Object.entries(logins).map(async ([siteId, login]) => {
        const site = topology.sites.find((s) => s.id === siteId);
        if (!site) {
          results[siteId] = { ok: false, error: { kind: "not_found", message: "Unknown site." } };
          return;
        }
        const clientKey = `${ip}|${siteId}`;
        const guarded = login.method === "password";
        if (!loginLimiter.take(clientKey)) {
          loginLimiter.refund(clientKey);
          results[siteId] = { ok: false, error: { kind: "rate_limited", message: "Too many failed sign-ins. Try again in a minute." } };
          return;
        }
        if (guarded && !siteFailureLimiter.take(siteId)) {
          siteFailureLimiter.refund(siteId);
          loginLimiter.refund(clientKey);
          results[siteId] = {
            ok: false,
            error: {
              kind: "rate_limited",
              message: `Too many failed sign-ins to ${site.name} through RuleDeck in the last hour. Waiting protects RuleDeck's address from the firewall's login lockout.`,
            },
          };
          return;
        }
        try {
          results[siteId] = { ok: true, session: await signInSite(site, login) };
          loginLimiter.refund(clientKey);
          if (guarded) siteFailureLimiter.refund(siteId);
        } catch (err) {
          const error = signInError(err);
          if (error.kind !== "invalid_credentials") {
            // Network/TLS/privilege problems aren't guesses; don't count them.
            loginLimiter.refund(clientKey);
            if (guarded) siteFailureLimiter.refund(siteId);
          }
          results[siteId] = { ok: false, error };
        }
      }),
    );
    return results;
  }

  // ------------------------------------------------------------------ auth
  app.get("/api/health", async () => ({ status: "ok" }));
  app.get("/api/topology", async (req) => publicTopology(topology, !!req.session));

  app.post("/api/auth/login", async (req, reply) => {
    const body = LoginBody.safeParse(req.body);
    if (!body.success || Object.keys(body.data.sites).length === 0) {
      return reply.code(400).send({ error: { kind: "bad_request", message: "Enter credentials for at least one site." } });
    }
    const results = await signInMany(req.ip, body.data.sites);
    const ok = Object.values(results).filter((r) => r.ok);
    const errors = Object.fromEntries(Object.entries(results).flatMap(([id, r]) => (r.ok ? [] : [[id, r.error]])));
    if (!ok.length) return reply.code(401).send({ error: { kind: "invalid_credentials", message: "Sign-in failed for every site." }, siteErrors: errors });
    sessions.destroy(req.cookies[SESSION_COOKIE]);
    const s = sessions.create();
    if (!s) {
      for (const r of ok) if (r.ok) void endSiteSession(r.session);
      return reply.code(503).send({ error: { kind: "busy", message: "Too many people are signed in to RuleDeck right now. Try again later." } });
    }
    for (const r of ok) if (r.ok) s.sites.set(r.session.siteId, r.session);
    setSessionCookie(reply, s.id, 8 * 60 * 60);
    req.log.info({ event: "sign_in", sites: ok.map((r) => (r.ok ? `${r.session.siteId}:${r.session.user}` : "")) }, "signed in");
    return { ...sessionView(s), siteErrors: errors };
  });

  app.get("/api/auth/session", async (req, reply) => {
    if (!req.session) return reply.code(401).send({ error: { kind: "unauthenticated", message: "Please sign in." } });
    return sessionView(req.session);
  });

  /** Sign in to one more site, or again after the firewall session ended. */
  app.post("/api/auth/sites/:id", async (req, reply) => {
    const p = SiteParams.safeParse(req.params);
    const login = SiteLoginSchema.safeParse(req.body);
    if (!p.success || !login.success) return reply.code(400).send({ error: { kind: "bad_request", message: "Invalid sign-in." } });
    const r = (await signInMany(req.ip, { [p.data.id]: login.data }))[p.data.id]!;
    if (!r.ok) return reply.code(401).send({ error: r.error });
    // The RuleDeck session may have ended while we were signing in.
    if (!sessions.attachSite(req.session!, r.session)) {
      return reply.code(401).send({ error: { kind: "unauthenticated", message: "Your RuleDeck session ended. Please sign in." } });
    }
    // More privileges now: issue a fresh session id (no session fixation).
    sessions.rotate(req.session!);
    setSessionCookie(reply, req.session!.id, 8 * 60 * 60);
    return sessionView(req.session!);
  });

  app.post("/api/auth/sites/:id/logout", async (req, reply) => {
    const p = SiteParams.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: { kind: "bad_request", message: "Invalid site." } });
    sessions.endSite(req.session!, p.data.id);
    return sessionView(req.session!);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    sessions.destroy(req.session?.id);
    setSessionCookie(reply, "", 0);
    return { status: "ok" };
  });

  // ------------------------------------------------------------------ sites
  /** The signed-in site session for this request, or an error response. */
  const siteFor = (req: FastifyRequest, reply: FastifyReply): SiteSession | null => {
    const p = SiteParams.safeParse(req.params);
    if (!p.success || !topology.sites.some((s) => s.id === p.data.id)) {
      reply.code(404).send({ error: { kind: "not_found", message: "Unknown site." } });
      return null;
    }
    const s = req.session!.sites.get(p.data.id);
    if (!s || s.status !== "ok") {
      reply.code(401).send({ error: { kind: "site_signed_out", siteId: p.data.id, message: "You're not signed in to this site." } });
      return null;
    }
    return s;
  };

  /** Run a firewall call; if the firewall session ended, mark the site signed out. */
  async function withSite<T>(s: SiteSession, reply: FastifyReply, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof OpnsenseError && err.kind === "auth") {
        s.status = "signed_out";
        reply.code(401).send({ error: { kind: "site_signed_out", siteId: s.siteId, message: "Your session on this firewall ended. Sign in again." } });
        return undefined;
      }
      throw err;
    }
  }

  app.post("/api/sites/:id/connect", async (req, reply) => {
    const s = siteFor(req, reply);
    if (!s) return;
    const r = await withSite(s, reply, () => s.client.probe());
    if (!r) return;
    return { site: siteView(topology.sites.find((x) => x.id === s.siteId)!, s) };
  });

  app.get("/api/sites/:id/snapshot", async (req, reply) => {
    const s = siteFor(req, reply);
    if (!s) return;
    const snapshot = await withSite(s, reply, () => snapshotOf(s));
    if (!snapshot) return;
    return { snapshot };
  });

  /** Firewall log of the site's primary (read-only), newest first. Pass `digest` to get only newer lines. */
  app.get("/api/sites/:id/log", async (req, reply) => {
    const s = siteFor(req, reply);
    if (!s) return;
    const q = LogQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: { kind: "bad_request", message: "Invalid log request." } });
    if (!logLimiter.take(req.session!.id)) {
      return reply.code(429).send({ error: { kind: "rate_limited", message: "Reading the log too often. Slow down." } });
    }
    const result = await withSite(s, reply, () => track(s, () => s.client.readFirewallLog({ limit: q.data.limit, sinceDigest: q.data.digest })));
    if (!result) return;
    return result;
  });

  /** Certificates and CAs of the site (expiry overview). Only whitelisted fields; the firewall's list also contains private keys. */
  app.get("/api/sites/:id/certificates", async (req, reply) => {
    const s = siteFor(req, reply);
    if (!s) return;
    const certs = await withSite(s, reply, () => track(s, () => s.client.listCertificates()));
    if (!certs) return;
    return { certificates: certs };
  });

  /** One service (settings and tables) as flat maps; secret fields are empty. */
  app.get("/api/sites/:id/services/:svc", async (req, reply) => {
    const s = siteFor(req, reply);
    if (!s) return;
    const def = serviceById((req.params as { svc: string }).svc);
    if (!def) return reply.code(404).send({ error: { kind: "not_found", message: "Unknown service." } });
    const snapshot = await withSite(s, reply, () => track(s, () => s.client.readServiceSnapshot(def, s.siteId)));
    if (!snapshot) return;
    return { snapshot, readOnly: !!def.readOnly };
  });

  app.post("/api/sites/:id/services/:svc/apply", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const s = siteFor(req, reply);
    if (!s) return;
    const def = serviceById((req.params as { svc: string }).svc);
    if (!def) return reply.code(404).send({ error: { kind: "not_found", message: "Unknown service." } });
    if (!applyLimiter.take(req.session!.id)) {
      return reply.code(429).send({ error: { kind: "rate_limited", message: "Too many changes. Wait a minute." } });
    }
    if (!config.allowWrites || def.readOnly) {
      return reply.code(403).send({
        error: { kind: "writes_disabled", message: def.readOnly ? `${def.label} is read-only in RuleDeck.` : "Sending changes to firewalls is disabled on this server (RULEDECK_ALLOW_WRITES is not true)." },
      });
    }
    const body = ServiceApplySchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: { kind: "bad_request", message: "Invalid change set: " + body.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ") } });
    }
    const { baseline, current } = body.data;
    if (baseline.siteId !== s.siteId || baseline.serviceId !== def.id) {
      return reply.code(400).send({ error: { kind: "bad_request", message: "The changes were made for a different site or service." } });
    }
    const known = new Set(def.grids.map((g) => g.id));
    for (const gid of [...Object.keys(baseline.grids), ...Object.keys(current.grids)]) {
      if (!known.has(gid)) return reply.code(400).send({ error: { kind: "bad_request", message: `Unknown table "${gid}".` } });
    }
    for (const rows of Object.values(current.grids)) {
      for (const r of rows) {
        if (!isNewId(r.id) && !UUID_RE.test(r.id)) return reply.code(400).send({ error: { kind: "bad_request", message: "Invalid entry id." } });
      }
    }
    const wc = { baseline: { ...baseline, options: {}, defaults: {} } as ServiceWc["baseline"], settings: current.settings, grids: current.grids } as ServiceWc;
    const result = await withSite(s, reply, () => applyServiceToSite(s, def, wc));
    if (!result) return;
    // Counts only: change contents can include secrets.
    req.log.info({ event: "service_apply", site: s.siteId, service: def.id, user: s.user, outcome: result.outcome, writes: `${result.state.written}/${result.state.totalWrites}`, verified: result.state.verified }, "service apply finished");
    return { result };
  });

  /** HA state of the site's primary node (CARP VIPs, maintenance mode, peer reachable) with the switch checks. */
  app.get("/api/sites/:id/ha", async (req, reply) => {
    const s = siteFor(req, reply);
    if (!s) return;
    const view = await withSite(s, reply, () => track(s, () => readHa(s.client)));
    if (!view) return;
    return view;
  });

  /** Graceful switchover: enter or leave CARP maintenance mode on the primary node. Sent at most once. */
  app.post("/api/sites/:id/ha/switch", async (req, reply) => {
    const s = siteFor(req, reply);
    if (!s) return;
    if (!applyLimiter.take(req.session!.id)) {
      return reply.code(429).send({ error: { kind: "rate_limited", message: "Too many changes. Wait a minute." } });
    }
    if (!config.allowWrites) {
      return reply.code(403).send({
        error: { kind: "writes_disabled", message: "Changing firewalls is disabled on this server (RULEDECK_ALLOW_WRITES is not true)." },
      });
    }
    const body = HaSwitchSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { kind: "bad_request", message: "Say whether to enter or leave maintenance mode." } });
    const result = await withSite(s, reply, () => haSwitchSite(s, body.data.enter));
    if (!result) return;
    req.log.info({ event: "ha_switch", site: s.siteId, user: s.user, enter: result.enter, outcome: result.outcome }, "ha switch finished");
    return { result };
  });

  app.post("/api/sites/:id/apply", { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    const s = siteFor(req, reply);
    if (!s) return;
    if (!applyLimiter.take(req.session!.id)) {
      return reply.code(429).send({ error: { kind: "rate_limited", message: "Too many apply attempts. Wait a minute." } });
    }
    if (!config.allowWrites) {
      return reply.code(403).send({
        error: { kind: "writes_disabled", message: "Sending changes to firewalls is disabled on this server (RULEDECK_ALLOW_WRITES is not true)." },
      });
    }
    const body = ApplyRequestSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({
        error: { kind: "bad_request", message: "Invalid change set: " + body.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ") },
      });
    }
    if (body.data.baseline.firewallId !== s.siteId) {
      return reply.code(400).send({ error: { kind: "bad_request", message: "The changes were made for a different site." } });
    }
    const f = s.info.features;
    if (!f.rulesWrite || !f.aliasesWrite) {
      return reply.code(403).send({ error: { kind: "unsupported", message: f.notes[0] ?? "Editing is not supported for this firewall version." } });
    }
    const wc = { baseline: body.data.baseline, current: body.data.current, past: [], future: [] };
    const result = await withSite(s, reply, () => applyToSite(s, wc, { acknowledgeRisks: body.data.acknowledgeRisks }));
    if (!result) return;
    // One line per apply for the operator's logs. The real audit trail is the
    // firewall's own config history, which records the OPNsense user.
    req.log.info(
      {
        event: "apply",
        site: s.siteId,
        user: s.user,
        outcome: result.outcome,
        writes: `${result.state.written}/${result.state.totalWrites}`,
        activated: result.state.activated,
        verified: result.state.verified,
      },
      "apply finished",
    );
    return { result };
  });

  // ------------------------------------------------------- shared (multi-site)
  const parseShared = (req: FastifyRequest, reply: FastifyReply) => {
    const body = SharedRequestSchema.safeParse(req.body);
    if (!body.success) {
      reply.code(400).send({
        error: { kind: "bad_request", message: "Invalid shared change set: " + body.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ") },
      });
      return null;
    }
    return body.data;
  };

  app.post("/api/shared/preflight", { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
    const body = parseShared(req, reply);
    if (!body) return;
    return { plans: await sharedPreflight(topology, req.session!, body) };
  });

  app.post("/api/shared/apply", { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
    if (!applyLimiter.take(req.session!.id)) {
      return reply.code(429).send({ error: { kind: "rate_limited", message: "Too many apply attempts. Wait a minute." } });
    }
    if (!config.allowWrites) {
      return reply.code(403).send({ error: { kind: "writes_disabled", message: "Sending changes to firewalls is disabled on this server (RULEDECK_ALLOW_WRITES is not true)." } });
    }
    const body = parseShared(req, reply);
    if (!body) return;
    if (body.confirm !== true) return reply.code(400).send({ error: { kind: "bad_request", message: "Confirmation missing." } });
    const result = await sharedApply(topology, req.session!, body);
    req.log.info(
      { event: "shared_apply", outcome: result.outcome, sites: result.sites.map((s) => `${s.siteId}:${s.status}${s.ha ? `/ha:${s.ha.step}` : ""}`) },
      "shared apply finished",
    );
    return { result };
  });

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
    sessions.close();
  });

  return app;
}
