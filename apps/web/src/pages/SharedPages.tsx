import { useCallback, useEffect, useState } from "react";
import { formatChangeSet, type FieldChange } from "@ruledeck/core";
import { ApiError, type SharedApplyResult, type SiteOutcome, type SitePlan } from "../api.ts";
import { useShared } from "../shared.tsx";

/**
 * Apply the shared policy to all sites: per-site preview (preflight, read-only), then one apply
 * that writes site by site, stops at the first site that doesn't fully succeed, and reads everything back.
 */

const PLAN_TEXT: Record<SitePlan["status"], string> = { ready: "ready", up_to_date: "already up to date", blocked: "blocked" };
const PLAN_CLASS: Record<SitePlan["status"], string> = { ready: "tag-success", up_to_date: "tag-step-skipped", blocked: "tag-failure" };

const OUTCOME_TEXT: Record<SiteOutcome["status"], string> = {
  applied: "applied and verified",
  up_to_date: "already up to date",
  failed: "failed, nothing written",
  partial: "partially applied",
  unverified: "applied, but not fully verified",
  blocked: "blocked",
  not_attempted: "not attempted",
};
const OUTCOME_CLASS: Record<SiteOutcome["status"], string> = {
  applied: "tag-success",
  up_to_date: "tag-step-skipped",
  failed: "tag-failure",
  partial: "tag-failure",
  unverified: "tag-partial",
  blocked: "tag-failure",
  not_attempted: "tag-step-skipped",
};

const HEADLINE: Record<SharedApplyResult["outcome"], { tone: string; text: string }> = {
  success: { tone: "ok", text: "Applied and verified on every site." },
  success_with_warnings: { tone: "warn", text: "Applied on every site, but the HA sync of at least one site needs your attention." },
  partial: { tone: "error", text: "Stopped: some sites have the change, the rest do not. See each site below." },
  blocked: { tone: "warn", text: "Not applied: a site is blocked. Nothing was written anywhere." },
  failed: { tone: "error", text: "Not applied: the first site failed. Nothing was written elsewhere." },
};

export function SharedApplyPage() {
  const sh = useShared();
  const changes = sh.changeSet?.changes.length ?? 0;
  const [plans, setPlans] = useState<SitePlan[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [ack, setAck] = useState<Record<string, boolean>>({});
  const [ha, setHa] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SharedApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const p = await sh.preflight(ack, ha);
      setPlans(p);
      setHa((cur) => ({ ...Object.fromEntries(p.filter((x) => x.ha.configured).map((x) => [x.siteId, true])), ...cur }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't check the sites.");
    } finally {
      setChecking(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sh.wc, ack]);

  useEffect(() => {
    if (sh.wc && changes > 0 && !result) void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sh.wc, changes, result]);

  if (sh.loadError) {
    return (
      <div className="pad">
        <div className="banner banner-error" role="alert">
          {sh.loadError}
        </div>
      </div>
    );
  }
  if (!sh.wc) return <p className="muted pad">{sh.loading ? "Building the shared view from all sites…" : ""}</p>;

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await sh.apply(ack, ha);
      setResult(r);
      if (r.sites.some((s) => (s.result?.state.written ?? 0) > 0)) sh.refreshOpenSite();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const h = HEADLINE[result.outcome];
    const stage = result.sites;
    return (
      <div className="shared-page pad">
        <section className={`apply-result tone-${h.tone}`} role="region" aria-label="Apply result">
          <h2>{h.text}</h2>
          <ol className="site-timeline">
            {stage.map((o) => (
              <li key={o.siteId} className="site-card">
                <div className="site-card-head">
                  <b>{o.siteName}</b> <span className={`tag ${OUTCOME_CLASS[o.status]}`}>{OUTCOME_TEXT[o.status]}</span>
                </div>
                {o.result && (
                  <ol className="step-list">
                    {o.result.steps.map((s, i) => (
                      <li key={i} className={`step step-${s.status}`}>
                        <span className={`tag tag-step-${s.status}`}>{s.status.toUpperCase()}</span> {s.label}
                        {s.error && <div className="text-error small">{s.error}</div>}
                      </li>
                    ))}
                  </ol>
                )}
                {o.result?.verificationProblems && (
                  <ul>
                    {o.result.verificationProblems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                )}
                {o.sharedCheck && o.sharedCheck.length > 0 && (
                  <ul className="text-error small">
                    {o.sharedCheck.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                )}
                {o.ha && (
                  <p className="small">
                    HA sync: <b>{o.ha.step}</b>
                    {o.ha.message ? ` · ${o.ha.message}` : ""}
                  </p>
                )}
                {o.result?.recovery && (
                  <ul className="recovery">
                    {o.result.recovery.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
          {result.plans
            .filter((p) => p.status === "blocked")
            .map((p) => (
              <div key={p.siteId} className="banner banner-warn">
                <b>{p.siteName}:</b> {p.reasons.join(" ")}
              </div>
            ))}
          {(result.outcome === "partial" || result.outcome === "failed") && (
            <p className="small muted">
              RuleDeck has no automatic rollback. Sites that applied keep the change; fix the cause and apply again (sites that are already up to date are skipped), or restore a site's previous revision under System ▸ Configuration ▸ History.
            </p>
          )}
          <div className="modal-actions">
            <button type="button" className="primary" onClick={() => void sh.reload({ discardLocal: result.outcome === "success" || result.outcome === "success_with_warnings" }).then(() => { setResult(null); setConfirm(false); })}>
              {result.outcome === "success" || result.outcome === "success_with_warnings" ? "Done: reload the shared view" : "Reload the shared view (keeps my staged changes)"}
            </button>
            {result.outcome !== "success" && result.outcome !== "success_with_warnings" && (
              <button type="button" onClick={() => setResult(null)}>
                Back to the plan
              </button>
            )}
          </div>
        </section>
      </div>
    );
  }

  if (changes === 0) {
    return (
      <div className="pad">
        <p>
          <b>Nothing staged.</b> Create or edit rules and aliases under <b>Global ▸ Shared rules</b> and <b>Shared aliases</b>. They are edited once and applied to every site from here.
        </p>
        {sh.missingSites.length > 0 && <div className="banner banner-warn">Not signed in to: {sh.missingSites.join(", ")}. Applying needs every site.</div>}
      </div>
    );
  }

  const ready = (plans ?? []).filter((p) => p.status === "ready");
  const blocked = (plans ?? []).filter((p) => p.status === "blocked");
  const unacked = (plans ?? []).filter((p) => p.risks.length > 0 && !ack[p.siteId]);
  const canApply = !!plans && !checking && blocked.length === 0 && ready.length > 0 && unacked.length === 0 && confirm && sh.missingSites.length === 0 && (sh.validation?.errorCount ?? 0) === 0;

  return (
    <div className="shared-page pad">
      <h2>Apply to all sites</h2>
      <p className="muted">
        {changes} shared change{changes === 1 ? "" : "s"} staged · applied to {sh.siteNames.join(", ")}
      </p>
      {sh.missingSites.length > 0 && <div className="banner banner-warn" role="alert">Not signed in to: {sh.missingSites.join(", ")}. Applying needs every site.</div>}
      {(sh.validation?.errorCount ?? 0) > 0 && <div className="banner banner-error" role="alert">{sh.validation!.errorCount} problem(s) in the shared rules or aliases. Fix them first.</div>}
      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      <details>
        <summary>The shared change</summary>
        <pre className="change-text">{sh.changeSet ? formatChangeSet(sh.changeSet) : ""}</pre>
      </details>

      <h3>Per site {checking && <span className="muted small">checking…</span>}</h3>
      <div className="site-cards">
        {(plans ?? []).map((p) => (
          <section key={p.siteId} className={`site-card plan-${p.status}`} aria-label={`Plan for ${p.siteName}`}>
            <div className="site-card-head">
              <b>{p.siteName}</b> <span className={`tag ${PLAN_CLASS[p.status]}`}>{PLAN_TEXT[p.status]}</span>
              {p.status !== "up_to_date" && (
                <span className="muted small">
                  {" "}
                  {p.counts.create} new · {p.counts.modify} changed · {p.counts.delete} deleted · {p.counts.reorder} moved
                </span>
              )}
            </div>
            {p.reasons.length > 0 && (
              <ul className="text-error">
                {p.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            {p.notes.length > 0 && (
              <ul className="muted small">
                {p.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
            {p.needsCategory && <p className="muted small">The "RuleDeck shared" category will be created on this site.</p>}
            {p.changes && (
              <details>
                <summary>What changes at {p.siteName}</summary>
                <pre className="change-text">{p.changes}</pre>
              </details>
            )}
            {p.risks.length > 0 && (
              <div className="banner banner-warn">
                <ul>
                  {p.risks.map((r) => (
                    <li key={r.ruleId}>
                      {r.label}: {r.message}
                    </li>
                  ))}
                </ul>
                <label className="checkbox">
                  <input type="checkbox" checked={!!ack[p.siteId]} onChange={(e) => setAck({ ...ack, [p.siteId]: e.target.checked })} />I understand the lockout risk at {p.siteName}.
                </label>
              </div>
            )}
            {p.ha.configured && p.status !== "up_to_date" && (
              <label className="checkbox">
                <input type="checkbox" checked={!!ha[p.siteId]} onChange={(e) => setHa({ ...ha, [p.siteId]: e.target.checked })} />
                Synchronize the HA peer after applying
              </label>
            )}
          </section>
        ))}
      </div>

      <div className="apply-box">
        <ol className="small muted">
          <li>Each site is re-read first; conflicts and problems at <i>any</i> site stop everything before anything is written.</li>
          <li>Then sites are written one at a time in order. The first site that doesn't fully succeed stops the run; the others stay untouched.</li>
          <li>Each site's result is read back and compared with what was intended.</li>
        </ol>
        <p className="small muted">RuleDeck has no automatic rollback. Recovery is each firewall's configuration history (System ▸ Configuration ▸ History).</p>
        <label className="checkbox">
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />I reviewed what changes at each site.
        </label>
        <div className="modal-actions">
          <button type="button" onClick={() => void check()} disabled={checking}>
            Check again
          </button>
          <button type="button" className="primary" disabled={!canApply || busy} onClick={apply}>
            {busy ? "Applying…" : `Apply to ${ready.length === 1 ? "1 site" : `all ${ready.length} sites`}`}
          </button>
        </div>
      </div>
    </div>
  );
}

const driftText = (v: string | FieldChange[]) => (typeof v === "string" ? v : `${v.length} difference${v.length === 1 ? "" : "s"}: ${v.map((c) => c.label).join(", ")}`);

/** Where the sites disagree about shared rules and aliases, and sites that can't take shared changes. */
export function SharedDriftPage() {
  const sh = useShared();
  if (sh.loadError) {
    return (
      <div className="pad">
        <div className="banner banner-error" role="alert">
          {sh.loadError}
        </div>
      </div>
    );
  }
  if (!sh.view) return <p className="muted pad">{sh.loading ? "Building the shared view from all sites…" : ""}</p>;
  const names = Object.fromEntries((sh.topology?.sites ?? []).map((s) => [s.id, s.name]));
  const { drift, blockedSites } = sh.view;
  return (
    <div className="pad">
      <h2>Drift</h2>
      <p className="muted">Shared rules and aliases should be identical at every site. This lists where they are not.</p>
      {Object.entries(blockedSites).map(([id, reasons]) => (
        <div key={id} className="banner banner-warn" role="alert">
          <b>{names[id] ?? id}</b> can't take shared changes: {reasons.join(" ")}
        </div>
      ))}
      {drift.length === 0 ? (
        <div className="banner banner-info" role="status">
          No drift: every site has the same shared rules and aliases.
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Object</th>
              <th>Details per site</th>
            </tr>
          </thead>
          <tbody>
            {drift.map((d, i) => (
              <tr key={i}>
                <td>
                  <span className="tag tag-partial">{d.kind.replace("_", " ")}</span>
                </td>
                <td>
                  {d.objectType} <b>{d.label}</b>
                </td>
                <td>
                  <ul className="small">
                    {Object.entries(d.sites).map(([id, v]) => (
                      <li key={id}>
                        <b>{names[id] ?? id}:</b> {driftText(v)}
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
