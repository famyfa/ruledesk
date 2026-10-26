import { runSwitch, type SwitchResult } from "./ha.ts";
import type { FirewallSnapshot, WorkingCopy } from "@ruledeck/core";
import {
  featuresFor,
  loginWithPassword,
  logoutSession,
  OpnsenseClient,
  OpnsenseError,
  type Credentials,
} from "@ruledeck/opnsense-client";
import { runApply, type ApplyResult } from "./apply.ts";
import { track, type SiteSession } from "./auth.ts";
import type { SiteConfig } from "./topology.ts";

export type SiteLogin =
  | { method: "password"; username: string; password: string }
  | { method: "apikey"; apiKey: string; apiSecret: string };

export interface SignInError {
  kind: string;
  message: string;
}

/**
 * Sign in to a site's primary firewall with the user's own credentials and
 * prove it works. Returns a live SiteSession; nothing is stored.
 */
export async function signInSite(site: SiteConfig, login: SiteLogin): Promise<SiteSession> {
  const endpoint = site.primary;
  let credentials: Credentials;
  let user: string;
  if (login.method === "password") {
    credentials = (await loginWithPassword(endpoint, login.username, login.password)).credentials;
    user = login.username;
  } else {
    credentials = { kind: "apikey", apiKey: login.apiKey, apiSecret: login.apiSecret };
    user = `API key …${login.apiKey.slice(-4)}`;
  }
  const client = new OpnsenseClient({ ...endpoint, auth: credentials });
  try {
    const { version } = await client.probe();
    return {
      siteId: site.id,
      client,
      endpoint,
      method: login.method,
      user,
      status: "ok",
      inflight: new Set(),
      info: { id: site.id, name: site.name, productVersion: version ?? "unknown", features: featuresFor(version) },
    };
  } catch (err) {
    await endSiteSession({ client, endpoint, method: login.method, inflight: new Set() });
    throw err;
  }
}

/**
 * Close the client and, for GUI sessions, log out of the firewall too.
 * Waits for in-flight work (an apply) first, so it is never cut off halfway.
 */
export async function endSiteSession(s: Pick<SiteSession, "client" | "endpoint" | "method" | "inflight">) {
  while (s.inflight.size) await Promise.allSettled([...s.inflight]);
  try {
    if (s.method === "password") await logoutSession(s.endpoint, s.client.credentials);
  } finally {
    await s.client.close().catch(() => {});
  }
}

export function signInError(err: unknown): SignInError {
  if (err instanceof OpnsenseError) {
    if (err.kind === "auth") return { kind: "invalid_credentials", message: "Wrong username or password (or API key)." };
    if (err.kind === "forbidden") {
      return { kind: "forbidden", message: "Signed in, but the firewall refused to list rules. Your OPNsense user probably lacks the \"Firewall: Rules\" privileges." };
    }
    return { kind: err.kind, message: err.message };
  }
  return { kind: "internal", message: "Sign-in failed." };
}

export async function snapshotOf(s: SiteSession): Promise<FirewallSnapshot> {
  const res = await track(s, () => s.client.readAll());
  return { firewallId: s.siteId, loadedAt: new Date().toISOString(), ...res };
}

/** One apply per site at a time, across all users. */
const applying = new Set<string>();

export async function applyToSite(s: SiteSession, wc: WorkingCopy, opts: { acknowledgeRisks: boolean }): Promise<ApplyResult> {
  if (applying.has(s.siteId)) throw new OpnsenseError("rejected", "Another apply is already running for this site.");
  applying.add(s.siteId);
  try {
    return await track(s, () => runApply(s.client, wc, opts));
  } finally {
    applying.delete(s.siteId);
  }
}

/** HA switch under the same per-site lock as apply (no apply while VIPs move, and vice versa). */
export async function haSwitchSite(s: SiteSession, enter: boolean): Promise<SwitchResult> {
  if (applying.has(s.siteId)) throw new OpnsenseError("rejected", "Another change is already running for this site.");
  applying.add(s.siteId);
  try {
    return await track(s, () => runSwitch(s.client, enter));
  } finally {
    applying.delete(s.siteId);
  }
}
