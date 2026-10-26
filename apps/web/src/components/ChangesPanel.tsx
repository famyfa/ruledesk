import { useState } from "react";
import { discardAll, formatChangeSet, type Change } from "@ruledeck/core";
import { useWorkspace } from "../workspace.tsx";
import { Icon } from "./icons.tsx";

const KIND_LABEL: Record<Change["kind"], string> = { create: "CREATE", modify: "MODIFY", delete: "DELETE", reorder: "MOVE" };

/** The list of staged changes + problems. Used in the bottom drawer and on the Pending Changes page. */
export function ChangesPanel({ onShowRule, onReview }: { onShowRule: (id: string) => void; onReview?: () => void }) {
  const { wc, changeSet, validation, edit, notify } = useWorkspace();
  const [tab, setTab] = useState<"changes" | "problems">("changes");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  if (!wc || !changeSet || !validation) return null;

  const problems = [
    ...Object.entries(validation.rules).flatMap(([id, f]) =>
      Object.entries(f).flatMap(([field, msgs]) => msgs.map((m) => ({ id, type: "rule" as const, field, message: m }))),
    ),
    ...Object.entries(validation.aliases).flatMap(([id, f]) =>
      Object.entries(f).flatMap(([field, msgs]) => msgs.map((m) => ({ id, type: "alias" as const, field, message: m }))),
    ),
  ];

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(formatChangeSet(changeSet));
      notify("success", "Change list copied as text.");
    } catch {
      notify("error", "Clipboard not available.");
    }
  };

  const labelFor = (p: (typeof problems)[number]) =>
    p.type === "rule"
      ? wc.current.rules.find((r) => r.id === p.id)?.description || `rule #${wc.current.rules.findIndex((r) => r.id === p.id) + 1}`
      : `alias ${wc.current.aliases.find((a) => a.id === p.id)?.name}`;

  return (
    <div className="changes-panel">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "changes"} className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>
          Changes ({changeSet.changes.length})
        </button>
        <button role="tab" aria-selected={tab === "problems"} className={tab === "problems" ? "active" : ""} onClick={() => setTab("problems")}>
          Problems ({problems.length})
        </button>
        <span className="spacer" />
        <span className="hint">Staged locally. Nothing has been sent to the firewall.</span>
        {changeSet.changes.length > 0 && (
          <>
            <button type="button" className="ghost" onClick={copyText}>
              Copy as text
            </button>
            {confirmDiscard ? (
              <span className="confirm-inline">
                Discard all {changeSet.changes.length} changes?{" "}
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    edit(discardAll);
                    setConfirmDiscard(false);
                    notify("info", "All local changes discarded. Ctrl+Z restores them.");
                  }}
                >
                  Discard
                </button>
                <button type="button" onClick={() => setConfirmDiscard(false)}>
                  Keep
                </button>
              </span>
            ) : (
              <button type="button" className="ghost" onClick={() => setConfirmDiscard(true)}>
                Discard all…
              </button>
            )}
            {onReview && (
              <button type="button" className="primary" onClick={onReview} disabled={problems.length > 0} title={problems.length ? "Fix problems first" : undefined}>
                Review &amp; apply…
              </button>
            )}
          </>
        )}
      </div>

      {tab === "changes" ? (
        changeSet.changes.length === 0 ? (
          <p className="muted pad">No pending changes. Edits you make in the grid are staged here before anything is sent.</p>
        ) : (
          <ul className="change-list">
            {changeSet.changes.map((c) => (
              <li key={`${c.kind}:${c.id}`} className={`change change-${c.kind}`}>
                <div className="change-head">
                  <span className={`tag tag-${c.kind}`}>{KIND_LABEL[c.kind]}</span>
                  <span className="change-type">{c.objectType === "rule" ? "Rule" : "Alias"}</span>
                  {c.objectType === "rule" && c.kind !== "delete" ? (
                    <button type="button" className="link-button" onClick={() => onShowRule(c.id)}>
                      {c.label}
                    </button>
                  ) : (
                    <strong>{c.label}</strong>
                  )}
                </div>
                {c.fields.length > 0 && (
                  <table className="change-fields-table">
                    <tbody>
                      {c.fields.map((f) =>
                        f.added || f.removed ? (
                          <tr key={f.field}>
                            <th>{f.label}</th>
                            <td className="mono">
                              {f.removed?.map((e) => (
                                <div key={`-${e}`} className="removed">
                                  − {e}
                                </div>
                              ))}
                              {f.added?.map((e) => (
                                <div key={`+${e}`} className="added">
                                  + {e}
                                </div>
                              ))}
                            </td>
                          </tr>
                        ) : (
                          <tr key={f.field}>
                            <th>{f.label}</th>
                            <td className="mono">
                              {c.kind === "create" ? (
                                <span className="after">{f.after}</span>
                              ) : (
                                <>
                                  <span className="before">{f.before || "(empty)"}</span> → <span className="after">{f.after || "(empty)"}</span>
                                </>
                              )}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                )}
              </li>
            ))}
          </ul>
        )
      ) : problems.length === 0 ? (
        <p className="muted pad">No problems found.</p>
      ) : (
        <ul className="problem-list">
          {problems.map((p, i) => (
            <li key={i}>
              <Icon name="warn" />{" "}
              {p.type === "rule" ? (
                <button type="button" className="link-button" onClick={() => onShowRule(p.id)}>
                  {labelFor(p)}
                </button>
              ) : (
                <strong>{labelFor(p)}</strong>
              )}{" "}
              <span className="muted">{p.field}:</span> {p.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
