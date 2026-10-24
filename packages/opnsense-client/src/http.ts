import { Agent, fetch } from "undici";
import { mapResponseError, mapTransportError, OpnsenseError } from "./errors.ts";

export interface ConnectionConfig {
  /** e.g. https://fw.lan or https://10.0.0.1:8443. */
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  /** PEM CA bundle for firewalls with a private/self-signed CA. */
  caPem?: string;
  timeoutMs?: number;
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
  private readonly auth: string;
  private readonly dispatcher: Agent;
  private readonly timeoutMs: number;

  constructor(cfg: ConnectionConfig) {
    this.base = validateBaseUrl(cfg.baseUrl);
    this.auth = "Basic " + Buffer.from(`${cfg.apiKey}:${cfg.apiSecret}`).toString("base64");
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
    // TLS verification stays on. A custom CA can be added; it can't be turned off.
    this.dispatcher = new Agent({
      connect: cfg.caPem ? { ca: cfg.caPem, rejectUnauthorized: true } : { rejectUnauthorized: true },
    });
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
          authorization: this.auth,
          accept: "application/json",
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        body: method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (err) {
      throw mapTransportError(err, endpoint);
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
