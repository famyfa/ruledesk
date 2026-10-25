import {
  computeChangeSet,
  formatChangeSet,
  interfaceGuards,
  lockoutWarnings,
  objectUuid,
  projectToSite,
  SHARED_CATEGORY_COLOR,
  SHARED_CATEGORY_NAME,
  SHARED_CATEGORY_UUID,
  sharedStateMatches,
  touchedUuids,
  validateWorkingState,
  type FirewallSnapshot,
  type RiskWarning,
  type WorkingCopy,
  type WorkingState,
} from "@ruledeck/core";
import { OpnsenseError } from "@ruledeck/opnsense-client";
import { detectConflicts, type ApplyResult, type Conflict } from "./apply.ts";
import { track, type Session, type SiteSession } from "./auth.ts";
import { applyToSite } from "./sites.ts";
import type { SiteConfig, Topology } from "./topology.ts";

/**
 * Shared (multi-site) apply. The browser sends the shared working copy plus
 * the per-site snapshots it was built from; the server recomputes each site's
 * changes itself (projectToSite) using the topology's interface maps.
 *
 * Preflight is read-only on every site. Apply runs one site at a time in
 * topology order and stops at the first site that doesn't fully succeed.
 */

export interface SharedRequest {
  shared: { baseline: FirewallSnapshot; current: WorkingState };
  sites: Record<string, { baseline: FirewallSnapshot }>;
  acknowledgeRisks: Record<string, boolean>;
  haSync: Record<string, boolean>;
}

export interface SitePlan {
  siteId: string;
  siteName: string;
  status: "ready" | "up_to_date" | "blocked";
  reasons: string[];
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

interface Prepared {
  plan: SitePlan;
  wc: WorkingCopy | null;
  session: SiteSession | null;
  cfg: SiteConfig;
}

async function prepareSite(cfg: SiteConfig, session: SiteSession | undefined, shared: WorkingCopy, req: SharedRequest): Promise<Prepared> {
  const plan: SitePlan = {
    siteId: cfg.id,
    siteName: cfg.name,
    status: "blocked",
    reasons: [],
    changes: "",
    counts: { create: 0, modify: 0, delete: 0, reorder: 0 },
    notes: [],
    conflicts: [],
    risks: [],
    needsCategory: false,
    ha: { configured: !!cfg.secondary, primaryOk: null },
  };
  const out: Prepared = { plan, wc: null, session: session ?? null, cfg };
  if (!session || session.status !== "ok") {
    plan.reasons.push(`Sign in to ${cfg.name} first.`);
    return out;
  }
  if (!cfg.interfaces) {
    plan.reasons.push("The topology has no interface map for this site.");
    return out;
  }
  if (!session.info.features.rulesWrite || !session.info.features.aliasesWrite) {
    plan.reasons.push(session.info.features.notes[0] ?? "Editing isn't supported on this firewall version.");
    return out;
  }
  const baseline = req.sites[cfg.id]?.baseline;
  if (!baseline || baseline.firewallId !== cfg.id) {
    plan.reasons.push("Missing the snapshot this site's changes were based on. Reload the shared view.");
    return out;
  }
  try {
    const live = await track(session, () => session.client.readAll());
    plan.reasons.push(...interfaceGuards(cfg.interfaces, live.options.interfaces));

    const projection = projectToSite({ siteId: cfg.id, siteName: cfg.name, map: cfg.interfaces, snapshot: baseline }, shared);
    plan.reasons.push(...projection.errors);
    plan.notes = projection.notes;
    const wc = projection.wc;
    out.wc = wc;

    const set = computeChangeSet(wc);
    plan.counts = set.counts;
    plan.changes = formatChangeSet(set);
    plan.conflicts = detectConflicts(wc, live);
    if (plan.conflicts.length) plan.reasons.push(`${plan.conflicts.length} conflict(s) with changes made on the firewall since you loaded it.`);
    const validation = validateWorkingState(wc.current, live.options, wc.baseline);
    if (validation.errorCount) plan.reasons.push(`${validation.errorCount} validation problem(s) at this site.`);
    plan.risks = lockoutWarnings(wc);

    // Marker category: present, or creatable under our fixed uuid.
    const cats = await track(session, () => session.client.listCategories());
    const ours = cats.find((c) => c.uuid === SHARED_CATEGORY_UUID);
    const clash = cats.find((c) => c.name === SHARED_CATEGORY_NAME && c.uuid !== SHARED_CATEGORY_UUID);
    if (clash) plan.reasons.push(`A category named "${SHARED_CATEGORY_NAME}" already exists with another identity. Rename or delete it in OPNsense.`);
    plan.needsCategory = !ours && set.changes.length > 0;

    // HA: only ever write to the primary.
    if (cfg.secondary) {
      try {
        const ha = await track(session, () => session.client.getHaSync());
        plan.ha.primaryOk = !!ha.synchronizeToIp;
        if (!ha.synchronizeToIp) plan.reasons.push("This firewall has no HA sync target. Is it really the primary? RuleDeck only writes to primaries.");
      } catch (err) {
        plan.ha.primaryOk = null;
        plan.reasons.push(err instanceof OpnsenseError && err.kind === "forbidden" ? "Your user can't read the HA settings, so RuleDeck can't confirm this is the primary." : "Couldn't read the HA settings.");
      }
    }
    if (plan.risks.length && !req.acknowledgeRisks[cfg.id]) plan.notes.push("Lockout warnings must be acknowledged for this site.");
    plan.status = plan.reasons.length ? "blocked" : set.changes.length ? "ready" : "up_to_date";
  } catch (err) {
    plan.reasons.push(err instanceof OpnsenseError ? err.message : "Couldn't read the firewall.");
  }
  return out;
}

export async function sharedPreflight(topology: Topology, session: Session, req: SharedRequest): Promise<SitePlan[]> {
  const shared: WorkingCopy = { baseline: req.shared.baseline, current: req.shared.current, past: [], future: [] };
  const prepared = await Promise.all(topology.sites.map((cfg) => prepareSite(cfg, session.sites.get(cfg.id), shared, req)));
  return prepared.map((p) => p.plan);
}

export async function sharedApply(topology: Topology, session: Session, req: SharedRequest): Promise<SharedApplyResult> {
  const shared: WorkingCopy = { baseline: req.shared.baseline, current: req.shared.current, past: [], future: [] };
  const prepared = await Promise.all(topology.sites.map((cfg) => prepareSite(cfg, session.sites.get(cfg.id), shared, req)));
  const plans = prepared.map((p) => p.plan);
  const unacked = prepared.filter((p) => p.plan.risks.length && !req.acknowledgeRisks[p.cfg.id]);
  if (plans.some((p) => p.status === "blocked") || unacked.length) {
    return { outcome: "blocked", plans, sites: plans.map((p) => ({ siteId: p.siteId, siteName: p.siteName, status: p.status === "blocked" ? "blocked" : "not_attempted" })) };
  }

  const touched = touchedUuids(shared);
  const outcomes: SiteOutcome[] = [];
  let stopped = false;
  for (const p of prepared) {
    const base: SiteOutcome = { siteId: p.cfg.id, siteName: p.cfg.name, status: "not_attempted" };
    if (stopped) {
      outcomes.push(base);
      continue;
    }
    if (p.plan.status === "up_to_date") {
      outcomes.push({ ...base, status: "up_to_date" });
      continue;
    }
    const s = p.session!;
    try {
      if (p.plan.needsCategory) {
        await track(s, () => s.client.upsertCategory(SHARED_CATEGORY_UUID, { name: SHARED_CATEGORY_NAME, color: SHARED_CATEGORY_COLOR }));
      }
      const result = await applyToSite(s, p.wc!, { acknowledgeRisks: !!req.acknowledgeRisks[p.cfg.id] });
      const status: SiteOutcome["status"] = result.outcome === "success" ? "applied" : result.outcome === "unverified" ? "unverified" : result.state.written > 0 ? "partial" : "failed";
      const outcome: SiteOutcome = { ...base, status, result };
      if (status === "applied") {
        // Compare the site's shared objects with the shared state we wanted.
        const after = await track(s, () => s.client.readAll());
        outcome.sharedCheck = sharedStateMatches(
          { siteId: p.cfg.id, siteName: p.cfg.name, map: p.cfg.interfaces!, snapshot: { ...after, firewallId: p.cfg.id, loadedAt: new Date().toISOString() } },
          shared.current,
          [...touched].map(objectUuid),
        );
        if (outcome.sharedCheck.length) outcome.status = "unverified";
        // HA: push to the secondary.
        if (p.cfg.secondary) {
          if (!req.haSync[p.cfg.id]) outcome.ha = { step: "skipped", message: "Not requested. Synchronize in OPNsense (System ▸ High Availability) when ready." };
          else {
            try {
              const st = await track(s, () => s.client.haSyncNow());
              outcome.ha = st.toLowerCase() === "ok" ? { step: "synced" } : { step: "failed", message: `HA sync returned "${st}".` };
            } catch (err) {
              outcome.ha = { step: "failed", message: err instanceof OpnsenseError ? err.message : "HA sync failed." };
            }
          }
        }
      }
      outcomes.push(outcome);
      if (outcome.status !== "applied") stopped = true;
    } catch (err) {
      outcomes.push({ ...base, status: "failed", result: undefined, sharedCheck: [err instanceof OpnsenseError ? err.message : "Unexpected error."] });
      stopped = true;
    }
  }

  const ok = outcomes.every((o) => o.status === "applied" || o.status === "up_to_date");
  const haWarn = outcomes.some((o) => o.ha?.step === "failed");
  const anyWritten = outcomes.some((o) => (o.result?.state.written ?? 0) > 0);
  return {
    outcome: ok ? (haWarn ? "success_with_warnings" : "success") : anyWritten ? "partial" : "failed",
    plans,
    sites: outcomes,
  };
}
