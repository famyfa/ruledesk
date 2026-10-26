import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  ALIAS_FILTER_FIELDS,
  aliasRecord,
  applySyncPlan,
  formatAddress,
  formatPort,
  indexAliases,
  planSync,
  ruleRecord,
  RULE_FILTER_FIELDS,
  type FirewallSnapshot,
  type SyncItem,
  type SyncKind,
  type WorkingCopy,
} from "@ruledeck/core";
import { api, ApiError } from "../api.ts";
import { useWorkspace } from "../workspace.tsx";
import { FilterInput, useFilter } from "./FilterInput.tsx";
import { Icon } from "./icons.tsx";

/**
 * Copy rules or aliases from one site to another. Nothing is written to a
 * firewall here: the result is staged as pending changes at the target site,
 * where it is reviewed and applied like any other edit.
 */

const KIND_LABEL: Record<SyncKind, string> = { create: "New", update: "Changed", same: "Same", blocked: "Blocked" };

export function SyncDialog({
  kind,
  fromId,
  toId,
  preselect = [],
  preselectNames,
  onClose,
}: {
  kind: "rules" | "aliases";
  fromId: string;
  toId?: string;
  /** Source object ids to tick at the start. */
  preselect?: string[];
  /** Or tick by alias name / rule name once the source is loaded. */
  preselectNames?: string[];
  onClose: () => void;
}) {
  const { sites, selectSite, loadSiteCopy, stageAtSite, notify } = useWorkspace();
  const signedIn = sites.filter((s) => s.signedIn);
  const [from, setFrom] = useState(fromId);
  const [to, setTo] = useState(toId ?? signedIn.find((s) => s.id !== fromId)?.id ?? "");
  const [source, setSource] = useState<FirewallSnapshot | null>(null);
  const [target, setTarget] = useState<WorkingCopy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set(preselect));
  const [expr, setExpr] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ count: number; to: string } | null>(null);

  const fields = kind === "rules" ? RULE_FILTER_FIELDS : ALIAS_FILTER_FIELDS;
  const env = useMemo(() => ({ fields }), [fields]);
  const filter = useFilter(expr, env);

  useEffect(() => {
    if (!source || !preselectNames?.length) return;
    const names = new Set(preselectNames);
    setSelected(new Set(kind === "aliases" ? source.aliases.filter((a) => names.has(a.name)).map((a) => a.id) : source.rules.filter((r) => r.origin === "mvc" && names.has(r.description)).map((r) => r.id)));
    // only when the source (re)loads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  useEffect(() => {
    let stale = false;
    setSource(null);
    setError(null);
    api
      .snapshot(from)
      .then((r) => !stale && setSource(r.snapshot))
      .catch((e) => !stale && setError(e instanceof ApiError ? e.message : "Couldn't read the source firewall."));
    return () => {
      stale = true;
    };
  }, [from]);

  useEffect(() => {
    let stale = false;
    setTarget(null);
    if (!to) return;
    loadSiteCopy(to)
      .then((w) => !stale && setTarget(w))
      .catch((e) => !stale && setError(e instanceof ApiError ? e.message : "Couldn't read the target firewall."));
    return () => {
      stale = true;
    };
  }, [to, loadSiteCopy]);

  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;

  const candidates = useMemo(() => {
    if (!source) return [];
    const index = indexAliases(source.aliases);
    if (kind === "aliases") {
      return source.aliases
        .filter((a) => filter.empty || filter.test(aliasRecord(a, index)))
        .map((a) => ({ id: a.id, name: a.name, detail: `${a.type} · ${a.entries.slice(0, 3).join(", ")}${a.entries.length > 3 ? ` +${a.entries.length - 3}` : ""}` }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    return source.rules
      .filter((r) => r.origin === "mvc")
      .filter((r) => filter.empty || filter.test(ruleRecord(r, index)))
      .map((r) => ({
        id: r.id,
        name: r.description || "(no name)",
        detail: `${r.action} · ${r.interfaces.join(",") || "floating"} · ${formatAddress(r.source)} → ${formatAddress(r.destination)} ${formatPort(r.destinationPort)}`,
      }));
  }, [source, kind, filter]);

  const plan = useMemo(() => {
    if (!source || !target || to === from || selected.size === 0) return null;
    const ids = [...selected];
    return planSync(source, target, kind === "rules" ? { ruleIds: ids, aliasIds: [] } : { ruleIds: [], aliasIds: ids });
  }, [source, target, selected, kind, to, from]);

  const actionable = plan ? plan.counts.create + plan.counts.update : 0;

  const toggle = (id: string) =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allShown = candidates.length > 0 && candidates.every((c) => selected.has(c.id));

  const stage = async () => {
    if (!plan || !source) return;
    setBusy(true);
    try {
      await stageAtSite(to, (w) => applySyncPlan(w, plan, source.rules));
      setDone({ count: actionable, to });
      notify("success", `Staged ${actionable} change${actionable === 1 ? "" : "s"} at ${siteName(to)}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't stage the changes.");
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="modal sync-dialog" role="dialog" aria-modal="true" aria-label={`Sync ${kind}`}>
        <h2>Sync {kind}</h2>
        <div className="sync-sites">
          <label>
            From
            <select value={from} onChange={(e) => { setFrom(e.target.value); setSelected(new Set()); }} aria-label="Sync from">
              {signedIn.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <span aria-hidden>→</span>
          <label>
            To
            <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Sync to">
              {signedIn.filter((s) => s.id !== from).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>

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
            {error && (
              <div className="banner banner-error" role="alert">
                {error}
              </div>
            )}
            {signedIn.length < 2 && <p className="muted">Sign in to a second site to sync between sites.</p>}
            <div className="sync-body">
              <section aria-label="Choose what to copy">
                <FilterInput value={expr} onChange={setExpr} fields={fields} error={filter.error} label="Filter objects to sync" />
                <div className="sync-list">
                  <label className="checkbox sync-all">
                    <input
                      type="checkbox"
                      checked={allShown}
                      onChange={() =>
                        setSelected((cur) => {
                          const n = new Set(cur);
                          for (const c of candidates) allShown ? n.delete(c.id) : n.add(c.id);
                          return n;
                        })
                      }
                    />
                    Select all shown ({candidates.length})
                  </label>
                  <ul>
                    {candidates.slice(0, 400).map((c) => (
                      <li key={c.id}>
                        <label className="checkbox">
                          <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} aria-label={c.name} />
                          <b>{c.name}</b> <span className="muted">{c.detail}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  {!source && !error && <p className="muted">Loading…</p>}
                </div>
              </section>
              <section aria-label="What would change" className="sync-preview">
                <h3>
                  {plan ? `${plan.counts.create} new · ${plan.counts.update} changed · ${plan.counts.same} same${plan.counts.blocked ? ` · ${plan.counts.blocked} blocked` : ""}` : "Preview"}
                </h3>
                {!plan && <p className="muted">Tick what to copy to see what would change at {siteName(to) || "the target"}.</p>}
                {plan && (
                  <table className="data-table">
                    <tbody>
                      {plan.items.map((i) => (
                        <PreviewRow key={`${i.objectType}:${i.sourceId}`} item={i} />
                      ))}
                    </tbody>
                  </table>
                )}
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

function PreviewRow({ item }: { item: SyncItem }) {
  return (
    <tr className={`sync-${item.kind}`}>
      <td>
        <span className={`badge sync-badge-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
      </td>
      <td>
        {item.objectType} <b>{item.label}</b>
        {item.dependency && <span className="muted"> (needed by a selected rule/alias)</span>}
        {item.kind === "update" && (
          <ul className="sync-changes">
            {item.changes.slice(0, 6).map((c) => (
              <li key={c.field}>
                {c.label}: {c.added || c.removed ? `${c.added?.length ? `+${c.added.join(", ")} ` : ""}${c.removed?.length ? `−${c.removed.join(", ")}` : ""}` : `${c.before || "—"} → ${c.after || "—"}`}
              </li>
            ))}
          </ul>
        )}
        {item.reasons.map((r) => (
          <div key={r} className="text-error">
            {r}
          </div>
        ))}
        {item.warnings.map((w) => (
          <div key={w} className="muted">
            <Icon name="warn" /> {w}
          </div>
        ))}
      </td>
    </tr>
  );
}
