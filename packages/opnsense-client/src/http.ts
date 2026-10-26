import { Agent, buildConnector, fetch } from "undici";
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
  /**
   * SHA-256 fingerprint of the firewall's certificate (hex, colons optional).
   * When set, exactly this certificate is accepted, whatever its issuer or name.
   * Useful for self-signed certificates on IP addresses; stricter than a CA check.
   */
  tlsFingerprint?: string;
  timeoutMs?: number;
}

export interface ConnectionConfig extends EndpointConfig {
  auth: Credentials;
}

/** TLS-verifying dispatcher. Verification can't be turned off; a custom CA can be added. */
export const normalizeFingerprint = (fp: string) => fp.replace(/[^0-9a-f]/gi, "").toLowerCase();

export class PinMismatchError extends Error {
  code = "ERR_TLS_PIN_MISMATCH";
}

/**
 * TLS dispatcher. Verification is never turned off: either the normal CA/name
 * check (optionally with a private CA), or certificate pinning, where only the
 * certificate with the configured SHA-256 fingerprint is accepted.
 */
export function makeDispatcher(caPem?: string, tlsFingerprint?: string): Agent {
  if (!tlsFingerprint) {
    return new Agent({ connect: caPem ? { ca: caPem, rejectUnauthorized: true } : { rejectUnauthorized: true } });
  }
  const want = normalizeFingerprint(tlsFingerprint);
  // Chain/name checks are replaced by the pin check below, which runs before any request is sent.
  // No TLS session resumption: a resumed session doesn't present the certificate,
  // so every connection must do a full handshake for the pin to be checked.
  const base = buildConnector({ rejectUnauthorized: false, maxCachedSessions: 0 });
  return new Agent({
    connect: (opts, cb) =>
      base(opts, (err, socket) => {
        if (err || !socket) return cb(err ?? new Error("TLS connect failed"), null);
        if (opts.protocol !== "https:") return cb(null, socket); // plain http is only allowed for loopback
        const tls = socket as unknown as { getPeerCertificate?: () => { fingerprint256?: string } };
        const got = normalizeFingerprint(tls.getPeerCertificate?.().fingerprint256 ?? "");
        if (got !== want) {
          socket.destroy();
          return cb(new PinMismatchError(`certificate fingerprint ${got || "(none)"} doesn't match the pinned one`), null);
        }
        cb(null, socket);
      }),
  });
}

/** Largest answer RuleDeck reads from a firewall. A misbehaving or hostile peer can't exhaust memory. */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** Read a response body as text, refusing anything larger than `max` bytes (checked while streaming). */
export async function readCapped(res: { headers: Headers; body: ReadableStream<Uint8Array> | null }, max: number, endpoint: string): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new OpnsenseError("protocol", "The firewall's answer is too large.", { endpoint });
  }
  if (!res.body) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > max) throw new OpnsenseError("protocol", "The firewall's answer is too large.", { endpoint }); // leaving the loop cancels the stream
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
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
    this.dispatcher = makeDispatcher(cfg.caPem, cfg.tlsFingerprint);
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
    const text = await readCapped(res as unknown as { headers: Headers; body: ReadableStream<Uint8Array> | null }, MAX_RESPONSE_BYTES, endpoint).catch((e) => {
      if (e instanceof OpnsenseError) throw e;
      return "";
    });
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
