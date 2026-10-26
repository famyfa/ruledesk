import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  addGridItem,
  computeServiceChanges,
  createServiceWc,
  deleteGridItem,
  setSetting,
  updateGridItem,
  type GridDef,
  type Item,
  type OptionChoice,
  type ServiceDef,
  type ServiceSnapshot,
  type ServiceWc,
} from "@ruledeck/core";
import { api, ApiError, type ServiceApplyResult } from "../api.ts";
import { ItemForm, humanize } from "../components/ServiceForm.tsx";
import { ServiceSyncDialog } from "../components/ServiceSyncDialog.tsx";
import { draftKey, loadDraft, saveDraft } from "../serviceDrafts.ts";
import { useWorkspace } from "../workspace.tsx";

/**
 * One service (DHCP, DNS, gateways, ...): general settings and its tables, staged locally,
 * reviewed, then applied to the site with a read-back. Same rules as for firewall rules.
 */

function useServiceWc(def: ServiceDef) {
  const { siteId, promptSignIn } = useWorkspace();
  const [wc, setWcState] = useState<ServiceWc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<ServiceSnapshot["options"]>({});
  const [restored, setRestored] = useState(false);

  const persist = useCallback(
    (next: ServiceWc | null) => {
      if (siteId) saveDraft(siteId, def, next);
    },
    [siteId, def],
  );

  const setWc = useCallback(
    (fn: (w: ServiceWc) => ServiceWc) => {
      setWcState((cur) => {
        if (!cur) return cur;
        const next = fn(cur);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const load = useCallback(
    async (discard = false) => {
      if (!siteId) return;
      setLoading(true);
      setError(null);
      try {
        const { snapshot } = await api.service(siteId, def.id);
        setOptions(snapshot.options);
        const draft = discard ? null : loadDraft(draftKey(siteId, def.id));
        if (discard) sessionStorage.removeItem(draftKey(siteId, def.id));
        setRestored(!!draft);
        // A restored draft keeps the baseline it was made on, so changes made elsewhere are caught when applying.
        setWcState(draft ? { ...draft, baseline: { ...draft.baseline, options: snapshot.options, defaults: snapshot.defaults } } : createServiceWc(snapshot));
      } catch (err) {
        setWcState(null);
        if (err instanceof ApiError && err.body.kind === "site_signed_out" && err.body.siteId) promptSignIn(err.body.siteId);
        setError(err instanceof ApiError ? err.message : "Couldn't read this service.");
      } finally {
        setLoading(false);
      }
    },
    [siteId, def.id, promptSignIn],
  );

  useEffect(() => {
    setWcState(null);
    void load();
  }, [load]);

  return { wc, setWc, load, error, loading, options, restored };
}

const optionLabel = (options: OptionChoice[] | undefined, value: string) =>
  options && value ? value.split(",").map((v) => options.find((o) => o.value === v)?.label || v).join(", ") : value;

/** Cell text: choices by label, enabled/disabled flags as a mark. */
function cellText(options: OptionChoice[] | undefined, field: string, value: string): string {
  if ((field === "enabled" || field === "disabled") && (value === "0" || value === "1")) return (field === "enabled") === (value === "1") ? "✓" : "–";
  return optionLabel(options, value);
}

export function ServicePage({ def }: { def: ServiceDef }) {
  const { siteId, site } = useWorkspace();
  const { wc, setWc, load, error, loading, options, restored } = useServiceWc(def);
  const [tab, setTab] = useState(def.settings ? "settings" : def.grids[0]!.id);
  const [editing, setEditing] = useState<{ grid: GridDef; id: string | null; item: Item } | null>(null);
  const [review, setReview] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const { sites } = useWorkspace();

  useEffect(() => {
    setTab(def.settings ? "settings" : def.grids[0]!.id);
    setReview(false);
  }, [def]);

  const ro = !!def.readOnly;
  const changes = useMemo(() => (wc ? computeServiceChanges(def, wc) : []), [def, wc]);
  const secrets = useMemo(() => new Set(wc?.baseline.secrets ?? []), [wc?.baseline.secrets]);
  const optionsOf = (prefix: string) => (path: string) => options[`${prefix}:${path}`];

  if (!site?.signedIn || !siteId) return <p className="muted pad">Sign in to a site to manage {def.label}.</p>;
  if (error) {
    return (
      <div className="pad">
        <div className="banner banner-error" role="alert">
          {error}
        </div>
        <button type="button" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }
  if (!wc) return <p className="muted pad">{loading ? `Reading ${def.label} from ${site.name}…` : ""}</p>;

  const grid = def.grids.find((g) => g.id === tab);
  const countFor = (area: string) => changes.filter((c) => c.area === area).length;

  return (
    <div className="service-page">
      <div className="svc-head">
        <div>
          <h2>{def.label}</h2>
          <p className="muted">{def.description}</p>
        </div>
        <div className="svc-head-actions">
          {!ro && sites.filter((x) => x.signedIn).length > 1 && (
            <button type="button" onClick={() => setSyncOpen(true)} title="Copy settings or entries to another site (staged there for review)">
              Sync to site…
            </button>
          )}
        <button type="button" onClick={() => void load(changes.length === 0)} disabled={loading || changes.length > 0} title={changes.length ? "Apply or discard your staged changes first" : "Read again from the firewall"}>
          ↻ Reload
        </button>
        </div>
      </div>
      {syncOpen && siteId && <ServiceSyncDialog def={def} fromId={siteId} onClose={() => setSyncOpen(false)} />}
      {def.warning && (
        <div className="banner banner-warn" role="note">
          {def.warning}
        </div>
      )}
      {ro && (
        <div className="banner banner-info" role="note">
          Read-only: RuleDeck shows this service but doesn't change it.
        </div>
      )}
      {restored && changes.length > 0 && (
        <div className="banner banner-info" role="note">
          Restored {changes.length} staged change{changes.length === 1 ? "" : "s"} from this tab. They are only local.
        </div>
      )}

      <div className="tabs" role="tablist">
        {def.settings && (
          <button type="button" role="tab" aria-selected={tab === "settings"} className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
            General{countFor("settings") ? ` (${countFor("settings")})` : ""}
          </button>
        )}
        {def.grids.map((g) => (
          <button key={g.id} type="button" role="tab" aria-selected={tab === g.id} className={tab === g.id ? "active" : ""} onClick={() => setTab(g.id)}>
            {g.label} ({wc.grids[g.id]?.length ?? 0}){countFor(g.id) ? ` · ${countFor(g.id)} changed` : ""}
          </button>
        ))}
      </div>

      {tab === "settings" && wc.settings && (
        <div className="svc-panel">
          <ItemForm
            item={wc.settings}
            base={wc.baseline.settings}
            order={Object.keys(wc.settings)}
            optionsOf={optionsOf("settings")}
            multi={def.multi ?? []}
            secrets={secrets}
            grouped
            onChange={(p, v) => setWc((w) => setSetting(w, p, v))}
          />
        </div>
      )}

      {grid && (
        <GridTable
          def={def}
          grid={grid}
          wc={wc}
          options={options}
          onEdit={(id) => setEditing({ grid, id, item: { ...wc.grids[grid.id]!.find((r) => r.id === id)!.item } })}
          readOnly={ro}
          onAdd={() => setEditing({ grid, id: null, item: { ...(wc.baseline.defaults[grid.id] ?? {}) } })}
          onDelete={(id) => setWc((w) => deleteGridItem(w, grid.id, id))}
          onRestore={(id) =>
            setWc((w) => ({ ...w, grids: { ...w.grids, [grid.id]: [...(w.grids[grid.id] ?? []), { id, item: w.baseline.grids[grid.id]!.find((r) => r.id === id)!.item }] } }))
          }
        />
      )}

      {editing &&
        createPortal(
          <div className="modal-backdrop" onKeyDown={(e) => e.key === "Escape" && setEditing(null)}>
            <div className="modal svc-dialog" role="dialog" aria-modal="true" aria-label={editing.id ? `Edit ${editing.grid.label}` : `New ${editing.grid.label}`}>
              <h2>{editing.id ? "Edit" : "New"} · {editing.grid.label}</h2>
              <div className="svc-dialog-body">
                <fieldset disabled={ro} className="svc-ro">
                <ItemForm
                  item={editing.item}
                  base={editing.id ? (wc.baseline.grids[editing.grid.id]?.find((r) => r.id === editing.id)?.item ?? null) : null}
                  order={[...editing.grid.columns, ...editing.grid.nameFields]}
                  optionsOf={optionsOf(editing.grid.id)}
                  multi={editing.grid.multi ?? []}
                  secrets={secrets}
                  onChange={(p, v) => setEditing((e) => (e ? { ...e, item: { ...e.item, [p]: v } } : e))}
                />
                </fieldset>
              </div>
              <div className="modal-actions">
                <button type="button" onClick={() => setEditing(null)}>
                  {ro ? "Close" : "Cancel"}
                </button>
                {!ro && <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    const e = editing;
                    if (e.id) setWc((w) => updateGridItem(w, e.grid.id, e.id!, e.item));
                    else setWc((w) => addGridItem(w, e.grid.id, e.item).wc);
                    setEditing(null);
                  }}
                >
                  OK
                </button>}
              </div>
            </div>
          </div>,
          document.body,
        )}

      {!ro && <div className={`svc-pending${changes.length ? " has" : ""}`} role="status">
        <span>
          {changes.length ? `${changes.length} staged change${changes.length === 1 ? "" : "s"} · only local, nothing sent yet` : "No staged changes"}
        </span>
        <span className="spacer" />
        <button type="button" onClick={() => void load(true)} disabled={!changes.length}>
          Discard all
        </button>
        <button type="button" className="primary" disabled={!changes.length} onClick={() => setReview(true)}>
          Review &amp; apply…
        </button>
      </div>}

      {review && changes.length > 0 && (
        <ReviewPanel
          def={def}
          wc={wc}
          siteName={site.name}
          onClose={() => setReview(false)}
          onApplied={async () => {
            setReview(false);
            await load(true);
          }}
        />
      )}
    </div>
  );
}

function GridTable({
  def,
  grid,
  wc,
  options,
  onEdit,
  onAdd,
  onDelete,
  onRestore,
  readOnly,
}: {
  readOnly: boolean;
  def: ServiceDef;
  grid: GridDef;
  wc: ServiceWc;
  options: ServiceSnapshot["options"];
  onEdit: (id: string) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
}) {
  const rows = wc.grids[grid.id] ?? [];
  const base = new Map((wc.baseline.grids[grid.id] ?? []).map((r) => [r.id, r.item]));
  const changed = new Set(computeServiceChanges(def, wc).filter((c) => c.area === grid.id).map((c) => c.id));
  const gone = (wc.baseline.grids[grid.id] ?? []).filter((r) => !rows.some((x) => x.id === r.id));
  const cols = grid.columns.filter((c) => rows.some((r) => c in r.item) || gone.some((r) => c in r.item) || c in (wc.baseline.defaults[grid.id] ?? {}));
  return (
    <div className="svc-grid">
      <div className="filter-bar">
        {!readOnly && (
          <button type="button" className="primary" onClick={onAdd}>
            + Add
          </button>
        )}
        <span className="count">
          {rows.length} {grid.label.toLowerCase()}
        </span>
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th />
              {cols.map((c) => (
                <th key={c}>{humanize(c)}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isNew = !base.has(r.id);
              return (
                <tr key={r.id} className={changed.has(r.id) ? "row-changed" : undefined}>
                  <td>{isNew ? <span className="tag tag-create">NEW</span> : changed.has(r.id) ? <span className="tag tag-modify">MOD</span> : null}</td>
                  {cols.map((c, i) => (
                    <td key={c} className={i === 0 ? "cell-name" : undefined} onClick={i === 0 ? () => onEdit(r.id) : undefined}>
                      {cellText(options[`${grid.id}:${c}`], c, r.item[c] ?? "") || <span className="muted">—</span>}
                    </td>
                  ))}
                  <td className="row-actions">
                    <button type="button" onClick={() => onEdit(r.id)} aria-label={`${readOnly ? "View" : "Edit"} ${r.item[cols[0] ?? ""] ?? ""}`}>
                      {readOnly ? "View" : "Edit"}
                    </button>
                    {!readOnly && (
                      <button type="button" className="danger" onClick={() => onDelete(r.id)} aria-label={`Delete ${r.item[cols[0] ?? ""] ?? ""}`}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {gone.map((r) => (
              <tr key={r.id} className="row-deleted">
                <td>
                  <span className="tag tag-delete">DEL</span>
                </td>
                {cols.map((c) => (
                  <td key={c}>{cellText(options[`${grid.id}:${c}`], c, r.item[c] ?? "")}</td>
                ))}
                <td className="row-actions">
                  <button type="button" onClick={() => onRestore(r.id)}>
                    Restore
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && gone.length === 0 && <div className="empty">Nothing here yet.</div>}
      </div>
    </div>
  );
}

function ReviewPanel({ def, wc, siteName, onClose, onApplied }: { def: ServiceDef; wc: ServiceWc; siteName: string; onClose: () => void; onApplied: () => Promise<void> }) {
  const { siteId, notify } = useWorkspace();
  const changes = useMemo(() => computeServiceChanges(def, wc), [def, wc]);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ServiceApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = async () => {
    if (!siteId) return;
    setBusy(true);
    setError(null);
    try {
      const { result: r } = await api.serviceApply(siteId, def.id, wc);
      setResult(r);
      if (r.outcome === "success") notify("success", `${def.label}: applied and verified.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  };

  const tone = !result ? "" : result.outcome === "success" ? "ok" : result.outcome === "conflict" || result.outcome === "unverified" ? "warn" : "error";
  const headline: Record<ServiceApplyResult["outcome"], string> = {
    success: "Applied and verified. The firewall is running your changes.",
    conflict: "Not applied: something changed on the firewall since you loaded it. Nothing was written.",
    failed: "Not applied: the firewall refused the first change. Nothing was changed.",
    partial: "Partially applied. See exactly what happened below.",
    unverified: "Applied, but the read-back doesn't fully match what you intended.",
    nothing: "Nothing to apply.",
  };

  return (
    <section className="svc-review" aria-label={`Apply to ${siteName}`}>
      <h3>Apply to {siteName}</h3>
      {!result && (
        <>
          <ul className="svc-changes">
            {changes.map((c) => (
              <li key={`${c.area}:${c.id}`}>
                <span className={`tag tag-${c.kind}`}>{c.kind.toUpperCase()}</span> <b>{c.area === "settings" ? "" : `${def.grids.find((g) => g.id === c.area)?.label}: `}{c.label}</b>
                {c.fields.length > 0 && (
                  <ul className="small">
                    {c.fields.map((f) => (
                      <li key={f.field}>
                        {humanize(f.field)}: {c.kind === "create" ? <span className="after">{f.after}</span> : (
                          <>
                            <span className="before">{f.before || "(empty)"}</span> → <span className="after">{f.after || "(empty)"}</span>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          <ol className="small muted">
            <li>RuleDeck re-reads the firewall and stops if anything you changed was changed there too.</li>
            <li>Settings first, then new entries, edits, and deletions. It stops at the first refusal.</li>
            <li>The saved configuration is activated, then read back and compared.</li>
          </ol>
          <p className="small muted">RuleDeck has no automatic rollback. If something goes wrong, restore the previous revision under System ▸ Configuration ▸ History in OPNsense.</p>
          {def.warning && <div className="banner banner-warn">{def.warning}</div>}
          {error && (
            <div className="banner banner-error" role="alert">
              {error}
            </div>
          )}
          <label className="checkbox">
            <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />I reviewed the changes listed above.
          </label>
          <div className="modal-actions">
            <button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="primary" disabled={!ok || busy} onClick={apply}>
              {busy ? "Applying…" : `Apply ${changes.length} change${changes.length === 1 ? "" : "s"} to ${siteName}`}
            </button>
          </div>
        </>
      )}
      {result && (
        <div className={`apply-result tone-${tone}`} role="region" aria-label="Apply result">
          <h4>{headline[result.outcome]}</h4>
          <ol className="step-list">
            {result.steps.map((s, i) => (
              <li key={i} className={`step step-${s.status}`}>
                <span className={`tag tag-step-${s.status}`}>{s.status.toUpperCase()}</span> {s.label}
                {s.error && <div className="text-error small">{s.error}</div>}
              </li>
            ))}
          </ol>
          {result.conflicts && (
            <ul className="conflict-list">
              {result.conflicts.map((c) => (
                <li key={c.id}>
                  <b>{c.label}</b>: {c.message}
                </li>
              ))}
            </ul>
          )}
          {result.verificationProblems && (
            <ul>
              {result.verificationProblems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {result.secretsNotVerified && <p className="small muted">Passwords and keys can't be read back, so they were written but not verified.</p>}
          {result.recovery && (
            <ul className="recovery">
              {result.recovery.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <div className="modal-actions">
            {result.outcome === "success" ? (
              <button type="button" className="primary" onClick={() => void onApplied()}>
                Done
              </button>
            ) : (
              <>
                <button type="button" onClick={onClose}>
                  Back to editing
                </button>
                <button type="button" className="danger" onClick={() => void onApplied()}>
                  Reload from firewall (discard staged changes)
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
