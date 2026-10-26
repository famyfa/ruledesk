import { Fragment, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { addAlias, ALIAS_FILTER_FIELDS, aliasRecord, aliasStatus, indexAliases, deleteAlias, findAliasReferences, isLocalId, updateAlias, type Alias } from "@ruledeck/core";
import { useWorkspace } from "../workspace.tsx";
import { FilterInput, useFilter } from "../components/FilterInput.tsx";
import { SyncDialog } from "../components/SyncDialog.tsx";
import { AliasForm, RUNTIME_TYPES, type AliasDraft } from "../components/AliasForm.tsx";
import { Icon } from "../components/icons.tsx";

const ALIAS_ENV = { fields: ALIAS_FILTER_FIELDS };

export function AliasesPage({ onShowRule }: { onShowRule: (ruleId: string) => void }) {
  const { wc, edit, notify, validation, sites, siteId } = useWorkspace();
  const [syncOpen, setSyncOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const filter = useFilter(query, ALIAS_ENV);

  const aliases = useMemo(() => {
    if (!wc) return [];
    const index = indexAliases(wc.current.aliases);
    return wc.current.aliases
      .filter((a) => !typeFilter || a.type === typeFilter)
      .filter((a) => filter.empty || filter.test(aliasRecord(a, index)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [wc, filter, typeFilter]);

  if (!wc) return null;
  const types = wc.baseline.options.aliasTypes.filter((t) => t.value !== "internal");
  const names = wc.current.aliases.map((a) => a.name);
  const deletedAliases = wc.baseline.aliases.filter((b) => !wc.current.aliases.some((a) => a.id === b.id));

  const save = (alias: Alias | null, draft: AliasDraft) => {
    const ok = alias
      ? edit((w) => updateAlias(w, alias.id, draft))
      : edit((w) => addAlias(w, { ...draft, enabled: true, categories: [], extra: {} }).wc);
    if (ok) {
      notify("success", `Alias ${draft.name} ${alias ? "updated" : "created"} (staged).`);
      setEditingId(null);
    }
  };

  return (
    <div className="aliases-page">
      <div className="filter-bar">
        <FilterInput value={query} onChange={setQuery} fields={ALIAS_FILTER_FIELDS} error={filter.error} label="Search aliases" placeholder="Filter: web  or  ( addr in 10.1.0.0/16 ) and ( type eq network )" />
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Type filter">
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <span className="count">{aliases.length} aliases</span>
        {sites.filter((s) => s.signedIn).length > 1 && siteId && (
          <button type="button" onClick={() => setSyncOpen(true)} title="Copy aliases to another site (staged there for review)">
            Sync to site…
          </button>
        )}
        {syncOpen && siteId && <SyncDialog kind="aliases" fromId={siteId} onClose={() => setSyncOpen(false)} />}
        <button type="button" className="primary" onClick={() => setEditingId("new")}>
          + New alias
        </button>
      </div>

      {editingId === "new" && (
        <AliasDialog title="New alias" onCancel={() => setEditingId(null)}>
          <AliasForm
            initial={{ name: "", type: "host", entries: [], description: "" }}
            types={types}
            existingNames={names}
            submitLabel="OK"
            onSave={(d) => save(null, d)}
            onCancel={() => setEditingId(null)}
          />
        </AliasDialog>
      )}

      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>State</th>
              <th>Name</th>
              <th>Type</th>
              <th>Entries</th>
              <th>Description</th>
              <th>Used by</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {aliases.map((a) => {
              const status = aliasStatus(wc, a);
              const refs = findAliasReferences(wc.current, a.name);
              const issues = validation?.aliases[a.id];
              const refCount = refs.rules.length + refs.aliases.length;
              return (
                <Fragment key={a.id}>
                  <tr className={`row-${status}${issues ? " row-invalid" : ""}`}>
                    <td>
                      {issues ? (
                        <span className="tag tag-invalid">
                        <Icon name="warn" /> ERR
                      </span>
                      ) : status === "added" ? (
                        <span className="tag tag-added">+ NEW</span>
                      ) : status === "modified" ? (
                        <span className="tag tag-modified">
                        <Icon name="dot" /> MOD
                      </span>
                      ) : null}
                    </td>
                    <td className="mono">
                      <strong>{a.name}</strong>
                      {!a.enabled && <span className="tag tag-off">off</span>}
                    </td>
                    <td>
                      {types.find((t) => t.value === a.type)?.label ?? a.type}
                      {RUNTIME_TYPES.has(a.type) && <span className="tag tag-runtime" title="Content resolved at runtime (table)">runtime</span>}
                    </td>
                    <td className="mono entries-cell" title={a.entries.join("\n")}>
                      {a.entries.slice(0, 4).join(", ")}
                      {a.entries.length > 4 && <span className="muted"> +{a.entries.length - 4}</span>}
                    </td>
                    <td>{a.description}</td>
                    <td>
                      {refCount === 0 ? (
                        <span className="muted">unused</span>
                      ) : (
                        <details>
                          <summary>
                            {refs.rules.length} rule{refs.rules.length === 1 ? "" : "s"}
                            {refs.aliases.length > 0 && `, ${refs.aliases.length} alias${refs.aliases.length === 1 ? "" : "es"}`}
                          </summary>
                          <ul className="ref-list">
                            {refs.rules.map((r) => (
                              <li key={r.ruleId}>
                                <button type="button" className="link-button" onClick={() => onShowRule(r.ruleId)}>
                                  {r.ruleLabel}
                                </button>{" "}
                                <span className="muted">({r.fields.join(", ")})</span>
                              </li>
                            ))}
                            {refs.aliases.map((n) => (
                              <li key={n}>alias {n}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </td>
                    <td className="row-actions">
                      <button type="button" onClick={() => setEditingId(a.id)}>
                        Edit
                      </button>
                      <button type="button" className="danger" onClick={() => setConfirmDelete(a.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                  {issues && (
                    <tr className="row-issues">
                      <td />
                      <td colSpan={6} className="text-error">
                        {Object.values(issues).flat().join(" · ")}
                      </td>
                    </tr>
                  )}
                  {confirmDelete === a.id && (
                    <tr className="row-confirm">
                      <td />
                      <td colSpan={6}>
                        {refCount > 0 ? (
                          <p className="text-warn">
                            <Icon name="warn" /> {a.name} is used by {refs.rules.length} rule(s){refs.aliases.length ? ` and ${refs.aliases.length} alias(es)` : ""}. Deleting it leaves those
                            rules pointing at a missing alias; they will show errors and can't be applied until you fix them. The rules will
                            <strong> not</strong> turn into "any".
                          </p>
                        ) : (
                          <p>Delete alias {a.name}? This is staged locally and can be undone.</p>
                        )}
                        <button
                          type="button"
                          className="danger"
                          onClick={() => {
                            if (edit((w) => deleteAlias(w, a.id, { acknowledgeReferences: true }))) notify("info", `Alias ${a.name} deleted (staged).`);
                            setConfirmDelete(null);
                          }}
                        >
                          {refCount > 0 ? "I understand, delete anyway" : "Delete"}
                        </button>{" "}
                        <button type="button" onClick={() => setConfirmDelete(null)}>
                          Cancel
                        </button>
                      </td>
                    </tr>
                  )}
                  {editingId === a.id && (
                    <AliasDialog title={`Edit alias ${a.name}`} onCancel={() => setEditingId(null)}>
                      <AliasForm
                        initial={{ name: a.name, type: a.type, entries: a.entries, description: a.description }}
                        types={types}
                        existingNames={names}
                        ownName={a.name}
                        submitLabel="OK"
                        referenceNote={refs.rules.length ? `Used by ${refs.rules.length} rule(s). Renaming updates them.` : undefined}
                        onSave={(d) => save(a, d)}
                        onCancel={() => setEditingId(null)}
                      />
                    </AliasDialog>
                  )}
                </Fragment>
              );
            })}
            {deletedAliases.map((a) => (
              <tr key={a.id} className="row-deleted">
                <td>
                  <span className="tag tag-deleted">
                  <Icon name="minus" /> DEL
                </span>
                </td>
                <td className="mono">
                  <s>{a.name}</s>
                </td>
                <td>{a.type}</td>
                <td className="mono">{a.entries.slice(0, 4).join(", ")}</td>
                <td>{a.description}</td>
                <td colSpan={2} className="muted">
                  Deleted (staged){isLocalId(a.id) ? "" : " · undo with Ctrl+Z"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Modal dialog around the alias form (same style as the rule editor). */
function AliasDialog({ title, onCancel, children }: { title: string; onCancel: () => void; children: ReactNode }) {
  return createPortal(
    <div className="modal-backdrop" onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <div className="modal alias-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
