import { useId, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { addressItemToken, type AddressItem, type AddressSpec, type PortSpec } from "@ruledeck/core";
import { BADGE, SuggestionList, useAliasDialog } from "./pickerParts.tsx";
import { addressSuggestions, createAliasLabel, createAliasName, itemLabel, portSuggestions, resolveAddressToken, type ObjectContext, type Suggestion } from "../grid/objects.ts";

/**
 * Form fields for the rule editor dialog (Panorama-style). Controlled: value + onChange.
 * Address and port pickers offer existing objects and "Create alias", which opens the
 * alias form right there, without leaving the rule.
 */

function Chips({
  spec,
  ctx,
  onRemove,
  onEditAlias,
}: {
  spec: AddressSpec;
  ctx: ObjectContext;
  onRemove: (idx: number) => void;
  onEditAlias: (name: string) => void;
}) {
  return (
    <>
      {spec.items.map((i, idx) => {
        const aliasName = i.kind === "alias" ? i.name : null;
        const alias = aliasName ? ctx.aliases.find((a) => a.name === aliasName) : undefined;
        return (
          <span key={addressItemToken(i)} className={`chip chip-${i.kind}${aliasName && !alias ? " chip-missing" : ""}`} title={alias ? `${alias.type}: ${alias.entries.join(", ")}` : undefined}>
            <span className={`obj-badge obj-${i.kind}`} aria-hidden>
              {BADGE[i.kind]}
            </span>
            {alias && aliasName ? (
              <button type="button" className="chip-label link-button" title={`Edit alias ${aliasName}`} onClick={() => onEditAlias(aliasName)}>
                {aliasName}
              </button>
            ) : (
              <span className="chip-label">{itemLabel(i, ctx)}</span>
            )}
            <button type="button" className="chip-remove" aria-label={`Remove ${itemLabel(i, ctx)}`} onClick={() => onRemove(idx)}>
              ×
            </button>
          </span>
        );
      })}
    </>
  );
}

/** Multi-value address field: addresses, networks, interfaces, aliases. */
export function AddressField({ label, value, onChange, ctx, errors }: { label: string; value: AddressSpec; onChange: (v: AddressSpec) => void; ctx: ObjectContext; errors?: string[] }) {
  const id = useId();
  const listId = `${id}-list`;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  const add = (item: AddressItem | "any") => {
    const cur = valueRef.current;
    if (item === "any") onChange({ ...cur, items: [] });
    else if (!cur.items.some((i) => addressItemToken(i) === addressItemToken(item))) onChange({ ...cur, items: [...cur.items, item] });
    setQuery("");
    setHighlight(0);
  };
  const aliasDialog = useAliasDialog(
    "address",
    (name) => {
      add({ kind: "alias", name });
      inputRef.current?.focus();
    },
    (from, to) => {
      const cur = valueRef.current;
      onChange({ ...cur, items: cur.items.map((i) => (i.kind === "alias" && i.name === from ? { ...i, name: to } : i)) });
    },
    { quiet: true },
  );
  const suggestions = useMemo(() => addressSuggestions(query, ctx, value), [query, ctx, value]);
  const pick = (s: Suggestion) => {
    if (s.item) add(s.item);
  };
  const createNew = () => aliasDialog.setDialog({ mode: "create", name: createAliasName(query, ctx) });
  const footerIndex = suggestions.length;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, footerIndex));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      // Enter picks the highlighted entry; it never submits the dialog from inside a picker.
      e.preventDefault();
      if (highlight === footerIndex) createNew();
      else {
        const s = suggestions[highlight];
        if (query.trim() && s) pick(s);
      }
    } else if (e.key === "Escape" && (open || query)) {
      e.stopPropagation();
      setOpen(false);
      setQuery("");
    } else if (e.key === "Backspace" && !query && value.items.length) {
      onChange({ ...value, items: value.items.slice(0, -1) });
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const tokens = e.clipboardData.getData("text").split(/[\s,;]+/).filter(Boolean);
    if (tokens.length < 2) return;
    e.preventDefault();
    let cur = valueRef.current;
    const unresolved: string[] = [];
    for (const t of tokens) {
      const r = resolveAddressToken(t, ctx);
      if (!r) unresolved.push(t);
      else if (r === "any") cur = { ...cur, items: [] };
      else if (!cur.items.some((i) => addressItemToken(i) === addressItemToken(r))) cur = { ...cur, items: [...cur.items, r] };
    }
    onChange(cur);
    setQuery(unresolved.join(" "));
  };

  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <div className={`picker-box${errors?.length ? " invalid" : ""}`} ref={boxRef}>
        <div className="picker-field">
          <button type="button" className={`negate${value.negate ? " on" : ""}`} aria-pressed={value.negate} title="Invert match" onClick={() => onChange({ ...value, negate: !value.negate })}>
            NOT
          </button>
          {value.items.length === 0 && <span className="chip chip-any">any</span>}
          <Chips
            spec={value}
            ctx={ctx}
            onRemove={(idx) => onChange({ ...value, items: value.items.filter((_, i) => i !== idx) })}
            onEditAlias={(name) => {
              const alias = ctx.aliases.find((a) => a.name === name);
              if (alias) aliasDialog.setDialog({ mode: "edit", alias, name });
            }}
          />
          <input
            id={id}
            ref={inputRef}
            className="picker-input"
            value={query}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={open ? `${listId}-${highlight}` : undefined}
            placeholder="Add address, network, interface or alias…"
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        {open && !aliasDialog.dialog && (
          <div className="picker-dropdown inline">
            <SuggestionList
              listId={listId}
              suggestions={suggestions}
              highlight={highlight}
              onPick={pick}
              onHover={setHighlight}
              footer={{ label: createAliasLabel(query, ctx), onPick: createNew }}
            />
          </div>
        )}
      </div>
      {errors?.map((m) => (
        <p key={m} className="field-error">
          {m}
        </p>
      ))}
      {aliasDialog.element(boxRef.current?.getBoundingClientRect() ?? null)}
    </div>
  );
}

/** Single-value port field: any, port, range, well-known service, port alias. */
export function PortField({ label, value, onChange, ctx, errors, disabled }: { label: string; value: PortSpec; onChange: (v: PortSpec) => void; ctx: ObjectContext; errors?: string[]; disabled?: boolean }) {
  const id = useId();
  const listId = `${id}-list`;
  const current = value.kind === "any" ? "" : value.kind === "alias" ? value.name : value.value;
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const aliasDialog = useAliasDialog("port", (name) => onChange({ kind: "alias", name }), () => {}, { quiet: true });
  const q = query ?? "";
  const suggestions = useMemo(() => portSuggestions(q, ctx), [q, ctx]);
  const footerIndex = suggestions.length;
  const pick = (s: Suggestion) => {
    if (s.port) {
      onChange(s.port);
      setQuery(null);
      setOpen(false);
    }
  };
  const createNew = () => aliasDialog.setDialog({ mode: "create", name: createAliasName(q, ctx) });
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <div className={`picker-box${errors?.length ? " invalid" : ""}`} ref={boxRef}>
        <div className="picker-field">
          {value.kind === "alias" && (
            <span className="chip chip-alias">
              <span className="obj-badge obj-alias" aria-hidden>
                A
              </span>
              {value.name}
            </span>
          )}
          <input
            id={id}
            className="picker-input"
            disabled={disabled}
            value={query ?? (value.kind === "alias" ? "" : current)}
            placeholder={value.kind === "alias" ? "" : "any"}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={open ? `${listId}-${highlight}` : undefined}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              setTimeout(() => setOpen(false), 150);
              // A typed literal port/range is taken as-is on blur.
              if (query !== null) {
                const t = query.trim();
                if (!t) onChange({ kind: "any" });
                else if (/^\d+([-:]\d+)?$/.test(t)) onChange({ kind: "literal", value: t });
                setQuery(null);
              }
            }}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
              setHighlight(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlight((h) => Math.min(h + 1, footerIndex));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((h) => Math.max(h - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (highlight === footerIndex) createNew();
                else {
                  const s = suggestions[highlight];
                  if (s) pick(s);
                }
              }
            }}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        {open && !aliasDialog.dialog && (
          <div className="picker-dropdown inline">
            <SuggestionList
              listId={listId}
              suggestions={suggestions}
              highlight={highlight}
              onPick={pick}
              onHover={setHighlight}
              footer={{ label: createAliasLabel(q, ctx, true), onPick: createNew }}
            />
          </div>
        )}
      </div>
      {errors?.map((m) => (
        <p key={m} className="field-error">
          {m}
        </p>
      ))}
      {aliasDialog.element(boxRef.current?.getBoundingClientRect() ?? null)}
    </div>
  );
}

/** Interfaces as a checkbox list; none = floating (all interfaces). */
export function InterfacesField({ value, onChange, ctx, errors }: { value: string[]; onChange: (v: string[]) => void; ctx: ObjectContext; errors?: string[] }) {
  const items = ctx.options.interfaces.filter((i) => i.kind === "interface" || i.kind === "group");
  return (
    <fieldset className="form-field checkbox-list">
      <legend>Interfaces</legend>
      {items.map((i) => (
        <label key={i.key} className="checkbox">
          <input type="checkbox" checked={value.includes(i.key)} onChange={(e) => onChange(e.target.checked ? [...value, i.key] : value.filter((k) => k !== i.key))} />
          {i.label} <span className="muted">({i.key}{i.kind === "group" ? ", group" : ""})</span>
        </label>
      ))}
      <p className="hint">{value.length === 0 ? "None selected: the rule is floating and applies to all interfaces." : value.length > 1 ? "Several interfaces: the rule is evaluated as a floating rule." : ""}</p>
      {errors?.map((m) => (
        <p key={m} className="field-error">
          {m}
        </p>
      ))}
    </fieldset>
  );
}
