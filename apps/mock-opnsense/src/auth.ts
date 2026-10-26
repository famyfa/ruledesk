import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Imitates OPNsense authentication (26.x):
 * - API key/secret via HTTP Basic (ApiControllerBase, "Local API" authenticator)
 * - GUI sessions: login form at "/" with a hidden CSRF field (authgui.inc),
 *   session cookie, and `X-CSRFToken` on API POSTs (ApiControllerBase/Security)
 * - per-user privileges (ACL) -> 403, session timeout -> 401
 */

export interface MockUser {
  password: string;
  /** API path prefixes the user may call, e.g. "firewall/filter/". "*" = everything. */
  privileges: string[];
}

export interface MockAuthOptions {
  users?: Record<string, MockUser>;
  apiKeys?: Record<string, { secret: string; user: string }>;
  sessionTimeoutMs?: number;
  /** Simulate the DNS-rebind protection page on the login form. */
  dnsRebind?: boolean;
}

export const DEFAULT_USERS: Record<string, MockUser> = {
  root: { password: "opnsense", privileges: ["*"] },
  admin: { password: "ruledeck-dev", privileges: ["*"] },
  // Can do everything except read the firewall log ("!" entries are denied).
  nolog: { password: "nolog-pass", privileges: ["*", "!diagnostics/firewall/log"] },
  // Can read rules and aliases but not write anything.
  viewer: { password: "viewer-pass", privileges: ["firewall/filter/search_rule", "firewall/filter/get_", "firewall/filter/list_", "firewall/alias/search_item", "firewall/alias/get_item", "core/firmware/info", "diagnostics/firewall/log", "diagnostics/interface/get_vip_status"] },
};

interface Session {
  username?: string;
  csrfKey: string;
  csrfToken: string;
  lastAccess: number;
}

const rand = () => randomBytes(16).toString("base64url");
const COOKIE = "PHPSESSID";

export class MockAuth {
  users: Record<string, MockUser>;
  apiKeys: Record<string, { secret: string; user: string }>;
  sessionTimeoutMs: number;
  dnsRebind: boolean;
  private sessions = new Map<string, Session>();

  constructor(opts: MockAuthOptions = {}) {
    this.users = opts.users ?? DEFAULT_USERS;
    this.apiKeys = opts.apiKeys ?? { "mock-key": { secret: "mock-secret", user: "root" } };
    this.sessionTimeoutMs = opts.sessionTimeoutMs ?? 4 * 3600_000;
    this.dnsRebind = opts.dnsRebind ?? false;
  }

  /** Number of GUI sessions that are signed in. */
  signedInSessions(): number {
    return [...this.sessions.values()].filter((s) => s.username).length;
  }

  /** Make every existing GUI session stale (like the OPNsense session timeout). */
  expireSessions() {
    for (const s of this.sessions.values()) s.lastAccess = 0;
  }

  private sessionOf(req: FastifyRequest): [string, Session] | null {
    const sid = /(?:^|;\s*)PHPSESSID=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    if (!sid) return null;
    const s = this.sessions.get(sid);
    return s ? [sid, s] : null;
  }

  private newSession(reply: FastifyReply, carry?: Session): [string, Session] {
    const sid = rand();
    const s: Session = carry ? { ...carry } : { csrfKey: rand(), csrfToken: rand(), lastAccess: Date.now() };
    this.sessions.set(sid, s);
    reply.header("set-cookie", `${COOKIE}=${sid}; path=/; secure; HttpOnly`);
    return [sid, s];
  }

  /**
   * Authenticate an API request. Returns the user name, or sends the error
   * response and returns null.
   */
  authenticateApi(req: FastifyRequest, reply: FastifyReply, apiPath: string): string | null {
    let user: string | undefined;
    const authz = req.headers.authorization;
    if (authz) {
      const [, b64] = authz.split(" ");
      const [key, secret] = Buffer.from(b64 ?? "", "base64").toString().split(":");
      const k = key ? this.apiKeys[key] : undefined;
      if (!k || k.secret !== secret) {
        reply.code(401).send({ status: 401, message: "Authentication Failed" });
        return null;
      }
      user = k.user;
    } else {
      const found = this.sessionOf(req);
      const s = found?.[1];
      if (!s?.username || Date.now() - s.lastAccess > this.sessionTimeoutMs) {
        if (s) s.username = undefined;
        reply.code(401).header("location", `/?url=/api/${apiPath}`).send("");
        return null;
      }
      if (req.method !== "GET" && req.headers["x-csrftoken"] !== s.csrfToken) {
        reply.code(403).send("");
        return null;
      }
      s.lastAccess = Date.now();
      user = s.username;
    }
    const privs = this.users[user]?.privileges ?? [];
    const denied = privs.some((p) => p.startsWith("!") && apiPath.startsWith(p.slice(1)));
    if (denied || (!privs.includes("*") && !privs.some((p) => apiPath.startsWith(p)))) {
      // API keys get JSON; GUI sessions get ControllerRoot::doAuth's redirect with an empty 403.
      if (authz) reply.code(403).send({ status: 403, message: "Forbidden" });
      else reply.code(403).header("location", "/").send("");
      return null;
    }
    return user;
  }

  register(app: FastifyInstance) {
    app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    });

    const loginPage = (s: Session, error?: string) =>
      `<!doctype html><html><head><title>Login | OPNsense</title></head><body>
<form method="post" id="iform" name="iform" class="login">
<input type="hidden" name="${s.csrfKey}" value="${s.csrfToken}" autocomplete="new-password" />
${error ? `<div class="alert alert-danger">${error}</div>` : ""}
<input id="usernamefld" type="text" name="usernamefld" /><input id="passwordfld" type="password" name="passwordfld" />
<button type="submit" name="login" value="1">Login</button></form></body></html>`;

    app.get("/", async (req, reply) => {
      if (this.dnsRebind) {
        return reply.type("text/html").send("<html><body><h1>Potential DNS Rebind attack detected</h1></body></html>");
      }
      const found = this.sessionOf(req) ?? this.newSession(reply);
      return reply.type("text/html").send(loginPage(found[1]));
    });

    app.post("/", async (req, reply) => {
      const found = this.sessionOf(req);
      const form = (req.body ?? {}) as Record<string, string>;
      if (!found || form[found[1].csrfKey] !== found[1].csrfToken) {
        return reply.code(403).type("text/html").send("<html><body>CSRF check failed</body></html>");
      }
      const [oldSid, s] = found;
      const user = this.users[form.usernamefld ?? ""];
      if (!form.login || !user || user.password !== form.passwordfld) {
        return reply.type("text/html").send(loginPage(s, "Wrong username or password."));
      }
      // session_regenerate_id(): new id, same data (incl. CSRF token).
      this.sessions.delete(oldSid);
      const [, ns] = this.newSession(reply, s);
      ns.username = form.usernamefld;
      ns.lastAccess = Date.now();
      return reply.code(302).header("location", "/ui/core/dashboard").send("");
    });

    app.get("/ui/core/dashboard", async (req, reply) => {
      const s = this.sessionOf(req)?.[1];
      if (!s?.username) return reply.code(302).header("location", "/?url=/ui/core/dashboard").send("");
      return reply
        .type("text/html")
        .send(`<html><head><script>xhr.setRequestHeader("X-CSRFToken", "${s.csrfToken}" );</script></head><body>Dashboard</body></html>`);
    });

    app.get("/index.php", async (req, reply) => {
      const q = req.query as Record<string, string>;
      const found = this.sessionOf(req);
      if ("logout" in q && found) this.sessions.delete(found[0]);
      return reply.code(302).header("location", "/").send("");
    });
  }
}
