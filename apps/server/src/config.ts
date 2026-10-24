import { readFileSync } from "node:fs";
import { z } from "zod";
import { validateBaseUrl } from "@ruledeck/opnsense-client";

const Env = z.object({
  NODE_ENV: z.string().default("development"),
  RULEDECK_HOST: z.string().default("127.0.0.1"),
  RULEDECK_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  RULEDECK_DATA_DIR: z.string().default("./data"),
  RULEDECK_ADMIN_USER: z.string().min(1).default("admin"),
  RULEDECK_ADMIN_PASSWORD_HASH: z.string().optional(),
  RULEDECK_COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  RULEDECK_WEB_DIST: z.string().optional(),
  RULEDECK_ALLOW_WRITES: z.enum(["true", "false"]).default("false"),
  RULEDECK_APPLY_RATE_LIMIT: z.coerce.number().int().min(1).max(1000).default(10),
  OPNSENSE_NAME: z.string().default("OPNsense"),
  OPNSENSE_URL: z.string().optional(),
  OPNSENSE_API_KEY: z.string().optional(),
  OPNSENSE_API_SECRET: z.string().optional(),
  OPNSENSE_CA_FILE: z.string().optional(),
  OPNSENSE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
});

export interface FirewallConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  caPem?: string;
  timeoutMs: number;
}

export interface AppConfig {
  production: boolean;
  host: string;
  port: number;
  dataDir: string;
  adminUser: string;
  adminPasswordHash: string;
  cookieSecure: boolean;
  webDist?: string;
  /** Master switch for sending changes to firewalls. Off by default. */
  allowWrites: boolean;
  /** Max apply attempts per user per minute. */
  applyRateLimit?: number;
  firewalls: FirewallConfig[];
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError("Invalid configuration: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const e = parsed.data;
  const production = e.NODE_ENV === "production";

  if (!e.RULEDECK_ADMIN_PASSWORD_HASH) {
    throw new ConfigError("RULEDECK_ADMIN_PASSWORD_HASH is not set. Generate one with `npm run hash-password`.");
  }
  if (!e.RULEDECK_ADMIN_PASSWORD_HASH.startsWith("scrypt$")) {
    throw new ConfigError("RULEDECK_ADMIN_PASSWORD_HASH must be a scrypt hash from `npm run hash-password`.");
  }

  const firewalls: FirewallConfig[] = [];
  if (e.OPNSENSE_URL) {
    if (!e.OPNSENSE_API_KEY || !e.OPNSENSE_API_SECRET) {
      throw new ConfigError("OPNSENSE_API_KEY and OPNSENSE_API_SECRET are required when OPNSENSE_URL is set.");
    }
    try {
      validateBaseUrl(e.OPNSENSE_URL);
    } catch (err) {
      throw new ConfigError((err as Error).message);
    }
    let caPem: string | undefined;
    if (e.OPNSENSE_CA_FILE) {
      try {
        caPem = readFileSync(e.OPNSENSE_CA_FILE, "utf8");
      } catch {
        throw new ConfigError(`Could not read OPNSENSE_CA_FILE (${e.OPNSENSE_CA_FILE}).`);
      }
    }
    firewalls.push({
      id: "default",
      name: e.OPNSENSE_NAME,
      baseUrl: e.OPNSENSE_URL,
      apiKey: e.OPNSENSE_API_KEY,
      apiSecret: e.OPNSENSE_API_SECRET,
      caPem,
      timeoutMs: e.OPNSENSE_TIMEOUT_MS,
    });
  }

  return {
    production,
    host: e.RULEDECK_HOST,
    port: e.RULEDECK_PORT,
    dataDir: e.RULEDECK_DATA_DIR,
    adminUser: e.RULEDECK_ADMIN_USER,
    adminPasswordHash: e.RULEDECK_ADMIN_PASSWORD_HASH,
    cookieSecure: e.RULEDECK_COOKIE_SECURE ? e.RULEDECK_COOKIE_SECURE === "true" : production,
    webDist: e.RULEDECK_WEB_DIST,
    allowWrites: e.RULEDECK_ALLOW_WRITES === "true",
    applyRateLimit: e.RULEDECK_APPLY_RATE_LIMIT,
    firewalls,
  };
}
