import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ALIAS_FILTER_FIELDS,
  aliasRecord,
  createWorkingCopy,
  indexAliases,
  planSync,
  ruleRecord,
  RULE_FILTER_FIELDS,
  type FirewallSnapshot,
  type SyncKind,
} from "@ruledeck/core";
import { api, ApiError } from "../api.ts";
import { FilterInput, useFilter } from "../components/FilterInput.tsx";
import { SyncDialog } from "../components/SyncDialog.tsx";
import { useWorkspace } from "../workspace.tsx";

/**
 * Rules or aliases of all signed-in sites side by side, so differences are
 * visible without switching between firewalls. Shows what the firewalls have
 * now (not staged edits). Syncing stages changes at the target site.
 */

interface Row {
  key: string;
  name: string;
  /** Site whose copy the others are compared with: the first site that has the object. */
  refSite: string;
  refId: string;
  record: ReturnType<typeof ruleRecord>;
  cells: Record<string, { kind: SyncKind | "source"; note: string }>;
  /** Object id per site where it exists. */
  idAt: Record<string, string>;
}

const CELL_TEXT: Record<SyncKind | "source", string> = { source: "● reference", same: "✓ same", update: "≠ differs", create: "— missing", blocked: "⚠ can't sync" };
const CELL_CLASS: Record<SyncKind | "source", string> = { source: "cell-same", same: "cell-same", update: "cell-differs", create: "cell-missing", blocked: "cell-differs" };

export function GlobalPage({ kind, onShowRule }: { kind: "rules" | "aliases"; onShowRule: (ruleId: string) => void }) {
  const { sites, selectSite } = useWorkspace();
  const signedIn = useMemo(() => sites.filter((s) => s.signedIn), [sites]);
  const [snaps, setSnaps] = useState<Record<string, FirewallSnapshot>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [expr, setExpr] = useState("");
  const [onlyDiffs, setOnlyDiffs] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sync, setSync] = useState<{ from: string; names: string[] } | null>(null);
  const fields = kind === "rules" ? RULE_FILTER_FIELDS : ALIAS_FILTER_FIELDS;
  const env = useMemo(() => ({ fields }), [fields]);
  const filter = useFilter(expr, env);

  const load = useCallback(async () => {
    setLoading(true);
    const next: Record<string, FirewallSnapshot> = {};
    const errs: Record<string, string> = {};
    await Promise.all(
      signedIn.map(async (s) => {
        try {
          next[s.id] = (await api.snapshot(s.id)).snapshot;
        } catch (e) {
          errs[s.id] = e instanceof ApiError ? e.message : "Couldn't read this site.";
        }
      }),
    );
    setSnaps(next);
    setErrors(errs);
    setLoading(false);
  }, [signedIn]);

  useEffect(() => {
    void load();
  }, [load]);

  const loaded = signedIn.filter((s) => snaps[s.id]);

  const rows = useMemo(() => {
    const byKey = new Map<string, Row>();
    const copies = new Map(loaded.map((s) => [s.id, createWorkingCopy(snaps[s.id]!)]));
    for (const s of loaded) {
      const snap = snaps[s.id]!;
      const index = indexAliases(snap.aliases);
      const objs = kind === "rules" ? snap.rules.filter((r) => r.origin === "mvc" && r.description) : snap.aliases;
      for (const o of objs) {
        const name = "name" in o ? o.name : o.description;
        const row = byKey.get(name);
        if (row) {
          row.idAt[s.id] = o.id;
          continue;
        }
        byKey.set(name, {
          key: name,
          name,
          refSite: s.id,
          refId: o.id,
          record: "name" in o ? aliasRecord(o, index, s.name) : ruleRecord(o, index, s.name),
          cells: {},
          idAt: { [s.id]: o.id },
        });
      }
    }
    for (const row of byKey.values()) {
      const ref = snaps[row.refSite]!;
      for (const s of loaded) {
        if (s.id === row.refSite) {
          row.cells[s.id] = { kind: "source", note: "" };
          continue;
        }
        const plan = planSync(ref, copies.get(s.id)!, kind === "rules" ? { ruleIds: [row.refId], aliasIds: [] } : { ruleIds: [], aliasIds: [row.refId] });
        const item = plan.items.find((i) => i.sourceId === row.refId && i.objectType === (kind === "rules" ? "rule" : "alias"));
        row.cells[s.id] = {
          kind: item?.kind ?? "blocked",
          note: item ? [...item.reasons, ...item.changes.map((c) => `${c.label}: ${c.before ?? ""} → ${c.after ?? ""}`)].join("\n") : "",
        };
      }
    }
    return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [loaded, snaps, kind]);

  const shown = rows.filter((r) => (filter.empty || filter.test(r.record)) && (!onlyDiffs || Object.values(r.cells).some((c) => c.kind !== "same" && c.kind !== "source")));

  const toggle = (key: string) =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  // One sync button per reference site among the ticked rows.
  const bySource = new Map<string, string[]>();
  for (const r of rows) if (selected.has(r.key)) bySource.set(r.refSite, [...(bySource.get(r.refSite) ?? []), r.name]);

  if (signedIn.length < 2) {
    return <p className="muted pad">Sign in to at least two sites to compare and sync {kind} between them (Sites tab).</p>;
  }

  return (
    <div className="global-page">
      <div className="filter-bar" role="search">
        <FilterInput value={expr} onChange={setExpr} fields={fields} error={filter.error} label={`Filter ${kind} across sites`} />
        <label className="checkbox">
          <input type="checkbox" checked={onlyDiffs} onChange={(e) => setOnlyDiffs(e.target.checked)} />
          Only differences
        </label>
        <button type="button" onClick={() => void load()} disabled={loading}>
          {loading ? "Reading…" : "↻ Refresh"}
        </button>
        <span className="count">
          {shown.length} of {rows.length} {kind}
        </span>
      </div>
      {Object.entries(errors).map(([id, msg]) => (
        <div key={id} className="banner banner-error" role="alert">
          {sites.find((s) => s.id === id)?.name}: {msg}
        </div>
      ))}
      {bySource.size > 0 && (
        <div className="bulk-bar">
          <span>{selected.size} selected</span>
          {[...bySource].map(([from, names]) => (
            <button key={from} type="button" className="primary" onClick={() => setSync({ from, names })}>
              Sync {names.length} from {sites.find((s) => s.id === from)?.name} …
            </button>
          ))}
          <button type="button" className="link-button" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}
      <div className="table-scroll">
        <table className="data-table global-table">
          <thead>
            <tr>
              <th />
              <th>{kind === "rules" ? "Name" : "Alias"}</th>
              {loaded.map((s) => (
                <th key={s.id}>{s.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.key}>
                <td>
                  <input type="checkbox" checked={selected.has(r.key)} onChange={() => toggle(r.key)} aria-label={`Select ${r.name}`} />
                </td>
                <td>
                  {kind === "rules" ? (
                    <button
                      type="button"
                      className="link-button"
                      title={`Open at ${sites.find((s) => s.id === r.refSite)?.name}`}
                      onClick={() => {
                        selectSite(r.refSite);
                        onShowRule(r.refId);
                      }}
                    >
                      {r.name}
                    </button>
                  ) : (
                    <b>{r.name}</b>
                  )}
                </td>
                {loaded.map((s) => {
                  const c = r.cells[s.id]!;
                  return (
                    <td key={s.id} className={CELL_CLASS[c.kind]} title={c.note || undefined}>
                      {CELL_TEXT[c.kind]}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && shown.length === 0 && <div className="empty">{rows.length ? "Nothing matches the filter." : `No ${kind} found.`}</div>}
      </div>
      {sync && (
        <SyncDialog
          kind={kind}
          fromId={sync.from}
          preselectNames={sync.names}
          onClose={() => {
            setSync(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
