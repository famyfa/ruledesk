import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { OpnsenseError } from "@ruledeck/opnsense-client";
import type { AppConfig } from "../config.ts";
import { RateLimiter, type Session, type SessionStore, type SiteSession } from "../auth.ts";
import type { SiteConfig, Topology } from "../topology.ts";

/**
 * What every route module needs: configuration, the session store, rate limiters
 * and a few helpers that keep the handlers short and their answers consistent.
 */

export const SESSION_COOKIE = "ruledeck_session";
export const CSRF_HEADER = "x-csrf-token";
const SESSION_MAX_AGE_S = 8 * 60 * 60;

export const SiteParams = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/) });

export interface RouteContext {
  config: AppConfig;
  topology: Topology;
  sessions: SessionStore;
  limiters: {
    /** Failed sign-ins per client and site. */
    login: RateLimiter;
    /** Failed password sign-ins per site for everyone (OPNsense lockout). */
    siteFailures: RateLimiter;
    /** Anything that changes a firewall, per session. */
    apply: RateLimiter;
    /** Live log polling, per session. */
    log: RateLimiter;
  };
  /** The signed-in site session for this request, or null after answering 404/401. */
  siteFor: (req: FastifyRequest, reply: FastifyReply) => SiteSession | null;
  /** Run a firewall call; if the firewall session ended, mark the site signed out and answer 401. */
  withSite: <T>(s: SiteSession, reply: FastifyReply, fn: () => Promise<T>) => Promise<T | undefined>;
  /** Count one change attempt; answers 429 and returns false when over the limit. */
  allowChange: (req: FastifyRequest, reply: FastifyReply, message?: string) => boolean;
  /** Answers 403 and returns false when writes are switched off (or `readOnlyReason` is given). */
  writesAllowed: (reply: FastifyReply, readOnlyReason?: string) => boolean;
  /** 400 with the first few zod issues. */
  invalid: (reply: FastifyReply, what: string, error: z.ZodError) => void;
  siteView: (site: SiteConfig, s: SiteSession | undefined) => ReturnType<typeof siteView>;
  sessionView: (s: Session) => ReturnType<typeof sessionView>;
  setSessionCookie: (reply: FastifyReply, value: string, maxAgeSeconds?: number) => void;
}

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

function sessionView(topology: Topology, s: Session) {
  return {
    csrfToken: s.csrfToken,
    topologyHash: topology.hash,
    sites: topology.sites.map((site) => siteView(site, s.sites.get(site.id))),
  };
}

export function createContext(config: AppConfig, sessions: SessionStore): RouteContext {
  const topology = config.topology;
  const limiters = {
    login: new RateLimiter(5, 60_000),
    siteFailures: new RateLimiter(config.siteLoginFailures ?? 4, 60 * 60_000),
    apply: new RateLimiter(config.applyRateLimit ?? 10, 60_000),
    // Generous, but a runaway browser tab must not hammer the firewall.
    log: new RateLimiter(120, 60_000),
  };

  return {
    config,
    topology,
    sessions,
    limiters,

    siteFor(req, reply) {
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
    },

    async withSite(s, reply, fn) {
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
    },

    allowChange(req, reply, message = "Too many changes. Wait a minute.") {
      if (limiters.apply.take(req.session!.id)) return true;
      reply.code(429).send({ error: { kind: "rate_limited", message } });
      return false;
    },

    writesAllowed(reply, readOnlyReason) {
      if (config.allowWrites && !readOnlyReason) return true;
      reply.code(403).send({
        error: { kind: "writes_disabled", message: readOnlyReason ?? "Sending changes to firewalls is disabled on this server (RULEDECK_ALLOW_WRITES is not true)." },
      });
      return false;
    },

    invalid(reply, what, error) {
      reply.code(400).send({
        error: { kind: "bad_request", message: `${what}: ` + error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ") },
      });
    },

    siteView,
    sessionView: (s) => sessionView(topology, s),
    setSessionCookie: (reply, value, maxAgeSeconds = SESSION_MAX_AGE_S) =>
      reply.setCookie(SESSION_COOKIE, value, { httpOnly: true, sameSite: "strict", secure: config.cookieSecure, path: "/", maxAge: maxAgeSeconds }),
  };
}
