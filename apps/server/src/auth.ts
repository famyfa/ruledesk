import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FirewallInfo } from "@ruledeck/core";
import type { OpnsenseClient } from "@ruledeck/opnsense-client";
import type { NodeConfig } from "./topology.ts";

/**
 * RuleDeck sessions live in memory only. A session holds, per site, a client
 * that is signed in to that firewall (an OPNsense GUI session, or an API key
 * the user entered). Passwords are never kept. A server restart signs everyone out.
 */

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface SiteSession {
  siteId: string;
  client: OpnsenseClient;
  endpoint: NodeConfig;
  method: "password" | "apikey";
  /** Who OPNsense knows us as: the username, or "API key …abcd". */
  user: string;
  info: FirewallInfo;
  status: "ok" | "signed_out";
  /** Firewall operations still running (e.g. an apply). Ending the session waits for them. */
  inflight: Set<Promise<unknown>>;
}

/** Run `fn` as in-flight work of a site session, so the session isn't torn down under it. */
export async function track<T>(s: SiteSession, fn: () => Promise<T>): Promise<T> {
  const p = fn();
  s.inflight.add(p);
  try {
    return await p;
  } finally {
    s.inflight.delete(p);
  }
}

export interface Session {
  id: string;
  csrfToken: string;
  createdAt: number;
  lastSeen: number;
  sites: Map<string, SiteSession>;
}

export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000;
export const MAX_SESSIONS = 50;

const newToken = () => randomBytes(32).toString("base64url");

export class SessionStore {
  private sessions = new Map<string, Session>();
  private sweeper: NodeJS.Timeout;

  constructor(
    private now: () => number = Date.now,
    /** Called for every site session that ends (wait for in-flight work, then log out of the firewall). */
    private onEnd: (s: SiteSession) => void = () => {},
    private maxSessions = MAX_SESSIONS,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  private expired(s: Session) {
    const t = this.now();
    return t - s.lastSeen > IDLE_TIMEOUT_MS || t - s.createdAt > ABSOLUTE_TIMEOUT_MS;
  }

  /**
   * New empty session, or null when the store is full. We never evict other
   * people's sessions to make room (that would let anyone sign everyone out).
   */
  create(): Session | null {
    this.sweep();
    if (this.sessions.size >= this.maxSessions) return null;
    const t = this.now();
    const s: Session = { id: newToken(), csrfToken: newToken(), createdAt: t, lastSeen: t, sites: new Map() };
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (this.expired(s)) {
      this.destroy(id);
      return undefined;
    }
    s.lastSeen = this.now();
    return s;
  }

  /** Is this exact session object still active (not destroyed meanwhile)? */
  isAlive(s: Session): boolean {
    return this.sessions.get(s.id) === s;
  }

  /** New id and CSRF token for a session whose privileges grew (prevents session fixation). */
  rotate(s: Session): void {
    if (!this.isAlive(s)) return;
    this.sessions.delete(s.id);
    s.id = newToken();
    s.csrfToken = newToken();
    this.sessions.set(s.id, s);
  }

  /** Add (or replace) a site session. If the RuleDeck session is gone, end the site session instead. */
  attachSite(s: Session, site: SiteSession): boolean {
    if (!this.isAlive(s)) {
      this.onEnd(site);
      return false;
    }
    this.endSite(s, site.siteId);
    s.sites.set(site.siteId, site);
    return true;
  }

  endSite(s: Session, siteId: string) {
    const site = s.sites.get(siteId);
    if (site) {
      s.sites.delete(siteId);
      this.onEnd(site);
    }
  }

  destroy(id: string | undefined) {
    if (!id) return;
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    for (const site of s.sites.values()) this.onEnd(site);
    s.sites.clear();
  }

  sweep() {
    for (const s of [...this.sessions.values()]) if (this.expired(s)) this.destroy(s.id);
  }

  close() {
    clearInterval(this.sweeper);
    for (const id of [...this.sessions.keys()]) this.destroy(id);
  }

  get size() {
    return this.sessions.size;
  }
}

/** Fixed-window rate limiter. Expired windows are pruned so the map can't grow forever. */
export class RateLimiter {
  private hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  private current(key: string) {
    const h = this.hits.get(key);
    if (h && this.now() - h.windowStart >= this.windowMs) {
      this.hits.delete(key);
      return undefined;
    }
    return h;
  }

  private prune() {
    if (this.hits.size < 1000) return;
    const t = this.now();
    for (const [k, h] of this.hits) if (t - h.windowStart >= this.windowMs) this.hits.delete(k);
  }

  /** True if the key has used up its budget in the current window (does not count). */
  isLimited(key: string): boolean {
    const h = this.current(key);
    return !!h && h.count >= this.limit;
  }

  /** Count one hit (atomically with the check). Returns true if the action is allowed. */
  take(key: string): boolean {
    this.prune();
    const h = this.current(key);
    if (!h) {
      this.hits.set(key, { count: 1, windowStart: this.now() });
      return true;
    }
    h.count++;
    return h.count <= this.limit;
  }

  /** Give back a hit taken with take() (e.g. the attempt succeeded). */
  refund(key: string): void {
    const h = this.current(key);
    if (h && h.count > 0) h.count--;
  }

  forget(key: string): void {
    this.hits.delete(key);
  }
}
