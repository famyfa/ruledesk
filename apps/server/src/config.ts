import { z } from "zod";
import { loadTopology, TopologyError, type Topology } from "./topology.ts";

/**
 * RuleDeck stores nothing: no database, no credentials, no local users.
 * Configuration is environment variables plus a read-only topology file.
 */

const Env = z.object({
  NODE_ENV: z.string().default("development"),
  RULEDECK_HOST: z.string().default("127.0.0.1"),
  RULEDECK_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  RULEDECK_TOPOLOGY_FILE: z.string().default("./ruledeck.topology.json"),
  RULEDECK_COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  RULEDECK_WEB_DIST: z.string().optional(),
  RULEDECK_ALLOW_WRITES: z.enum(["true", "false"]).default("false"),
  RULEDECK_APPLY_RATE_LIMIT: z.coerce.number().int().min(1).max(1000).default(10),
  /**
   * Failed password sign-ins allowed per site per hour, across all users. OPNsense
   * blocks a source address after 5 failures within an hour (lockout_handler),
   * and every sign-in comes from RuleDeck's address, so stay below that.
   */
  RULEDECK_SITE_LOGIN_FAILURES: z.coerce.number().int().min(1).max(100).default(4),
  /** Set to true when RuleDeck runs behind a reverse proxy, so client IPs come from X-Forwarded-For. */
  RULEDECK_TRUST_PROXY: z.enum(["true", "false"]).default("false"),
});

/** Settings from earlier versions that would mean storing something. */
const REMOVED = [
  "RULEDECK_ADMIN_USER",
  "RULEDECK_ADMIN_PASSWORD_HASH",
  "RULEDECK_DATA_DIR",
  "OPNSENSE_URL",
  "OPNSENSE_API_KEY",
  "OPNSENSE_API_SECRET",
  "OPNSENSE_CA_FILE",
  "OPNSENSE_NAME",
];

export interface AppConfig {
  production: boolean;
  host: string;
  port: number;
  cookieSecure: boolean;
  webDist?: string;
  /** Master switch for sending changes to firewalls. Off by default. */
  allowWrites: boolean;
  /** Max apply attempts per user per minute. */
  applyRateLimit?: number;
  /** Failed password sign-ins allowed per site per hour (all users together). */
  siteLoginFailures?: number;
  trustProxy?: boolean;
  topology: Topology;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, load: (path: string) => Topology = loadTopology): AppConfig {
  const stale = REMOVED.filter((k) => env[k] !== undefined && env[k] !== "");
  if (stale.length) {
    throw new ConfigError(
      `${stale.join(", ")} ${stale.length > 1 ? "are" : "is"} no longer used. RuleDeck stores no credentials or users: ` +
        "people sign in with their OPNsense account, and firewalls are listed in the topology file (RULEDECK_TOPOLOGY_FILE). Remove these settings.",
    );
  }
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError("Invalid configuration: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const e = parsed.data;
  const production = e.NODE_ENV === "production";
  let topology: Topology;
  try {
    topology = load(e.RULEDECK_TOPOLOGY_FILE);
  } catch (err) {
    if (err instanceof TopologyError) throw new ConfigError(err.message);
    throw err;
  }
  return {
    production,
    host: e.RULEDECK_HOST,
    port: e.RULEDECK_PORT,
    cookieSecure: e.RULEDECK_COOKIE_SECURE ? e.RULEDECK_COOKIE_SECURE === "true" : production,
    webDist: e.RULEDECK_WEB_DIST,
    allowWrites: e.RULEDECK_ALLOW_WRITES === "true",
    applyRateLimit: e.RULEDECK_APPLY_RATE_LIMIT,
    siteLoginFailures: e.RULEDECK_SITE_LOGIN_FAILURES,
    trustProxy: e.RULEDECK_TRUST_PROXY === "true",
    topology,
  };
}
