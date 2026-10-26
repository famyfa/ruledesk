import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SiteSession } from "../auth.ts";
import { endSiteSession, signInError, signInSite, type SignInError } from "../sites.ts";
import { publicTopology } from "../topology.ts";
import { SESSION_COOKIE, SiteParams, type RouteContext } from "./context.ts";

/** Sign-in with OPNsense accounts, the RuleDeck session, health and the public topology. */

/** RuleDeck's version (root package.json), shown in the UI. */
const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

const SiteLoginSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("password"), username: z.string().min(1).max(256), password: z.string().min(1).max(1024) }),
  z.object({ method: z.literal("apikey"), apiKey: z.string().min(1).max(256), apiSecret: z.string().min(1).max(256) }),
]);
const LoginBody = z.object({ sites: z.record(z.string().max(32), SiteLoginSchema) });

export function authRoutes(app: FastifyInstance, ctx: RouteContext) {
  const { topology, sessions, limiters } = ctx;

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
        if (!limiters.login.take(clientKey)) {
          limiters.login.refund(clientKey);
          results[siteId] = { ok: false, error: { kind: "rate_limited", message: "Too many failed sign-ins. Try again in a minute." } };
          return;
        }
        if (guarded && !limiters.siteFailures.take(siteId)) {
          limiters.siteFailures.refund(siteId);
          limiters.login.refund(clientKey);
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
          limiters.login.refund(clientKey);
          if (guarded) limiters.siteFailures.refund(siteId);
        } catch (err) {
          const error = signInError(err);
          if (error.kind !== "invalid_credentials") {
            // Network/TLS/privilege problems aren't guesses; don't count them.
            limiters.login.refund(clientKey);
            if (guarded) limiters.siteFailures.refund(siteId);
          }
          results[siteId] = { ok: false, error };
        }
      }),
    );
    return results;
  }

  app.get("/api/health", async () => ({ status: "ok", version: VERSION }));
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
    ctx.setSessionCookie(reply, s.id);
    req.log.info({ event: "sign_in", sites: ok.map((r) => (r.ok ? `${r.session.siteId}:${r.session.user}` : "")) }, "signed in");
    return { ...ctx.sessionView(s), siteErrors: errors };
  });

  app.get("/api/auth/session", async (req, reply) => {
    if (!req.session) return reply.code(401).send({ error: { kind: "unauthenticated", message: "Please sign in." } });
    return ctx.sessionView(req.session);
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
    ctx.setSessionCookie(reply, req.session!.id);
    return ctx.sessionView(req.session!);
  });

  app.post("/api/auth/sites/:id/logout", async (req, reply) => {
    const p = SiteParams.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: { kind: "bad_request", message: "Invalid site." } });
    sessions.endSite(req.session!, p.data.id);
    return ctx.sessionView(req.session!);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    sessions.destroy(req.session?.id);
    ctx.setSessionCookie(reply, "", 0);
    return { status: "ok" };
  });
}
