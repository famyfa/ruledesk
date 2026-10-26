import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  buildSharedView,
  computeChangeSet,
  createWorkingCopy,
  validateWorkingState,
  WorkingCopyError,
  type ChangeSet,
  type FirewallSnapshot,
  type SharedView,
  type ValidationReport,
  type WorkingCopy,
} from "@ruledeck/core";
import { api, ApiError, type PublicTopology, type SharedApplyResult, type SitePlan } from "./api.ts";
import { relink, WorkspaceContext, type WorkspaceValue } from "./workspace.tsx";

/**
 * Shared policy (all sites). Rules and aliases that carry the "RuleDeck shared" marker exist with the
 * same identity on every site. Here they are edited once, with logical interface names (DMZ, WAN, ...),
 * and applied to every site in one go. The browser keeps the working copy (sessionStorage); the server
 * recomputes each site's changes itself and writes one site at a time.
 */

const STORAGE_KEY = "ruledeck.wc.shared"; // under the workspace prefix, so signing out clears it

interface Persisted {
  baseline: FirewallSnapshot;
  current: WorkingCopy["current"];
}

export interface SharedValue {
  topology: PublicTopology | null;
  view: SharedView | null;
  /** The per-site snapshots the shared view was built from (sent along when applying). */
  siteSnapshots: Record<string, FirewallSnapshot>;
  wc: WorkingCopy | null;
  changeSet: ChangeSet | null;
  validation: ValidationReport | null;
  loading: boolean;
  loadError: string | null;
  /** Topology sites that are not signed in (the shared view can't cover them). */
  missingSites: string[];
  siteNames: string[];
  edit: (fn: (wc: WorkingCopy) => WorkingCopy) => boolean;
  ensureLoaded: () => void;
  reload: (opts?: { discardLocal?: boolean }) => Promise<void>;
  preflight: (ack: Record<string, boolean>, haSync: Record<string, boolean>) => Promise<SitePlan[]>;
  /** After writing to the sites: reload the open site's view (or just flag the changes if it has staged edits). */
  refreshOpenSite: () => void;
  apply: (ack: Record<string, boolean>, haSync: Record<string, boolean>) => Promise<SharedApplyResult>;
}

const SharedCtx = createContext<SharedValue | null>(null);

export function useShared(): SharedValue {
  const v = useContext(SharedCtx);
  if (!v) throw new Error("useShared outside SharedProvider");
  return v;
}

function loadPersisted(): Persisted | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Persisted) : null;
  } catch {
    return null;
  }
}

export function SharedProvider({ children }: { children: ReactNode }) {
  const base = useContext(WorkspaceContext)!;
  const { sites, notify } = base;
  const [topology, setTopology] = useState<PublicTopology | null>(null);
  const [view, setView] = useState<SharedView | null>(null);
  const [siteSnapshots, setSiteSnapshots] = useState<Record<string, FirewallSnapshot>>({});
  const [wc, setWc] = useState<WorkingCopy | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [wanted, setWanted] = useState(false);
  const wcRef = useRef<WorkingCopy | null>(null);
  wcRef.current = wc;
  const seq = useRef(0);

  const signedKey = sites.filter((s) => s.signedIn).map((s) => s.id).join(",");

  const load = useCallback(
    async (discardLocal = false) => {
      const mine = ++seq.current;
      setLoading(true);
      setLoadError(null);
      try {
        const topo = await api.topology();
        if (mine !== seq.current) return;
        setTopology(topo);
        if (topo.sites.some((s) => !s.interfaces)) {
          throw new Error("The server's topology file has no interface map, so there is no shared policy. See docs/multi-site.md (the \"interfaces\" section of the topology file).");
        }
        const signedIn = topo.sites.filter((s) => base.sites.find((x) => x.id === s.id)?.signedIn);
        if (!signedIn.length) throw new Error("Sign in to your sites first (Sites tab).");
        const snaps: Record<string, FirewallSnapshot> = {};
        await Promise.all(signedIn.map(async (s) => void (snaps[s.id] = (await api.snapshot(s.id)).snapshot)));
        if (mine !== seq.current) return;
        const v = buildSharedView(signedIn.map((s) => ({ siteId: s.id, siteName: s.name, map: s.interfaces!, snapshot: snaps[s.id]! })));
        setSiteSnapshots(snaps);
        setView(v);
        const saved = discardLocal ? null : loadPersisted();
        if (discardLocal) sessionStorage.removeItem(STORAGE_KEY);
        setWc(saved ? { baseline: saved.baseline, current: relink(saved.baseline, saved.current), past: [], future: [] } : createWorkingCopy(v.baseline));
      } catch (err) {
        if (mine !== seq.current) return;
        setWc(null);
        setLoadError(err instanceof ApiError || err instanceof Error ? err.message : "Couldn't build the shared view.");
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [base.sites],
  );

  // Load once something shows the shared view, and again when the set of signed-in sites changes.
  useEffect(() => {
    if (wanted) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, signedKey]);

  // Persist the staged shared changes.
  useEffect(() => {
    if (!wc) return;
    try {
      if (computeChangeSet(wc).changes.length) sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ baseline: wc.baseline, current: wc.current } satisfies Persisted));
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
  }, [wc]);

  const edit = useCallback(
    (fn: (w: WorkingCopy) => WorkingCopy) => {
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

  const changeSet = useMemo(() => (wc ? computeChangeSet(wc) : null), [wc]);
  const validation = useMemo(() => (wc ? validateWorkingState(wc.current, wc.baseline.options, wc.baseline) : null), [wc]);

  const body = useCallback(
    (ack: Record<string, boolean>, haSync: Record<string, boolean>) => {
      if (!wc) throw new Error("The shared view isn't loaded.");
      return {
        shared: { baseline: wc.baseline, current: wc.current },
        sites: Object.fromEntries(Object.entries(siteSnapshots).map(([id, baseline]) => [id, { baseline }])),
        acknowledgeRisks: ack,
        haSync,
      };
    },
    [wc, siteSnapshots],
  );

  const value: SharedValue = {
    topology,
    view,
    siteSnapshots,
    wc,
    changeSet,
    validation,
    loading,
    loadError,
    missingSites: (topology?.sites ?? []).filter((s) => !sites.find((x) => x.id === s.id)?.signedIn).map((s) => s.name),
    siteNames: (topology?.sites ?? []).map((s) => s.name),
    edit,
    ensureLoaded: () => setWanted(true),
    reload: (opts) => load(!!opts?.discardLocal),
    preflight: async (ack, haSync) => (await api.sharedPreflight(body(ack, haSync))).plans,
    refreshOpenSite: () => {
      if ((base.changeSet?.changes.length ?? 0) === 0) void base.reload();
      else void base.checkForExternalChanges();
    },
    apply: async (ack, haSync) => (await api.sharedApply(body(ack, haSync))).result,
  };
  return <SharedCtx.Provider value={value}>{children}</SharedCtx.Provider>;
}

/**
 * Inside this scope the rule and alias screens, the toolbar and the apply button work on the shared policy
 * instead of the open site. Outside (`active` false) nothing changes.
 */
export function SharedScope({ active, children }: { active: boolean; children: ReactNode }) {
  const base = useContext(WorkspaceContext)!;
  const sh = useShared();
  const { ensureLoaded } = sh;
  useEffect(() => {
    if (active) ensureLoaded();
  }, [active, ensureLoaded]);

  const value = useMemo<WorkspaceValue>(
    () =>
      !active
        ? base
        : {
            ...base,
            shared: { siteNames: sh.siteNames },
            siteId: null,
            site: null,
            wc: sh.wc,
            changeSet: sh.changeSet,
            validation: sh.validation,
            loading: sh.loading,
            loadError: sh.loadError,
            externalChanges: [],
            restoredFrom: null,
            edit: sh.edit,
            reload: sh.reload,
            checkForExternalChanges: async () => {},
            rebaseOntoFirewall: async () => null,
          },
    [active, base, sh],
  );
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
