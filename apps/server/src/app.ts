import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { OpnsenseError } from "@ruledeck/opnsense-client";
import type { AppConfig } from "./config.ts";
import { safeEqual, SessionStore, type Session } from "./auth.ts";
import { endSiteSession } from "./sites.ts";
import { createContext, CSRF_HEADER, SESSION_COOKIE } from "./routes/context.ts";
import { authRoutes } from "./routes/auth.ts";
import { siteRoutes } from "./routes/sites.ts";
import { serviceRoutes } from "./routes/services.ts";
import { haRoutes } from "./routes/ha.ts";
import { sharedRoutes } from "./routes/shared.ts";

/**
 * The RuleDeck server: security hooks, authentication + CSRF for every API route,
 * the route modules in ./routes, and the built web app. It stores nothing.
 */

export { CSRF_HEADER, SESSION_COOKIE };

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

/** Routes that don't need a session. */
const PUBLIC_ROUTES = new Set(["/api/health", "/api/topology", "/api/auth/login", "/api/auth/session"]);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const sessions = deps.sessions ?? new SessionStore(Date.now, (s) => void endSiteSession(s));

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

  const ctx = createContext(config, sessions);
  authRoutes(app, ctx);
  siteRoutes(app, ctx);
  serviceRoutes(app, ctx);
  haRoutes(app, ctx);
  sharedRoutes(app, ctx);

  // The built web app, with index.html for client-side routes.
  const webDist = config.webDist ? resolve(config.webDist) : undefined;
  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: { kind: "not_found", message: "Not found." } });
      return reply.sendFile("index.html");
    });
  }

  // Closing the server ends every session, which logs out of the firewalls.
  app.addHook("onClose", async () => {
    sessions.close();
  });

  return app;
}
