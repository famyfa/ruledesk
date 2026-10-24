import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Format: scrypt$<salt base64>$<hash base64>. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, SCRYPT_OPTS);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, SCRYPT_OPTS);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface Session {
  id: string;
  user: string;
  csrfToken: string;
  createdAt: number;
  lastSeen: number;
}

export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/** In-memory session store. Sessions end when the server restarts. */
export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor(private now: () => number = Date.now) {}

  create(user: string): Session {
    const t = this.now();
    const s: Session = {
      id: randomBytes(32).toString("base64url"),
      user,
      csrfToken: randomBytes(32).toString("base64url"),
      createdAt: t,
      lastSeen: t,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const s = this.sessions.get(id);
    if (!s) return undefined;
    const t = this.now();
    if (t - s.lastSeen > IDLE_TIMEOUT_MS || t - s.createdAt > ABSOLUTE_TIMEOUT_MS) {
      this.sessions.delete(id);
      return undefined;
    }
    s.lastSeen = t;
    return s;
  }

  destroy(id: string | undefined) {
    if (id) this.sessions.delete(id);
  }
}

/** Fixed-window rate limiter keyed by e.g. client IP. */
export class RateLimiter {
  private hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  /** True if the key has used up its budget in the current window (does not count). */
  isLimited(key: string): boolean {
    const h = this.hits.get(key);
    return !!h && this.now() - h.windowStart < this.windowMs && h.count >= this.limit;
  }

  /** Count one hit. Returns true if the action is allowed. */
  take(key: string): boolean {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || t - h.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: t });
      return true;
    }
    h.count++;
    return h.count <= this.limit;
  }
}
