import type { CertificateInfo, ServiceChange, ServiceSnapshot, ServiceWc, FieldChange, FirewallInfo, HaCheck, HaRole, HaState, SwitchChecks, FirewallLogEntry, FirewallSnapshot, RiskWarning, ValidationReport, WorkingCopy } from "@ruledeck/core";

export interface ApiErrorBody {
  kind: string;
  message: string;
  endpoint?: string;
  status?: number;
  siteId?: string;
  validations?: Record<string, string | string[]>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(body.message);
  }
}

export interface PublicTopology {
  hash: string;
  sites: { id: string; name: string; hasSecondary: boolean; interfaces: Record<string, { key: string; label: string }> | null }[];
  logicalInterfaces: string[];
}

export interface SiteView {
  id: string;
  name: string;
  hasSecondary: boolean;
  signedIn: boolean;
  status: "ok" | "signed_out";
  user: string | null;
  method: "password" | "apikey" | null;
  host: string | null;
  info: FirewallInfo | null;
}

export interface SessionView {
  csrfToken: string;
  topologyHash: string;
  sites: SiteView[];
}

export type SiteLogin =
  | { method: "password"; username: string; password: string }
  | { method: "apikey"; apiKey: string; apiSecret: string };

export interface Conflict {
  objectType: "rule" | "alias";
  id: string;
  label: string;
  reason: "modified" | "deleted" | "name_taken" | "order_changed";
  message: string;
  fields?: FieldChange[];
}

export interface ApplyResult {
  outcome: "conflict" | "invalid" | "risky" | "success" | "partial" | "failed" | "unverified";
  conflicts?: Conflict[];
  validation?: ValidationReport;
  risks?: RiskWarning[];
  steps: { label: string; kind: "write" | "activate" | "verify"; status: "done" | "failed" | "skipped"; error?: string }[];
  state: { written: number; totalWrites: number; activated: boolean; verified: boolean };
  verificationProblems?: string[];
  recovery?: string[];
}

let csrfToken = "";
let onUnauthenticated: () => void = () => {};

/** Called when RuleDeck's own session has ended (idle timeout, server restart). */
export function setUnauthenticatedHandler(fn: () => void) {
  onUnauthenticated = fn;
}

async function request<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(method === "POST" ? { "content-type": "application/json", "x-csrf-token": csrfToken } : {}),
      },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new ApiError(0, { kind: "offline", message: "Can't reach the RuleDeck server." });
  }
  const data = (await res.json().catch(() => ({}))) as { error?: ApiErrorBody } & T;
  if (!res.ok) {
    const error = data.error ?? { kind: "http", message: `HTTP ${res.status}` };
    if (res.status === 401 && error.kind === "unauthenticated" && !url.startsWith("/api/auth/")) onUnauthenticated();
    throw new ApiError(res.status, error, data as Record<string, unknown>);
  }
  return data;
}

const site = (id: string) => `/api/sites/${encodeURIComponent(id)}`;

export const api = {
  health: () => request<{ status: string; version: string }>("GET", "/api/health"),
  topology: () => request<PublicTopology>("GET", "/api/topology"),
  async session() {
    const r = await request<SessionView>("GET", "/api/auth/session");
    csrfToken = r.csrfToken;
    return r;
  },
  /** Sign in to several sites at once. Per-site failures come back in siteErrors. */
  async login(sites: Record<string, SiteLogin>) {
    const r = await request<SessionView & { siteErrors: Record<string, ApiErrorBody> }>("POST", "/api/auth/login", { sites });
    csrfToken = r.csrfToken;
    return r;
  },
  async signInSite(id: string, login: SiteLogin) {
    // The server issues a new session id and CSRF token when a site is added.
    const r = await request<SessionView>("POST", `/api/auth/sites/${encodeURIComponent(id)}`, login);
    csrfToken = r.csrfToken;
    return r;
  },
  signOutSite: (id: string) => request<SessionView>("POST", `/api/auth/sites/${encodeURIComponent(id)}/logout`),
  async logout() {
    await request("POST", "/api/auth/logout");
    csrfToken = "";
  },
  connect: (id: string) => request<{ site: SiteView }>("POST", `${site(id)}/connect`),
  snapshot: (id: string) => request<{ snapshot: FirewallSnapshot }>("GET", `${site(id)}/snapshot`),
  log: (id: string, opts: { limit?: number; digest?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.digest) q.set("digest", opts.digest);
    return request<{ entries: FirewallLogEntry[]; missed: boolean }>("GET", `${site(id)}/log?${q}`);
  },
  service: (id: string, svc: string) => request<{ snapshot: ServiceSnapshot; readOnly: boolean }>("GET", `${site(id)}/services/${encodeURIComponent(svc)}`),
  serviceApply: (id: string, svc: string, wc: ServiceWc) =>
    request<{ result: ServiceApplyResult }>("POST", `${site(id)}/services/${encodeURIComponent(svc)}/apply`, {
      baseline: { ...wc.baseline, options: {}, defaults: {} },
      current: { settings: wc.settings, grids: wc.grids },
    }),
  certificates: (id: string) => request<{ certificates: CertificateInfo[] }>("GET", `${site(id)}/certificates`),
  sharedPreflight: (b: SharedBody) => request<{ plans: SitePlan[] }>("POST", "/api/shared/preflight", b),
  sharedApply: (b: SharedBody) => request<{ result: SharedApplyResult }>("POST", "/api/shared/apply", { ...b, confirm: true }),
  ha: (id: string) => request<HaView>("GET", `${site(id)}/ha`),
  haSwitch: (id: string, enter: boolean) => request<{ result: HaSwitchResult }>("POST", `${site(id)}/ha/switch`, { enter }),
  apply: (id: string, wc: WorkingCopy, acknowledgeRisks: boolean) =>
    request<{ result: ApplyResult }>("POST", `${site(id)}/apply`, {
      baseline: wc.baseline,
      current: wc.current,
      confirm: true,
      acknowledgeRisks,
    }),
};

/** Parse OPNsense's downloaded apikey.txt ("key=..." / "secret=..."). */
export function parseApiKeyFile(text: string): { apiKey: string; apiSecret: string } | null {
  const key = /^\s*key\s*=\s*(\S+)\s*$/m.exec(text)?.[1];
  const secret = /^\s*secret\s*=\s*(\S+)\s*$/m.exec(text)?.[1];
  return key && secret ? { apiKey: key, apiSecret: secret } : null;
}

export interface HaView {
  state: HaState;
  role: HaRole;
  peerReachable: boolean;
  enter: SwitchChecks;
  leave: SwitchChecks;
}

export interface HaSwitchResult {
  outcome: "done" | "already" | "refused" | "unverified" | "failed";
  enter: boolean;
  checks: HaCheck[];
  steps: { label: string; status: "done" | "failed" | "skipped"; error?: string }[];
  after: HaState | null;
  message: string;
}

export interface ServiceApplyResult {
  outcome: "success" | "conflict" | "failed" | "partial" | "unverified" | "nothing";
  steps: { label: string; status: "done" | "failed" | "skipped"; error?: string }[];
  conflicts?: { id: string; label: string; message: string }[];
  verificationProblems?: string[];
  changes: Omit<ServiceChange, "patch">[];
  state: { written: number; totalWrites: number; activated: boolean; verified: boolean };
  recovery?: string[];
  secretsNotVerified?: boolean;
}

export interface SitePlan {
  siteId: string;
  siteName: string;
  status: "ready" | "up_to_date" | "blocked";
  reasons: string[];
  /** The site's changes as text. */
  changes: string;
  counts: { create: number; modify: number; delete: number; reorder: number };
  notes: string[];
  conflicts: Conflict[];
  risks: RiskWarning[];
  needsCategory: boolean;
  ha: { configured: boolean; primaryOk: boolean | null; message?: string };
}

export interface SiteOutcome {
  siteId: string;
  siteName: string;
  status: "applied" | "up_to_date" | "failed" | "partial" | "unverified" | "blocked" | "not_attempted";
  result?: ApplyResult;
  ha?: { step: "synced" | "skipped" | "failed"; message?: string };
  sharedCheck?: string[];
}

export interface SharedApplyResult {
  outcome: "success" | "success_with_warnings" | "partial" | "blocked" | "failed";
  plans: SitePlan[];
  sites: SiteOutcome[];
}

export interface SharedBody {
  shared: { baseline: FirewallSnapshot; current: WorkingCopy["current"] };
  sites: Record<string, { baseline: FirewallSnapshot }>;
  acknowledgeRisks: Record<string, boolean>;
  haSync: Record<string, boolean>;
}
