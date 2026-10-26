import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { applyServiceSync, itemLabel, planServiceSync, type ServiceDef, type ServiceSnapshot, type ServiceSyncItem, type ServiceSyncKind, type ServiceWc } from "@ruledeck/core";
import { api, ApiError } from "../api.ts";
import { loadServiceWc, saveDraft } from "../serviceDrafts.ts";
import { useWorkspace } from "../workspace.tsx";

/**
 * Copy settings and entries of a service to another site. Nothing is sent to a firewall:
 * the result is staged at the target site and reviewed there like any other change.
 */

const KIND: Record<ServiceSyncKind, string> = { create: "New", update: "Changed", same: "Same", blocked: "Blocked" };

export function ServiceSyncDialog({ def, fromId, onClose }: { def: ServiceDef; fromId: string; onClose: () => void }) {
  const { sites, selectSite, notify } = useWorkspace();
  const others = sites.filter((s) => s.signedIn && s.id !== fromId);
  const [to, setTo] = useState(others[0]?.id ?? "");
  const [source, setSource] = useState<ServiceSnapshot | null>(null);
  const [target, setTarget] = useState<ServiceWc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [picked, setPicked] = useState<Record<string, Set<string>>>({});
  const [done, setDone] = useState<{ count: number; to: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;

  useEffect(() => {
    let stale = false;
    api
      .service(fromId, def.id)
      .then((r) => !stale && setSource(r.snapshot))
      .catch((e) => !stale && setError(e instanceof ApiError ? e.message : "Couldn't read the source site."));
    return () => {
      stale = true;
    };
  }, [fromId, def.id]);

  useEffect(() => {
    let stale = false;
    setTarget(null);
    if (!to) return;
    loadServiceWc(to, def)
      .then((w) => !stale && setTarget(w))
      .catch((e) => !stale && setError(e instanceof ApiError ? e.message : "Couldn't read the target site."));
    return () => {
      stale = true;
    };
  }, [to, def]);

  const plan = useMemo(() => {
    if (!source || !target) return null;
    const grids = Object.fromEntries(Object.entries(picked).map(([g, s]) => [g, [...s]]));
    const p = planServiceSync(def, source, target, { settings, grids });
    return p.items.length ? p : null;
  }, [def, source, target, settings, picked]);

  const actionable = plan ? plan.counts.create + plan.counts.update : 0;
  const toggle = (grid: string, id: string) =>
    setPicked((cur) => {
      const set = new Set(cur[grid] ?? []);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      return { ...cur, [grid]: set };
    });

  const stage = async () => {
    if (!plan || !target) return;
    setBusy(true);
    try {
      saveDraft(to, def, applyServiceSync(target, plan));
      setDone({ count: actionable, to });
      notify("success", `Staged ${actionable} change${actionable === 1 ? "" : "s"} at ${siteName(to)}.`);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="modal sync-dialog" role="dialog" aria-modal="true" aria-label={`Sync ${def.label}`}>
        <h2>Sync {def.label}</h2>
        <div className="sync-sites">
          <span>
            From <b>{siteName(fromId)}</b>
          </span>
          <span aria-hidden>→</span>
          <label>
            To
            <select value={to} onChange={(e) => { setTo(e.target.value); setDone(null); }} aria-label="Sync to">
              {others.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {others.length === 0 && <p className="muted">Sign in to a second site to sync between sites.</p>}
        {error && (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        )}
        {done ? (
          <div className="sync-done" role="status">
            <p>
              Staged <b>{done.count}</b> change{done.count === 1 ? "" : "s"} at <b>{siteName(done.to)}</b>. Nothing has been sent to the firewall yet.
            </p>
            <div className="modal-actions">
              <button type="button" className="primary" onClick={() => { selectSite(done.to); onClose(); }}>
                Open {siteName(done.to)} to review
              </button>
              <button type="button" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="sync-body">
              <section aria-label="Choose what to copy">
                {def.settings && (
                  <label className="checkbox">
                    <input type="checkbox" checked={settings} onChange={(e) => setSettings(e.target.checked)} />
                    <b>General settings</b>
                  </label>
                )}
                {def.grids.map((g) => {
                  const rows = source?.grids[g.id] ?? [];
                  const set = picked[g.id] ?? new Set<string>();
                  return (
                    <div key={g.id} className="sync-list">
                      <label className="checkbox sync-all">
                        <input
                          type="checkbox"
                          checked={rows.length > 0 && rows.every((r) => set.has(r.id))}
                          onChange={(e) => setPicked((cur) => ({ ...cur, [g.id]: e.target.checked ? new Set(rows.map((r) => r.id)) : new Set() }))}
                          aria-label={`All ${g.label}`}
                        />
                        <b>{g.label}</b> <span className="muted">({rows.length})</span>
                      </label>
                      <ul>
                        {rows.map((r) => {
                          const name = itemLabel(r.item, g.nameFields, r.id);
                          return (
                            <li key={r.id}>
                              <label className="checkbox">
                                <input type="checkbox" checked={set.has(r.id)} onChange={() => toggle(g.id, r.id)} aria-label={`${g.label}: ${name}`} />
                                {name}
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
                {!source && !error && <p className="muted">Loading…</p>}
              </section>
              <section aria-label="What would change" className="sync-preview">
                <h3>{plan ? `${plan.counts.create} new · ${plan.counts.update} changed · ${plan.counts.same} same${plan.counts.blocked ? ` · ${plan.counts.blocked} blocked` : ""}` : "Preview"}</h3>
                {!plan && <p className="muted">Tick what to copy to see what would change at {siteName(to) || "the target"}.</p>}
                {plan && (
                  <table className="data-table">
                    <tbody>
                      {plan.items.map((i) => (
                        <Row key={`${i.area}:${i.sourceId ?? "settings"}`} item={i} />
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="small muted">Passwords and keys are never copied. Choices such as interfaces are matched by their name at the target.</p>
              </section>
            </div>
            <div className="modal-actions">
              <button type="button" className="primary" disabled={busy || actionable === 0} onClick={stage}>
                Stage {actionable || ""} change{actionable === 1 ? "" : "s"} at {siteName(to) || "target"}
              </button>
              <button type="button" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function Row({ item }: { item: ServiceSyncItem }) {
  return (
    <tr>
      <td>
        <span className={`badge sync-badge-${item.kind}`}>{KIND[item.kind]}</span>
      </td>
      <td>
        <b>{item.label}</b>
        {item.kind === "update" && (
          <ul className="sync-changes">
            {item.changes.slice(0, 6).map((c) => (
              <li key={c.field}>
                {c.field}: {c.before || "—"} → {c.after || "—"}
              </li>
            ))}
          </ul>
        )}
        {item.reasons.map((r) => (
          <div key={r} className="text-error">
            {r}
          </div>
        ))}
      </td>
    </tr>
  );
}
