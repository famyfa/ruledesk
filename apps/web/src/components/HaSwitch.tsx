import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { describeHa } from "@ruledeck/core";
import { api, ApiError, type HaSwitchResult, type HaView } from "../api.ts";
import { useWorkspace } from "../workspace.tsx";

/**
 * HA status of a site and the graceful switchover (CARP maintenance mode on the
 * node RuleDeck is signed in to, so its virtual IPs move to the peer).
 */

const REFRESH_MS = 15_000;
const HA_CHANGED = "ruledeck:ha-changed";

export function useHa(siteId: string | null, enabled: boolean) {
  const { promptSignIn } = useWorkspace();
  const [view, setView] = useState<HaView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!siteId) return;
    try {
      setView(await api.ha(siteId));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.body.kind === "site_signed_out" && err.body.siteId) promptSignIn(err.body.siteId);
      setError(err instanceof ApiError ? err.message : "Couldn't read the HA state.");
    }
  }, [siteId, promptSignIn]);

  useEffect(() => {
    setView(null);
    if (!siteId || !enabled) return;
    void refresh();
    const t = setInterval(() => {
      if (!document.hidden) void refresh();
    }, REFRESH_MS);
    // After a switch every view of this site updates at once.
    const onChanged = () => void refresh();
    window.addEventListener(HA_CHANGED, onChanged);
    return () => {
      clearInterval(t);
      window.removeEventListener(HA_CHANGED, onChanged);
    };
  }, [siteId, enabled, refresh]);

  return { view, error, refresh };
}

export function HaBadge({ view }: { view: HaView }) {
  const tone = view.state.maintenance ? "tag-partial" : view.role === "master" ? "tag-success" : view.role === "backup" ? "tag-reorder" : "tag-failure";
  const label = view.state.maintenance ? "maintenance" : view.role === "none" ? "no CARP" : view.role;
  return <span className={`tag ${tone}`}>{label}</span>;
}

/** Cell for the Sites table: state, VIPs and the switch button. */
export function HaCell({ siteId, siteName }: { siteId: string; siteName: string }) {
  const { view, error, refresh } = useHa(siteId, true);
  const [dialog, setDialog] = useState(false);
  if (error && !view) return <span className="text-error small">{error}</span>;
  if (!view) return <span className="muted">reading…</span>;
  return (
    <div className="ha-cell">
      <div>
        <HaBadge view={view} /> <span className="muted small">{describeHa(view.state)}</span>
      </div>
      <div className="small muted" title={view.state.vips.map((v) => `${v.interface} ${v.subnet}: ${v.status}`).join("\n")}>
        {view.state.vips.filter((v) => v.mode === "carp").length} CARP VIPs · peer {view.peerReachable ? "answers" : <span className="text-error">not reachable</span>}
      </div>
      <button type="button" onClick={() => setDialog(true)}>
        {view.state.maintenance ? "Switch back…" : "Switch over…"}
      </button>
      {dialog && (
        <HaSwitchDialog
          siteId={siteId}
          siteName={siteName}
          view={view}
          onClose={() => {
            setDialog(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

export function HaSwitchDialog({ siteId, siteName, view, onClose }: { siteId: string; siteName: string; view: HaView; onClose: () => void }) {
  const { notify } = useWorkspace();
  // Fixed when the dialog opens: the live view flips as soon as the switch has happened.
  const [enter] = useState(!view.state.maintenance);
  const [opened] = useState(view);
  const gate = enter ? opened.enter : opened.leave;
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<HaSwitchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const { result: r } = await api.haSwitch(siteId, enter);
      setResult(r);
      window.dispatchEvent(new Event(HA_CHANGED));
      notify(r.outcome === "done" ? "success" : "error", r.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The switch request failed.");
    } finally {
      setBusy(false);
    }
  };

  const title = enter ? `Switch over ${siteName}` : `Switch back ${siteName}`;
  return createPortal(
    <div className="modal-backdrop" onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}>
      <div className="modal ha-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {!result && (
          <>
            {enter ? (
              <p>
                This puts the node RuleDeck is signed in to into <b>CARP maintenance mode</b>. Its virtual IPs move to the HA peer, which then carries the traffic. The mode is
                saved on the firewall and stays after a reboot until you switch back.
              </p>
            ) : (
              <p>
                This takes the node out of <b>CARP maintenance mode</b>. It becomes master again and takes its virtual IPs back from the peer.
              </p>
            )}
            <ul className="check-list" aria-label="Checks">
              {gate.checks.map((c) => (
                <li key={c.id} className={c.ok ? "ok" : "bad"}>
                  <span aria-hidden>{c.ok ? "✓" : "✗"}</span> {c.text}
                </li>
              ))}
            </ul>
            {enter && (
              <p className="hint">
                RuleDeck sees this node only. It checks that the peer answers over the HA sync link, not the peer's own CARP state. Look at the peer afterwards. Connections survive only
                if pfsync is working.
              </p>
            )}
            {error && (
              <div className="banner banner-error" role="alert">
                {error}
              </div>
            )}
            {gate.already && <p className="muted">Nothing to do: the node is already {enter ? "in" : "out of"} maintenance mode.</p>}
            <label className="checkbox">
              <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
              {enter ? "I understand that traffic moves to the peer." : "I understand that traffic moves back to this node."}
            </label>
            <div className="modal-actions">
              <button type="button" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="primary" disabled={!gate.allowed || !understood || busy} onClick={run}>
                {busy ? "Switching…" : enter ? "Switch over now" : "Switch back now"}
              </button>
            </div>
          </>
        )}
        {result && (
          <section aria-label="Switch result" className={`apply-result tone-${result.outcome === "done" ? "ok" : result.outcome === "refused" || result.outcome === "already" ? "warn" : "error"}`}>
            <h3>{result.message}</h3>
            <ol className="step-list">
              {result.steps.map((s, i) => (
                <li key={i} className={`step step-${s.status}`}>
                  <span className={`tag tag-step-${s.status}`}>{s.status.toUpperCase()}</span> {s.label}
                  {s.error && <div className="text-error small">{s.error}</div>}
                </li>
              ))}
            </ol>
            {result.after && (
              <p className="small">
                Now: {describeHa(result.after)} ({result.after.vips.filter((v) => v.mode === "carp").map((v) => `${v.interface} ${v.status}`).join(", ")})
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="primary" onClick={onClose}>
                Close
              </button>
            </div>
          </section>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Banner for the open site while it is in maintenance mode (its traffic runs on the peer). */
export function HaBanner({ onGo }: { onGo: () => void }) {
  const { site, siteId } = useWorkspace();
  const { view } = useHa(siteId, !!site?.signedIn && !!site.hasSecondary);
  if (!view?.state.maintenance || !site) return null;
  return (
    <div className="banner banner-warn" role="status">
      {site.name} is in CARP maintenance mode: its virtual IPs run on the HA peer.{" "}
      <button type="button" className="link-button" onClick={onGo}>
        Open Sites to switch back
      </button>
    </div>
  );
}
