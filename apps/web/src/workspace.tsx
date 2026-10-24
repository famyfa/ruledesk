import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  computeChangeSet,
  createWorkingCopy,
  rebase,
  validateWorkingState,
  WorkingCopyError,
  type ChangeSet,
  type FirewallSnapshot,
  type ValidationReport,
  type WorkingCopy,
} from "@ruledeck/core";
import { api, ApiError, type ConnectionState, type FirewallSummary } from "./api.ts";

/**
 * Workspace = the selected firewall, its connection state and the local
 * working copy. The working copy is saved to localStorage after every edit so
 * a reload never silently loses staged changes.
 */

interface Persisted {
  version: 1;
  savedAt: string;
  baseline: FirewallSnapshot;
  current: WorkingCopy["current"];
}

const storageKey = (firewallId: string) => `ruledeck.workingCopy.${firewallId}`;

function loadPersisted(firewallId: string): Persisted | null {
  try {
    const raw = localStorage.getItem(storageKey(firewallId));
    if (!raw) return null;
    const p = JSON.parse(raw) as Persisted;
    return p.version === 1 ? p : null;
  } catch {
    return null;
  }
}

function hasChanges(wc: WorkingCopy): boolean {
  return computeChangeSet(wc).changes.length > 0;
}

/** Re-link current objects to baseline objects where they're equal, so "unchanged" detection by identity works after a reload. */
function relink(baseline: FirewallSnapshot, current: WorkingCopy["current"]): WorkingCopy["current"] {
  const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const baseRules = new Map(baseline.rules.map((r) => [r.id, r]));
  const baseAliases = new Map(baseline.aliases.map((a) => [a.id, a]));
  return {
    ...current,
    rules: current.rules.map((r) => {
      const b = baseRules.get(r.id);
      return b && sameJson(b, r) ? b : r;
    }),
    aliases: current.aliases.map((a) => {
      const b = baseAliases.get(a.id);
      return b && sameJson(b, a) ? b : a;
    }),
  };
}

export interface Notice {
  id: number;
  tone: "info" | "error" | "success";
  text: string;
}

interface WorkspaceValue {
  firewalls: FirewallSummary[];
  firewallId: string | null;
  connection: ConnectionState;
  wc: WorkingCopy | null;
  changeSet: ChangeSet | null;
  validation: ValidationReport | null;
  loading: boolean;
  loadError: string | null;
  /** Objects changed on the firewall since our baseline was loaded. */
  externalChanges: string[];
  restoredFrom: string | null;
  notices: Notice[];
  edit: (fn: (wc: WorkingCopy) => WorkingCopy) => boolean;
  notify: (tone: Notice["tone"], text: string) => void;
  dismiss: (id: number) => void;
  reload: (opts?: { discardLocal?: boolean }) => Promise<void>;
  checkForExternalChanges: () => Promise<void>;
  /** Re-read the firewall and replay staged edits on top. Returns notes about anything dropped. */
  rebaseOntoFirewall: () => Promise<string[] | null>;
}

const Ctx = createContext<WorkspaceValue | null>(null);

export function useWorkspace(): WorkspaceValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspace outside provider");
  return v;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [firewalls, setFirewalls] = useState<FirewallSummary[]>([]);
  const [firewallId, setFirewallId] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>({ status: "unknown" });
  const [wc, setWc] = useState<WorkingCopy | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [externalChanges, setExternalChanges] = useState<string[]>([]);
  const [restoredFrom, setRestoredFrom] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const noticeId = useRef(0);
  const wcRef = useRef<WorkingCopy | null>(null);
  wcRef.current = wc;

  const notify = useCallback((tone: Notice["tone"], text: string) => {
    const id = ++noticeId.current;
    setNotices((n) => [...n.slice(-3), { id, tone, text }]);
    if (tone !== "error") setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), 4000);
  }, []);
  const dismiss = useCallback((id: number) => setNotices((n) => n.filter((x) => x.id !== id)), []);

  const edit = useCallback(
    (fn: (wc: WorkingCopy) => WorkingCopy) => {
      const cur = wcRef.current;
      if (!cur) return false;
      try {
        const next = fn(cur);
        wcRef.current = next;
        setWc(next);
        return true;
      } catch (err) {
        if (err instanceof WorkingCopyError) {
          notify("error", err.message);
          return false;
        }
        throw err;
      }
    },
    [notify],
  );

  // Persist after every change.
  useEffect(() => {
    if (!wc || !firewallId) return;
    try {
      if (hasChanges(wc)) {
        const p: Persisted = { version: 1, savedAt: new Date().toISOString(), baseline: wc.baseline, current: wc.current };
        localStorage.setItem(storageKey(firewallId), JSON.stringify(p));
      } else {
        localStorage.removeItem(storageKey(firewallId));
      }
    } catch {
      /* storage full or unavailable: edits stay in memory */
    }
  }, [wc, firewallId]);

  const reload = useCallback(
    async (opts: { discardLocal?: boolean } = {}) => {
      if (!firewallId) return;
      setLoading(true);
      setLoadError(null);
      try {
        const { state } = await api.connect(firewallId);
        setConnection(state);
        if (state.status !== "connected") {
          setLoadError(state.status === "error" ? state.error.message : "Not connected.");
          return;
        }
        const { snapshot } = await api.snapshot(firewallId);
        const persisted = opts.discardLocal ? null : loadPersisted(firewallId);
        if (opts.discardLocal) localStorage.removeItem(storageKey(firewallId));
        if (persisted) {
          // Keep the user's staged work against the baseline it was made on.
          const restored: WorkingCopy = {
            baseline: persisted.baseline,
            current: relink(persisted.baseline, persisted.current),
            past: [],
            future: [],
          };
          setWc(restored);
          setRestoredFrom(persisted.savedAt);
          setExternalChanges(diffFingerprints(persisted.baseline, snapshot));
        } else {
          setWc(createWorkingCopy(snapshot));
          setRestoredFrom(null);
          setExternalChanges([]);
        }
      } catch (err) {
        setLoadError(err instanceof ApiError ? err.message : "Failed to load the firewall configuration.");
      } finally {
        setLoading(false);
      }
    },
    [firewallId],
  );

  const checkForExternalChanges = useCallback(async () => {
    const cur = wcRef.current;
    if (!firewallId || !cur) return;
    try {
      const { snapshot } = await api.snapshot(firewallId);
      const changed = diffFingerprints(cur.baseline, snapshot);
      setExternalChanges(changed);
      if (!changed.length) notify("info", "No changes on the firewall since you loaded it.");
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "Could not check the firewall.");
    }
  }, [firewallId, notify]);

  const rebaseOntoFirewall = useCallback(async () => {
    const cur = wcRef.current;
    if (!firewallId || !cur) return null;
    try {
      const { snapshot } = await api.snapshot(firewallId);
      const r = rebase(cur, snapshot);
      wcRef.current = r.wc;
      setWc(r.wc);
      setExternalChanges([]);
      setRestoredFrom(null);
      return r.notes;
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "Could not read the firewall.");
      return null;
    }
  }, [firewallId, notify]);

  useEffect(() => {
    api
      .firewalls()
      .then(({ firewalls }) => {
        setFirewalls(firewalls);
        setFirewallId((id) => id ?? firewalls[0]?.id ?? null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Failed to list firewalls."));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const changeSet = useMemo(() => (wc ? computeChangeSet(wc) : null), [wc]);
  const validation = useMemo(
    () => (wc ? validateWorkingState(wc.current, wc.baseline.options, wc.baseline) : null),
    [wc],
  );

  const value: WorkspaceValue = {
    firewalls,
    firewallId,
    connection,
    wc,
    changeSet,
    validation,
    loading,
    loadError,
    externalChanges,
    restoredFrom,
    notices,
    edit,
    notify,
    dismiss,
    reload,
    checkForExternalChanges,
    rebaseOntoFirewall,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Ids of rules/aliases whose fingerprint differs (or that appeared/disappeared). */
export function diffFingerprints(a: FirewallSnapshot, b: FirewallSnapshot): string[] {
  const ids = new Set([...Object.keys(a.fingerprints), ...Object.keys(b.fingerprints)]);
  return [...ids].filter((id) => a.fingerprints[id] !== b.fingerprints[id]);
}
