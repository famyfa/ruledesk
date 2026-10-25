import { fetch, type Agent } from "undici";
import { mapTransportError, OpnsenseError } from "./errors.ts";
import { makeDispatcher, validateBaseUrl, type Credentials, type EndpointConfig } from "./http.ts";

/**
 * Sign in to the OPNsense web GUI with the user's own username and password,
 * the same way a browser does (src/www/authgui.inc, 26.1/26.7):
 *
 *   1. GET /            -> session cookie + login form with a hidden CSRF field
 *   2. POST /           -> usernamefld, passwordfld, login, <csrf key>=<token>
 *                          success: redirect + regenerated session cookie
 *                          failure: 200 with the login form again
 *   3. API calls then use that cookie + `X-CSRFToken: <token>` (ApiControllerBase).
 *
 * Authentication is done by OPNsense's "WebGui" authenticator, so local users,
 * LDAP, RADIUS and TOTP (token+password) all work. The password is used once
 * and never kept; only the resulting session lives in RuleDeck's memory.
 */

export interface LoginResult {
  credentials: Extract<Credentials, { kind: "session" }>;
}

const MAX_HTML = 512 * 1024;

/** Collect `name=value` pairs from Set-Cookie headers. */
function cookiesFrom(headers: Headers, jar: Map<string, string>) {
  for (const line of headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = pair!.indexOf("=");
    if (eq > 0) jar.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim());
  }
}

const cookieHeader = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

/** Find the hidden CSRF input OPNsense injects into POST forms. */
export function parseLoginForm(html: string): { key: string; token: string } | null {
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/type\s*=\s*["']hidden["']/i.test(tag)) continue;
    const name = /name\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const value = /value\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (name && value && !["login", "usernamefld", "passwordfld"].includes(name)) return { key: name, token: value };
  }
  return null;
}

/** The token the web UI sends as X-CSRFToken (rendered into page scripts). */
export function parseCsrfHeaderToken(html: string): string | null {
  return /X-CSRFToken["']\s*,\s*["']([^"']+)["']/.exec(html)?.[1] ?? null;
}

async function readLimited(res: Awaited<ReturnType<typeof fetch>>): Promise<string> {
  // Login pages are small; cap what we read from an unexpected response.
  const text = await res.text();
  return text.length > MAX_HTML ? text.slice(0, MAX_HTML) : text;
}

export async function loginWithPassword(endpoint: EndpointConfig, username: string, password: string): Promise<LoginResult> {
  const base = validateBaseUrl(endpoint.baseUrl);
  const dispatcher: Agent = makeDispatcher(endpoint.caPem, endpoint.tlsFingerprint);
  const timeout = () => AbortSignal.timeout(endpoint.timeoutMs ?? 15_000);
  const jar = new Map<string, string>();
  const where = "login";
  try {
    // 1. Login page.
    let res;
    try {
      res = await fetch(new URL("/", base), { dispatcher, redirect: "manual", signal: timeout(), headers: { accept: "text/html" } });
    } catch (err) {
      throw mapTransportError(err, where);
    }
    cookiesFrom(res.headers, jar);
    const page = await readLimited(res);
    if (/DNS Rebind/i.test(page)) {
      throw new OpnsenseError(
        "rejected",
        "The firewall refused the login page because of its DNS-rebind protection. Use its IP address or add this hostname under System ▸ Settings ▸ Administration ▸ Alternate Hostnames.",
        { endpoint: where },
      );
    }
    const form = parseLoginForm(page);
    if (!form || !jar.size) throw new OpnsenseError("protocol", "The firewall's login page looks different than expected.", { endpoint: where });

    // 2. Submit credentials.
    const body = new URLSearchParams({ [form.key]: form.token, usernamefld: username, passwordfld: password, login: "1" });
    try {
      res = await fetch(new URL("/", base), {
        method: "POST",
        dispatcher,
        redirect: "manual",
        signal: timeout(),
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader(jar), accept: "text/html" },
        body: body.toString(),
      });
    } catch (err) {
      throw mapTransportError(err, where);
    }
    cookiesFrom(res.headers, jar);
    const isRedirect = res.status >= 300 && res.status < 400;
    await res.body?.cancel().catch(() => {});
    if (!isRedirect) {
      if (res.status === 403) throw new OpnsenseError("protocol", "The firewall rejected the login form (CSRF).", { endpoint: where, status: 403 });
      throw new OpnsenseError("auth", "Wrong username or password.", { endpoint: where, status: res.status });
    }
    if ((res.headers.get("location") ?? "").includes("/ui/user_portal")) {
      // authgui.inc sends users who must change their password to the user portal.
      // They are already signed in at this point, so end that session first.
      await logoutSession(endpoint, { kind: "session", cookie: cookieHeader(jar), csrfToken: form.token });
      throw new OpnsenseError("rejected", "OPNsense requires a password change for this user. Sign in to the firewall directly first.", { endpoint: where });
    }

    // 3. The session keeps its CSRF token across the login; prefer the one a page renders.
    let csrfToken = form.token;
    try {
      const probe = await fetch(new URL("/ui/core/dashboard", base), {
        dispatcher,
        redirect: "manual",
        signal: timeout(),
        headers: { cookie: cookieHeader(jar), accept: "text/html" },
      });
      if (probe.status === 200) csrfToken = parseCsrfHeaderToken(await readLimited(probe)) ?? csrfToken;
      else await probe.body?.cancel().catch(() => {});
    } catch {
      /* the form token is still valid */
    }
    return { credentials: { kind: "session", cookie: cookieHeader(jar), csrfToken } };
  } finally {
    await dispatcher.close();
  }
}

/** End the OPNsense GUI session (best effort). */
export async function logoutSession(endpoint: EndpointConfig, credentials: Credentials): Promise<void> {
  if (credentials.kind !== "session") return;
  const dispatcher = makeDispatcher(endpoint.caPem, endpoint.tlsFingerprint);
  try {
    const res = await fetch(new URL("/index.php?logout", validateBaseUrl(endpoint.baseUrl)), {
      dispatcher,
      redirect: "manual",
      signal: AbortSignal.timeout(endpoint.timeoutMs ?? 15_000),
      headers: { cookie: credentials.cookie },
    });
    await res.body?.cancel().catch(() => {});
  } catch {
    /* best effort */
  } finally {
    await dispatcher.close();
  }
}
