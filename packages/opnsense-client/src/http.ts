import { Agent, fetch } from "undici";
import { mapResponseError, mapTransportError, OpnsenseError } from "./errors.ts";

/**
 * How RuleDeck authenticates to a firewall. RuleDeck never stores either:
 * - session: an OPNsense GUI session (cookie + CSRF token) obtained by signing
 *   in with the user's own username/password (see login.ts). The password
 *   itself is not kept.
 * - apikey: an OPNsense API key/secret pair (fallback, e.g. for SSO-only setups).
 */
export type Credentials =
  | { kind: "session"; cookie: string; csrfToken: string }
  | { kind: "apikey"; apiKey: string; apiSecret: string };

export interface EndpointConfig {
  /** e.g. https://fw.lan or https://10.0.0.1:8443. */
  baseUrl: string;
  /** PEM CA bundle for firewalls with a private/self-signed CA. */
  caPem?: string;
  timeoutMs?: number;
}

export interface ConnectionConfig extends EndpointConfig {
  auth: Credentials;
}

/** TLS-verifying dispatcher. Verification can't be turned off; a custom CA can be added. */
export function makeDispatcher(caPem?: string): Agent {
  return new Agent({ connect: caPem ? { ca: caPem, rejectUnauthorized: true } : { rejectUnauthorized: true } });
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Validate the configured firewall URL. HTTPS is required; plain HTTP is only
 * allowed for loopback (the local mock). No credentials, paths or queries in the URL.
 */
export function validateBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("OPNSENSE_URL is not a valid URL.");
  }
  if (url.username || url.password) throw new Error("OPNSENSE_URL must not contain credentials.");
  if (url.search || url.hash) throw new Error("OPNSENSE_URL must not contain a query or fragment.");
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("OPNSENSE_URL must not contain a path.");
  if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) {
    throw new Error("OPNSENSE_URL must use https:// (plain http is only allowed for a local mock on localhost).");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("OPNSENSE_URL must use https://.");
  return url;
}

/** Path segments we allow as parameters: uuids, alias names, 0/1 flags. */
const SAFE_SEGMENT = /^[A-Za-z0-9_.:-]{1,64}$/;

export function apiPath(endpoint: string, ...params: string[]): string {
  for (const p of params) {
    if (!SAFE_SEGMENT.test(p)) throw new OpnsenseError("protocol", "Refusing to send an unsafe path parameter.", { endpoint });
  }
  return `/api/${endpoint}${params.map((p) => "/" + encodeURIComponent(p)).join("")}`;
}

export class OpnsenseHttp {
  private readonly base: URL;
  private readonly authHeaders: Record<string, string>;
  private readonly csrfHeader: Record<string, string>;
  private readonly dispatcher: Agent;
  private readonly timeoutMs: number;

  constructor(cfg: ConnectionConfig) {
    this.base = validateBaseUrl(cfg.baseUrl);
    if (cfg.auth.kind === "apikey") {
      this.authHeaders = { authorization: "Basic " + Buffer.from(`${cfg.auth.apiKey}:${cfg.auth.apiSecret}`).toString("base64") };
      this.csrfHeader = {};
    } else {
      // Same mechanism the OPNsense web UI uses for its own API calls.
      this.authHeaders = { cookie: cfg.auth.cookie };
      this.csrfHeader = { "x-csrftoken": cfg.auth.csrfToken };
    }
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
    this.dispatcher = makeDispatcher(cfg.caPem);
  }

  get origin(): string {
    return this.base.origin;
  }

  async request<T = unknown>(
    method: "GET" | "POST",
    endpoint: string,
    opts: { params?: string[]; query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(apiPath(endpoint, ...(opts.params ?? [])), this.base);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

    let res;
    try {
      res = await fetch(url, {
        method,
        dispatcher: this.dispatcher,
        headers: {
          ...this.authHeaders,
          accept: "application/json",
          ...(method === "POST" ? { "content-type": "application/json", ...this.csrfHeader } : {}),
        },
        body: method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
        // A session that expired gets redirected to the login page; treat that as "signed out".
        redirect: "manual",
      });
    } catch (err) {
      throw mapTransportError(err, endpoint);
    }

    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      throw new OpnsenseError("auth", "The firewall session has ended. Sign in again.", { endpoint, status: res.status });
    }
    let body: unknown = null;
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        if (res.ok) throw new OpnsenseError("protocol", "The firewall returned a non-JSON response.", { endpoint, status: res.status });
      }
    }
    const error = mapResponseError(res.status, body, endpoint);
    if (error) throw error;
    return body as T;
  }

  get<T = unknown>(endpoint: string, opts: { params?: string[]; query?: Record<string, string> } = {}) {
    return this.request<T>("GET", endpoint, opts);
  }

  post<T = unknown>(endpoint: string, opts: { params?: string[]; query?: Record<string, string>; body?: unknown } = {}) {
    return this.request<T>("POST", endpoint, opts);
  }

  async close() {
    await this.dispatcher.close();
  }
}
