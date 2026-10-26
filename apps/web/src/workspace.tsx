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
import { api, ApiError, type ApplyResult, type SessionView, type SiteView } from "./api.ts";

/**
 * Workspace = the selected site, its signed-in state and the local working
 * copy. The working copy is saved to sessionStorage after every edit, so a
 * reload never silently loses staged changes, while closing the tab or
 * signing out clears it. Nothing is stored on the server.
 */

interface Persisted {
  version: 1;
  savedAt: string;
  baseline: FirewallSnapshot;
  current: WorkingCopy["current"];
}

const STORAGE_PREFIX = "ruledeck.wc.";
const storageKey = (topologyHash: string, siteId: string) => `${STORAGE_PREFIX}${topologyHash}.${siteId}`;

/** Remove every staged working copy from this tab (on sign-out). */
export function clearDrafts() {
  try {
    for (const k of Object.keys(sessionStorage)) if (k.startsWith(STORAGE_PREFIX) || k.startsWith("ruledeck.svc.") || k === "ruledeck.site") sessionStorage.removeItem(k);
  } catch {
    /* storage unavailable */
  }
}

function loadPersisted(key: string): Persisted | null {
  try {
    const raw = sessionStorage.getItem(key);
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

/** Save a working copy as this tab's draft (or drop the draft when nothing is staged). */
function persistDraft(key: string, wc: WorkingCopy) {
  try {
    if (hasChanges(wc)) {
      const p: Persisted = { version: 1, savedAt: new Date().toISOString(), baseline: wc.baseline, current: wc.current };
      sessionStorage.setItem(key, JSON.stringify(p));
    } else {
      sessionStorage.removeItem(key);
    }
  } catch {
    /* storage full or unavailable: edits stay in memory */
  }
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

export interface ApplyRecord {
  at: string;
  siteId: string;
  siteName: string;
  user: string | null;
  result: ApplyResult;
}

interface WorkspaceValue {
  sites: SiteView[];
  siteId: string | null;
  site: SiteView | null;
  selectSite: (id: string) => void;
  /** Site the user is asked to sign in to (again), if any. */
  signInPrompt: string | null;
  promptSignIn: (siteId: string | null) => void;
  /** Store a new session view; optionally switch to a site that is now signed in. */
  updateSession: (s: SessionView, switchTo?: string) => void;
  /** Apply results of this tab (memory only; the firewall's config history is the real record). */
  applyHistory: ApplyRecord[];
  recordApply: (r: ApplyResult) => void;
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
  /** Working copy of any signed-in site: the open one, a staged draft of this tab, or a fresh read. */
  loadSiteCopy: (id: string) => Promise<WorkingCopy>;
  /** Stage edits at any site (the open one directly, others as a draft of this tab). Throws on failure. */
  stageAtSite: (id: string, fn: (wc: WorkingCopy) => WorkingCopy) => Promise<void>;
}

const Ctx = createContext<WorkspaceValue | null>(null);

export function useWorkspace(): WorkspaceValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspace outside provider");
  return v;
}

export function WorkspaceProvider({
  session,
  onSession,
  children,
}: {
  session: SessionView;
  onSession: (s: SessionView) => void;
  children: ReactNode;
}) {
  const sites = session.sites;
  const [siteId, setSiteId] = useState<string | null>(() => {
    try {
      const saved = sessionStorage.getItem("ruledeck.site");
      if (saved && sites.some((s) => s.id === saved && s.signedIn)) return saved;
    } catch {
      /* ignore */
    }
    return sites.find((s) => s.signedIn)?.id ?? null;
  });
  const site = sites.find((s) => s.id === siteId) ?? null;
  // Guards against late responses for a site the user already switched away from.
  const siteIdRef = useRef(siteId);
  siteIdRef.current = siteId;
  const loadSeq = useRef(0);
  const [signInPrompt, setSignInPrompt] = useState<string | null>(null);
  const [applyHistory, setApplyHistory] = useState<ApplyRecord[]>([]);
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

  /** Turn "your firewall session ended" errors into a sign-in prompt. */
  const handleError = useCallback((err: unknown, fallback: string): string => {
    if (err instanceof ApiError && err.body.kind === "site_signed_out" && err.body.siteId) {
      setSignInPrompt(err.body.siteId);
      return err.message;
    }
    return err instanceof ApiError ? err.message : fallback;
  }, []);

  // Persist after every change (under the site the working copy belongs to).
  useEffect(() => {
    if (!wc) return;
    persistDraft(storageKey(session.topologyHash, wc.baseline.firewallId), wc);
  }, [wc, session.topologyHash]);

  const reload = useCallback(
    async (opts: { discardLocal?: boolean } = {}) => {
      if (!siteId) {
        setWc(null);
        return;
      }
      const key = storageKey(session.topologyHash, siteId);
      const seq = ++loadSeq.current;
      const stale = () => seq !== loadSeq.current || siteIdRef.current !== siteId;
      setLoading(true);
      setLoadError(null);
      try {
        const { snapshot } = await api.snapshot(siteId);
        if (stale()) return;
        const persisted = opts.discardLocal ? null : loadPersisted(key);
        if (opts.discardLocal) sessionStorage.removeItem(key);
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
        if (stale()) return;
        setWc(null);
        setLoadError(handleError(err, "Failed to load the firewall configuration."));
      } finally {
        if (!stale()) setLoading(false);
      }
    },
    [siteId, session.topologyHash, handleError],
  );

  const checkForExternalChanges = useCallback(async () => {
    const cur = wcRef.current;
    if (!siteId || !cur) return;
    try {
      const { snapshot } = await api.snapshot(siteId);
      if (siteIdRef.current !== siteId || wcRef.current?.baseline.firewallId !== siteId) return;
      const changed = diffFingerprints(cur.baseline, snapshot);
      setExternalChanges(changed);
      if (!changed.length) notify("info", "No changes on the firewall since you loaded it.");
    } catch (err) {
      notify("error", handleError(err, "Could not check the firewall."));
    }
  }, [siteId, notify, handleError]);

  const rebaseOntoFirewall = useCallback(async () => {
    const cur = wcRef.current;
    if (!siteId || !cur) return null;
    try {
      const { snapshot } = await api.snapshot(siteId);
      if (siteIdRef.current !== siteId || wcRef.current !== cur) return null;
      const r = rebase(cur, snapshot);
      wcRef.current = r.wc;
      setWc(r.wc);
      setExternalChanges([]);
      setRestoredFrom(null);
      return r.notes;
    } catch (err) {
      notify("error", handleError(err, "Could not read the firewall."));
      return null;
    }
  }, [siteId, notify, handleError]);

  const loadSiteCopy = useCallback(
    async (id: string): Promise<WorkingCopy> => {
      if (id === siteIdRef.current && wcRef.current) return wcRef.current;
      const { snapshot } = await api.snapshot(id);
      const persisted = loadPersisted(storageKey(session.topologyHash, id));
      return persisted
        ? { baseline: persisted.baseline, current: relink(persisted.baseline, persisted.current), past: [], future: [] }
        : createWorkingCopy(snapshot);
    },
    [session.topologyHash],
  );

  const stageAtSite = useCallback(
    async (id: string, fn: (wc: WorkingCopy) => WorkingCopy) => {
      if (id === siteIdRef.current && wcRef.current) {
        if (!edit(fn)) throw new WorkingCopyError("The change could not be staged.");
        return;
      }
      const next = fn(await loadSiteCopy(id));
      persistDraft(storageKey(session.topologyHash, id), next);
    },
    [edit, loadSiteCopy, session.topologyHash],
  );

  const selectSite = useCallback(
    (id: string) => {
      const target = sites.find((s) => s.id === id);
      if (!target) return;
      if (!target.signedIn) {
        setSignInPrompt(id);
        return;
      }
      try {
        sessionStorage.setItem("ruledeck.site", id);
      } catch {
        /* ignore */
      }
      setWc(null);
      setSiteId(id);
    },
    [sites],
  );

  const updateSession = useCallback(
    (s: SessionView, switchTo?: string) => {
      onSession(s);
      const target = switchTo && s.sites.find((x) => x.id === switchTo)?.signedIn ? switchTo : siteId;
      if (!target || !s.sites.find((x) => x.id === target)?.signedIn) {
        setWc(null);
        setSiteId(s.sites.find((x) => x.signedIn)?.id ?? null);
      } else if (target !== siteId) {
        try {
          sessionStorage.setItem("ruledeck.site", target);
        } catch {
          /* ignore */
        }
        setWc(null);
        setSiteId(target);
      } else if (loadError) {
        void reload();
      }
    },
    [onSession, siteId, loadError, reload],
  );

  const recordApply = useCallback(
    (result: ApplyResult) => {
      if (!site) return;
      setApplyHistory((h) => [{ at: new Date().toISOString(), siteId: site.id, siteName: site.name, user: site.user, result }, ...h].slice(0, 50));
    },
    [site],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  const changeSet = useMemo(() => (wc ? computeChangeSet(wc) : null), [wc]);
  const validation = useMemo(
    () => (wc ? validateWorkingState(wc.current, wc.baseline.options, wc.baseline) : null),
    [wc],
  );

  const value: WorkspaceValue = {
    sites,
    siteId,
    site,
    selectSite,
    signInPrompt,
    promptSignIn: setSignInPrompt,
    updateSession,
    applyHistory,
    recordApply,
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
    loadSiteCopy,
    stageAtSite,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Ids of rules/aliases whose fingerprint differs (or that appeared/disappeared). */
export function diffFingerprints(a: FirewallSnapshot, b: FirewallSnapshot): string[] {
  const ids = new Set([...Object.keys(a.fingerprints), ...Object.keys(b.fingerprints)]);
  return [...ids].filter((id) => a.fingerprints[id] !== b.fingerprints[id]);
}
