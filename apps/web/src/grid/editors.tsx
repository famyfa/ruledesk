import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MutableRefObject } from "react";
import {
  addAlias,
  addressItemToken,
  findAliasReferences,
  updateAlias,
  type AddressItem,
  type AddressSpec,
  type Alias,
  type PortSpec,
} from "@ruledeck/core";
import { AliasForm, type AliasDraft } from "../components/AliasForm.tsx";
import { Popover } from "../components/Popover.tsx";
import { useWorkspace } from "../workspace.tsx";
import {
  addressSuggestions,
  itemLabel,
  portSuggestions,
  resolveAddressToken,
  resolvePortToken,
  type ObjectContext,
  type Suggestion,
} from "./objects.ts";

export type MoveAfterCommit = "down" | "right" | "left" | "none";

/** Grid -> editor handle: lets the grid commit an open editor when focus moves elsewhere. */
export type CommitHandle = MutableRefObject<(() => void) | null>;

interface BaseEditorProps<T> {
  value: T;
  onCommit: (value: T, move: MoveAfterCommit) => void;
  onCancel: () => void;
  commitHandle: CommitHandle;
  /** First key typed to open the editor (replaces content). */
  initialText?: string;
}

function moveForKey(e: KeyboardEvent): MoveAfterCommit {
  if (e.key === "Tab") return e.shiftKey ? "left" : "right";
  if (e.key === "Enter") return "down";
  return "none";
}

// ---------------------------------------------------------------------------
// Text

export function TextEditor({ value, onCommit, onCancel, commitHandle, initialText }: BaseEditorProps<string>) {
  const [text, setText] = useState(initialText ?? value);
  const ref = useRef<HTMLInputElement>(null);
  commitHandle.current = () => onCommit(text, "none");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (initialText === undefined) el.select();
  }, [initialText]);
  return (
    <input
      ref={ref}
      className="cell-input"
      value={text}
      aria-label="Edit value"
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
          onCommit(text, moveForKey(e));
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        } else {
          e.stopPropagation();
        }
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Select (enums)

export function SelectEditor({
  value,
  options,
  onCommit,
  onCancel,
  commitHandle,
}: BaseEditorProps<string> & { options: { value: string; label: string }[] }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLSelectElement>(null);
  commitHandle.current = () => onCommit(v, "none");
  useLayoutEffect(() => ref.current?.focus(), []);
  const opts = options.some((o) => o.value === value) ? options : [{ value, label: value }, ...options];
  return (
    <select
      ref={ref}
      className="cell-input"
      value={v}
      aria-label="Choose value"
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
          onCommit(v, moveForKey(e));
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        } else {
          e.stopPropagation();
        }
      }}
    >
      {opts.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Combobox shell shared by address / port pickers

interface Chip {
  key: string;
  label: string;
  kind: string;
  title?: string;
  alias?: Alias;
}

function SuggestionList({
  listId,
  suggestions,
  highlight,
  onPick,
  onHover,
}: {
  listId: string;
  suggestions: Suggestion[];
  highlight: number;
  onPick: (s: Suggestion) => void;
  onHover: (i: number) => void;
}) {
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    ref.current?.querySelector(`[data-index="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlight]);
  if (!suggestions.length) return <div className="suggestions empty">No matches</div>;
  return (
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
  );
}

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
  create: "+",
};

interface AliasDialog {
  mode: "create" | "edit";
  alias?: Alias;
  name: string;
}

/** Inline create/edit alias popover, used from inside a cell editor. */
function useAliasDialog(kind: "address" | "port", onCreated: (name: string) => void, onRenamed: (from: string, to: string) => void) {
  const { wc, edit, notify } = useWorkspace();
  const [dialog, setDialog] = useState<AliasDialog | null>(null);
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
        notify("success", `Alias ${draft.name} staged.`);
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

// ---------------------------------------------------------------------------
// Address picker

export function AddressEditor({ value, onCommit, onCancel, commitHandle, initialText, ctx }: BaseEditorProps<AddressSpec> & { ctx: ObjectContext }) {
  const [spec, setSpec] = useState<AddressSpec>(value);
  const [query, setQuery] = useState(initialText ?? "");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const specRef = useRef(spec);
  specRef.current = spec;

  const addItem = (item: AddressItem | "any") => {
    setSpec((s) => (item === "any" ? { ...s, items: [] } : s.items.some((i) => addressItemToken(i) === addressItemToken(item)) ? s : { ...s, items: [...s.items, item] }));
    setQuery("");
    setHighlight(0);
  };

  const aliasDialog = useAliasDialog(
    "address",
    (name) => addItem({ kind: "alias", name }),
    (from, to) => setSpec((s) => ({ ...s, items: s.items.map((i) => (i.kind === "alias" && i.name === from ? { ...i, name: to } : i)) })),
  );

  const suggestions = useMemo(() => addressSuggestions(query, ctx, spec), [query, ctx, spec]);
  // When the alias popover closes, put focus straight back into the picker.
  useLayoutEffect(() => {
    if (!aliasDialog.dialog) inputRef.current?.focus();
  }, [aliasDialog.dialog]);
  commitHandle.current = aliasDialog.dialog ? null : () => onCommit(specRef.current, "none");

  useLayoutEffect(() => inputRef.current?.focus(), []);

  const pick = (s: Suggestion) => {
    if (s.kind === "create") {
      aliasDialog.setDialog({ mode: "create", name: s.createName ?? "" });
      return;
    }
    if (s.item) addItem(s.item);
  };

  const commit = (move: MoveAfterCommit) => {
    // A fully typed but unpicked token is resolved on commit.
    let final = spec;
    if (query.trim()) {
      const resolved = resolveAddressToken(query, ctx);
      if (!resolved) {
        // Leave the editor open so the user sees the problem.
        setHighlight(0);
        return;
      }
      final = resolved === "any" ? { ...spec, items: [] } : { ...spec, items: [...spec.items, resolved] };
    }
    onCommit(final, move);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
        break;
      case "Enter": {
        e.preventDefault();
        const s = suggestions[highlight];
        if (query.trim() && s) pick(s);
        else commit("down");
        break;
      }
      case "Tab":
        e.preventDefault();
        commit(moveForKey(e));
        break;
      case "Escape":
        e.preventDefault();
        onCancel();
        break;
      case "Backspace":
        if (!query && spec.items.length) setSpec((s) => ({ ...s, items: s.items.slice(0, -1) }));
        break;
      default:
        if (e.altKey && e.key.toLowerCase() === "n") {
          e.preventDefault();
          setSpec((s) => ({ ...s, negate: !s.negate }));
        }
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    const tokens = text.split(/[\s,;]+/).filter(Boolean);
    if (tokens.length < 2) return;
    e.preventDefault();
    const unresolved: string[] = [];
    for (const t of tokens) {
      const r = resolveAddressToken(t, ctx);
      if (r) addItem(r);
      else unresolved.push(t);
    }
    setQuery(unresolved.join(" "));
  };

  const chips: Chip[] = spec.items.map((i) => {
    const alias = i.kind === "alias" ? ctx.aliases.find((a) => a.name === i.name) : undefined;
    return {
      key: addressItemToken(i),
      label: itemLabel(i, ctx),
      kind: i.kind,
      alias,
      title: alias ? `${alias.type}: ${alias.entries.join(", ")}` : undefined,
    };
  });

  return (
    <div className="picker" ref={boxRef}>
      <div className="picker-field">
        <button
          type="button"
          className={`negate${spec.negate ? " on" : ""}`}
          aria-pressed={spec.negate}
          title="Invert match (Alt+N)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setSpec((s) => ({ ...s, negate: !s.negate }))}
        >
          NOT
        </button>
        {chips.length === 0 && !query && <span className="chip chip-any">any</span>}
        {chips.map((c, idx) => (
          <span key={c.key} className={`chip chip-${c.kind}`} title={c.title}>
            <span className={`obj-badge obj-${c.kind}`} aria-hidden>
              {BADGE[c.kind]}
            </span>
            {c.alias ? (
              <button
                type="button"
                className="chip-label link-button"
                title={`Edit alias ${c.label}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => aliasDialog.setDialog({ mode: "edit", alias: c.alias, name: c.label })}
              >
                {c.label}
              </button>
            ) : (
              <span className="chip-label">{c.label}</span>
            )}
            <button
              type="button"
              className="chip-remove"
              aria-label={`Remove ${c.label}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setSpec((s) => ({ ...s, items: s.items.filter((_, i) => i !== idx) }))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="picker-input"
          value={query}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={suggestions.length ? `${listId}-${highlight}` : undefined}
          aria-label="Address, network, interface or alias"
          placeholder={chips.length ? "" : "Type an address or alias…"}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlight(0);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      {!aliasDialog.dialog && (
        <div className="picker-dropdown">
          <SuggestionList listId={listId} suggestions={suggestions} highlight={highlight} onPick={pick} onHover={setHighlight} />
          <div className="picker-hint">Enter adds · Enter on empty finishes · Tab finishes · Esc cancels</div>
        </div>
      )}
      {aliasDialog.element(boxRef.current?.getBoundingClientRect() ?? null)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Port picker (single value)

export function PortEditor({ value, onCommit, onCancel, commitHandle, initialText, ctx }: BaseEditorProps<PortSpec> & { ctx: ObjectContext }) {
  const [query, setQuery] = useState(initialText ?? "");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const aliasDialog = useAliasDialog(
    "port",
    (name) => onCommit({ kind: "alias", name }, "none"),
    () => {},
  );
  const suggestions = useMemo(() => portSuggestions(query, ctx), [query, ctx]);
  commitHandle.current = aliasDialog.dialog ? null : () => {
    const r = query.trim() ? resolvePortToken(query, ctx) : value;
    if (r) onCommit(r, "none");
    else onCancel();
  };
  useLayoutEffect(() => inputRef.current?.focus(), []);

  const pick = (s: Suggestion, move: MoveAfterCommit) => {
    if (s.kind === "create") aliasDialog.setDialog({ mode: "create", name: s.createName ?? "" });
    else if (s.port) onCommit(s.port, move);
  };

  const current = value.kind === "any" ? "any" : value.kind === "alias" ? value.name : value.value;

  return (
    <div className="picker" ref={boxRef}>
      <div className="picker-field">
        <input
          ref={inputRef}
          className="picker-input"
          value={query}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={suggestions.length ? `${listId}-${highlight}` : undefined}
          aria-label="Port, range or port alias"
          placeholder={current}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlight(0);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              const move = moveForKey(e);
              if (!query.trim()) return onCommit(value, move);
              const s = suggestions[highlight];
              if (s) pick(s, move);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      {!aliasDialog.dialog && (
        <div className="picker-dropdown">
          <SuggestionList listId={listId} suggestions={suggestions} highlight={highlight} onPick={(s) => pick(s, "none")} onHover={setHighlight} />
        </div>
      )}
      {aliasDialog.element(boxRef.current?.getBoundingClientRect() ?? null)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Interfaces (multi-select)

export function InterfacesEditor({ value, onCommit, onCancel, commitHandle, ctx }: BaseEditorProps<string[]> & { ctx: ObjectContext }) {
  const [sel, setSel] = useState<string[]>(value);
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLUListElement>(null);
  const items = ctx.options.interfaces.filter((i) => i.kind === "interface" || i.kind === "group");
  commitHandle.current = () => onCommit(sel, "none");
  useLayoutEffect(() => ref.current?.focus(), []);
  const toggle = (key: string) => setSel((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));
  return (
    <div className="picker">
      <ul
        ref={ref}
        tabIndex={0}
        role="listbox"
        aria-multiselectable
        aria-label="Interfaces"
        className="suggestions iface-list"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, items.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === " ") {
            e.preventDefault();
            const it = items[highlight];
            if (it) toggle(it.key);
          } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            onCommit(sel, moveForKey(e));
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        {items.map((i, idx) => (
          <li
            key={i.key}
            role="option"
            aria-selected={sel.includes(i.key)}
            className={`suggestion${idx === highlight ? " active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              toggle(i.key);
              setHighlight(idx);
            }}
          >
            <span className="check" aria-hidden>
              {sel.includes(i.key) ? "☑" : "☐"}
            </span>
            <span className="suggestion-label">{i.label}</span>
            <span className="suggestion-detail">
              {i.key}
              {i.kind === "group" ? " · group" : ""}
            </span>
          </li>
        ))}
      </ul>
      <div className="picker-hint">Space toggles · none selected = floating (all interfaces) · Enter finishes</div>
    </div>
  );
}
