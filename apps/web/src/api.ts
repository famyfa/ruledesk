import type { FieldChange, FirewallInfo, FirewallSnapshot, RiskWarning, ValidationReport, WorkingCopy } from "@ruledeck/core";

export interface ApiErrorBody {
  kind: string;
  message: string;
  endpoint?: string;
  status?: number;
  validations?: Record<string, string | string[]>;
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: ApiErrorBody) {
    super(body.message);
  }
}

export type ConnectionState =
  | { status: "unknown" }
  | { status: "connected"; info: FirewallInfo; checkedAt: string }
  | { status: "error"; error: ApiErrorBody; checkedAt: string };

export interface FirewallSummary {
  id: string;
  name: string;
  host: string;
  state: ConnectionState;
}

export interface AuditEvent {
  id: number;
  at: string;
  user: string;
  action: string;
  firewallId: string | null;
  outcome: string;
  details: Record<string, unknown>;
}

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
  if (!res.ok) throw new ApiError(res.status, data.error ?? { kind: "http", message: `HTTP ${res.status}` });
  return data;
}

export const api = {
  async session() {
    const r = await request<{ user: string; csrfToken: string }>("GET", "/api/auth/session");
    csrfToken = r.csrfToken;
    return r;
  },
  async login(username: string, password: string) {
    const r = await request<{ user: string; csrfToken: string }>("POST", "/api/auth/login", { username, password });
    csrfToken = r.csrfToken;
    return r;
  },
  async logout() {
    await request("POST", "/api/auth/logout");
    csrfToken = "";
  },
  firewalls: () => request<{ firewalls: FirewallSummary[] }>("GET", "/api/firewalls"),
  connect: (id: string) => request<{ state: ConnectionState }>("POST", `/api/firewalls/${encodeURIComponent(id)}/connect`),
  snapshot: (id: string) => request<{ snapshot: FirewallSnapshot }>("GET", `/api/firewalls/${encodeURIComponent(id)}/snapshot`),
  audit: () => request<{ events: AuditEvent[] }>("GET", "/api/audit"),
  apply: (id: string, wc: WorkingCopy, acknowledgeRisks: boolean) =>
    request<{ result: ApplyResult }>("POST", `/api/firewalls/${encodeURIComponent(id)}/apply`, {
      baseline: wc.baseline,
      current: wc.current,
      confirm: true,
      acknowledgeRisks,
    }),
};
