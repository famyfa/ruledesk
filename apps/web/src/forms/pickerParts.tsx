import { useEffect, useMemo, useRef, useState } from "react";
import { addAlias, findAliasReferences, updateAlias, type Alias } from "@ruledeck/core";
import { AliasForm, type AliasDraft } from "../components/AliasForm.tsx";
import { Popover } from "../components/Popover.tsx";
import { useWorkspace } from "../workspace.tsx";
import type { Suggestion } from "../grid/objects.ts";

/** Small letter badges that tell object types apart without relying on color. */
export const BADGE: Record<string, string> = {
  any: "*",
  self: "FW",
  iface: "IF",
  ifaceAddr: "IP",
  interfaceNet: "IF",
  interfaceAddr: "IP",
  alias: "A",
  literal: "#",
  port: "P",
};

/**
 * Scrollable list of existing objects, with a fixed "Create new alias" box
 * underneath it. The footer takes part in keyboard navigation: it is the item
 * after the last suggestion (highlight === suggestions.length).
 */
export function SuggestionList({
  listId,
  suggestions,
  highlight,
  onPick,
  onHover,
  footer,
}: {
  listId: string;
  suggestions: Suggestion[];
  highlight: number;
  onPick: (s: Suggestion) => void;
  onHover: (i: number) => void;
  footer?: { label: string; onPick: () => void };
}) {
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    ref.current?.querySelector(`[data-index="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlight]);
  const footerIndex = suggestions.length;
  return (
    <div className="suggestion-panel">
      {suggestions.length ? (
        <ul id={listId} ref={ref} className="suggestions" role="listbox">
          {suggestions.map((s, i) => (
            <li
              key={s.key}
              id={`${listId}-${i}`}
              data-index={i}
              role="option"
              aria-selected={i === highlight}
              className={`suggestion kind-${s.kind}${i === highlight ? " active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(s);
              }}
              onMouseEnter={() => onHover(i)}
            >
              <span className={`obj-badge obj-${s.kind}`} aria-hidden>
                {BADGE[s.kind]}
              </span>
              <span className="suggestion-label">{s.label}</span>
              {s.detail && <span className="suggestion-detail">{s.detail}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <div id={listId} className="suggestions empty" role="listbox">
          No matches
        </div>
      )}
      {footer && (
        <button
          type="button"
          id={`${listId}-${footerIndex}`}
          className={`create-alias-box${highlight === footerIndex ? " active" : ""}`}
          onMouseDown={(e) => {
            e.preventDefault();
            footer.onPick();
          }}
          onMouseEnter={() => onHover(footerIndex)}
        >
          <span className="obj-badge obj-create" aria-hidden>
            +
          </span>
          {footer.label}
        </button>
      )}
    </div>
  );
}

interface AliasDialogState {
  mode: "create" | "edit";
  alias?: Alias;
  name: string;
}

/**
 * Create/edit alias popover, used from the address and port fields.
 * `quiet` skips the "staged" toast (inside the rule form, the form itself is the context).
 */
export function useAliasDialog(
  kind: "address" | "port",
  onCreated: (name: string) => void,
  onRenamed: (from: string, to: string) => void,
  opts: { quiet?: boolean } = {},
) {
  const { wc, edit, notify } = useWorkspace();
  const [dialog, setDialog] = useState<AliasDialogState | null>(null);
  const types = useMemo(() => {
    const all = (wc?.baseline.options.aliasTypes ?? []).filter((t) => t.value !== "internal");
    return kind === "port" ? all.filter((t) => t.value === "port") : all.filter((t) => t.value !== "port");
  }, [wc, kind]);
  const names = wc?.current.aliases.map((a) => a.name) ?? [];

  const save = (draft: AliasDraft) => {
    if (!dialog) return;
    if (dialog.mode === "create") {
      const ok = edit((w) => addAlias(w, { ...draft, enabled: true, categories: [], extra: {} }).wc);
      if (ok) {
        if (!opts.quiet) notify("success", `Alias ${draft.name} staged.`);
        onCreated(draft.name);
      }
    } else if (dialog.alias) {
      const from = dialog.alias.name;
      const ok = edit((w) => updateAlias(w, dialog.alias!.id, draft));
      if (ok && from !== draft.name) onRenamed(from, draft.name);
    }
    setDialog(null);
  };

  const refNote = (alias?: Alias) => {
    if (!alias || !wc) return undefined;
    const refs = findAliasReferences(wc.current, alias.name);
    return refs.rules.length ? `Used by ${refs.rules.length} rule${refs.rules.length > 1 ? "s" : ""}. Renaming updates them.` : undefined;
  };

  const element = (anchor: DOMRect | null) =>
    dialog && anchor ? (
      <Popover anchor={anchor} label={dialog.mode === "create" ? "Create alias" : `Edit alias ${dialog.name}`}>
        <h3 className="popover-title">{dialog.mode === "create" ? "New alias" : `Edit alias ${dialog.alias?.name}`}</h3>
        <AliasForm
          initial={
            dialog.alias
              ? { name: dialog.alias.name, type: dialog.alias.type, entries: dialog.alias.entries, description: dialog.alias.description }
              : { name: dialog.name, type: kind === "port" ? "port" : "network", entries: [], description: "" }
          }
          types={types}
          existingNames={names}
          ownName={dialog.alias?.name}
          submitLabel={dialog.mode === "create" ? "Create & use" : "Save alias"}
          referenceNote={refNote(dialog.alias)}
          onSave={save}
          onCancel={() => setDialog(null)}
        />
      </Popover>
    ) : null;

  return { dialog, setDialog, element };
}
