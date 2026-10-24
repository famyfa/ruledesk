import { useMemo, useState } from "react";
import { lockoutWarnings } from "@ruledeck/core";
import { ChangesPanel } from "../components/ChangesPanel.tsx";
import { api, ApiError, type ApplyResult } from "../api.ts";
import { useWorkspace } from "../workspace.tsx";

/**
 * Pending changes, review, and apply. The flow is:
 * review → explicit confirmation → server re-checks conflicts → writes →
 * activation → read-back verification, with each step's result shown.
 */
export function ChangesPage({ onShowRule }: { onShowRule: (id: string) => void }) {
  const { wc, changeSet, validation, site, siteId, reload, rebaseOntoFirewall, notify, recordApply, promptSignIn } = useWorkspace();
  const [reviewing, setReviewing] = useState(true);
  const [reviewed, setReviewed] = useState(false);
  const [riskAck, setRiskAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rebaseNotes, setRebaseNotes] = useState<string[] | null>(null);

  const risks = useMemo(() => (wc ? lockoutWarnings(wc) : []), [wc]);
  const pending = changeSet?.changes.length ?? 0;
  const problems = validation?.errorCount ?? 0;
  const features = site?.signedIn ? (site.info?.features ?? null) : null;
  const fwName = site?.name ?? "firewall";
  const counts = changeSet?.counts;

  const apply = async () => {
    if (!wc || !siteId) return;
    if (wc.baseline.firewallId !== siteId) {
      setError("These changes belong to a different site. Reload and try again.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const { result } = await api.apply(siteId, wc, riskAck);
      setResult(result);
      recordApply(result);
      if (result.outcome === "success") {
        notify("success", "Changes applied and verified on the firewall.");
        setReviewing(false);
        setReviewed(false);
        setRiskAck(false);
        await reload({ discardLocal: true });
      }
    } catch (err) {
      if (err instanceof ApiError && err.body.kind === "site_signed_out") promptSignIn(siteId);
      setError(err instanceof ApiError ? err.message : "Apply failed.");
    } finally {
      setBusy(false);
    }
  };

  const reconcile = async () => {
    const notes = await rebaseOntoFirewall();
    if (notes) {
      setRebaseNotes(notes);
      setResult(null);
      setReviewed(false);
      notify("info", "Your staged changes now sit on top of the firewall's current state. Review them again before applying.");
    }
  };

  return (
    <div className="changes-page">
      {result && <ApplyResultView result={result} onReload={() => reload({ discardLocal: true }).then(() => setResult(null))} onReconcile={reconcile} onShowRule={onShowRule} />}
      {rebaseNotes && rebaseNotes.length > 0 && (
        <div className="banner banner-warn" role="status">
          <strong>Some staged changes could not be carried over:</strong>
          <ul>
            {rebaseNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      <ChangesPanel onShowRule={onShowRule} onReview={() => setReviewing(true)} />

      {reviewing && pending > 0 && (
        <section className="review-box" aria-labelledby="review-title">
          <h2 id="review-title">Apply to {fwName}</h2>
          <p>
            {counts?.create ?? 0} to create, {counts?.modify ?? 0} to modify, {counts?.delete ?? 0} to delete, {counts?.reorder ?? 0} to move.
          </p>
          <ol className="apply-plan">
            <li>RuleDeck re-reads the firewall and stops if anything you changed was changed there too.</li>
            <li>Aliases are written first, then rules, then deletions. Only the fields you changed are sent.</li>
            <li>The configuration is activated (aliases reloaded, filter reloaded).</li>
            <li>The result is read back and compared with what you intended.</li>
          </ol>

          <p className="hint">
            RuleDeck has no automatic rollback. If something goes wrong, restore the previous revision under System ▸ Configuration ▸ History in OPNsense.
          </p>

          {risks.length > 0 && (
            <div className="risk-box" role="alert">
              <h3>⚠ Possible lockout</h3>
              <ul>
                {risks.map((r) => (
                  <li key={r.ruleId + r.message}>
                    <button type="button" className="link-button" onClick={() => onShowRule(r.ruleId)}>
                      {r.label}
                    </button>
                    : {r.message}
                  </li>
                ))}
              </ul>
              <label className="checkbox">
                <input type="checkbox" checked={riskAck} onChange={(e) => setRiskAck(e.target.checked)} />I have console or out-of-band access, or I'm sure these changes keep my access.
              </label>
            </div>
          )}

          {problems > 0 ? (
            <p className="text-error">Fix the {problems} problem(s) first.</p>
          ) : !features ? (
            <p className="text-error">You're not signed in to this firewall.</p>
          ) : !features.rulesWrite ? (
            <p className="text-warn">{features.notes[0] ?? "Editing isn't supported for this firewall version."}</p>
          ) : (
            <>
              <label className="checkbox">
                <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />I reviewed the changes listed above.
              </label>
              <div className="form-actions">
                <button type="button" onClick={() => setReviewing(false)} disabled={busy}>
                  Cancel
                </button>
                <button type="button" className="primary" onClick={apply} disabled={!reviewed || busy || (risks.length > 0 && !riskAck)}>
                  {busy ? "Applying…" : `Apply ${pending} change${pending === 1 ? "" : "s"} to ${fwName}`}
                </button>
              </div>
            </>
          )}
          {error && (
            <p className="text-error" role="alert">
              {error}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

const STATUS_LABEL = { done: "DONE", failed: "FAILED", skipped: "SKIPPED" } as const;

function ApplyResultView({
  result,
  onReload,
  onReconcile,
  onShowRule,
}: {
  result: ApplyResult;
  onReload: () => void;
  onReconcile: () => void;
  onShowRule: (id: string) => void;
}) {
  const headline: Record<ApplyResult["outcome"], { tone: string; text: string }> = {
    success: { tone: "ok", text: "Applied and verified. The firewall is running your changes." },
    conflict: { tone: "warn", text: "Not applied: the firewall changed since you loaded it. Nothing was written." },
    invalid: { tone: "error", text: "Not applied: the changes have problems. Nothing was written." },
    risky: { tone: "warn", text: "Not applied: confirm the lockout warnings first. Nothing was written." },
    partial: { tone: "error", text: "Partially applied. See exactly what happened below." },
    failed: { tone: "error", text: "Not applied: the first write failed. Nothing was changed." },
    unverified: { tone: "warn", text: "Applied, but the read-back doesn't fully match what you intended." },
  };
  const h = headline[result.outcome];
  const s = result.state;

  return (
    <section className={`apply-result tone-${h.tone}`} aria-live="polite" aria-label="Apply result">
      <h2>{h.text}</h2>
      {result.steps.length > 0 && (
        <p className="state-line">
          <span className={`tag ${s.written === s.totalWrites ? "tag-success" : "tag-partial"}`}>
            Written {s.written}/{s.totalWrites}
          </span>{" "}
          <span className={`tag ${s.activated ? "tag-success" : "tag-failure"}`}>{s.activated ? "Activated" : "Not activated"}</span>{" "}
          <span className={`tag ${s.verified ? "tag-success" : "tag-failure"}`}>{s.verified ? "Verified" : "Not verified"}</span>
        </p>
      )}
      {result.steps.length > 0 && (
        <ol className="step-list">
          {result.steps.map((st, i) => (
            <li key={i} className={`step step-${st.status}`}>
              <span className={`tag tag-step-${st.status}`}>{STATUS_LABEL[st.status]}</span> {st.label}
              {st.error && <div className="text-error small">{st.error}</div>}
            </li>
          ))}
        </ol>
      )}
      {result.conflicts && (
        <>
          <ul className="conflict-list">
            {result.conflicts.map((c) => (
              <li key={c.id}>
                <strong>{c.objectType === "rule" && !c.id.startsWith("group:") ? <button type="button" className="link-button" onClick={() => onShowRule(c.id)}>{c.label}</button> : c.label}</strong>
                : {c.message}
                {c.fields && c.fields.length > 0 && (
                  <ul className="small">
                    {c.fields.map((f) => (
                      <li key={f.field}>
                        {f.label}: <span className="before">{f.before || "(empty)"}</span> → <span className="after">{f.after || "(empty)"}</span> <span className="muted">(on the firewall now)</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          <div className="form-actions left">
            <button type="button" className="primary" onClick={onReconcile}>
              Keep my changes on top of the current firewall state
            </button>
            <button type="button" className="danger" onClick={onReload}>
              Discard my changes and reload
            </button>
          </div>
        </>
      )}
      {result.risks && (
        <ul>
          {result.risks.map((r) => (
            <li key={r.ruleId}>
              {r.label}: {r.message}
            </li>
          ))}
        </ul>
      )}
      {result.verificationProblems && (
        <>
          <h3>Differences found when reading back</h3>
          <ul>
            {result.verificationProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </>
      )}
      {result.recovery && (
        <>
          <h3>What to do now</h3>
          <ul className="recovery">
            {result.recovery.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <div className="form-actions left">
            <button type="button" onClick={onReload}>
              Reload from firewall (discard staged changes)
            </button>
          </div>
        </>
      )}
    </section>
  );
}
