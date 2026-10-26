import { type ReactNode } from "react";
import type { Item, OptionChoice } from "@ruledeck/core";

/**
 * Generic form controls for OPNsense model fields. The firewall's `get` answers carry no
 * field types, so the control is chosen from what is known: a list of choices (drop-down or,
 * for fields that take several values, a checkbox list), a 0/1 value (checkbox), a secret
 * (write-only input), or text.
 */

const NUMERIC_HINT = /(port|count|id|lifetime|time|priority|sequence|bits|len|num|vhid|mtu|tag|interval|delay|size|limit|timeout|depth|retries|ttl|weight|prefix|max|min|pcp|advskew|advbase|metric|level|age|version)/i;

export function humanize(path: string): string {
  const last = path.split(".").pop() ?? path;
  const words = last.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const sectionOf = (path: string): string => (path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : "");

function isBoolean(path: string, value: string, options?: OptionChoice[]): boolean {
  if (options) return false;
  const last = path.split(".").pop() ?? path;
  return (value === "0" || value === "1") && !NUMERIC_HINT.test(last);
}

export function FieldControl({
  path,
  value,
  options,
  multi,
  secret,
  changed,
  onChange,
}: {
  path: string;
  value: string;
  options?: OptionChoice[];
  multi?: boolean;
  secret?: boolean;
  changed?: boolean;
  onChange: (v: string) => void;
}) {
  const label = humanize(path);
  const cls = changed ? "svc-field changed" : "svc-field";

  if (secret) {
    return (
      <label className={cls}>
        <span className="svc-label">{label}</span>
        <input type="password" value={value} placeholder="(unchanged: type to replace)" autoComplete="new-password" onChange={(e) => onChange(e.target.value)} aria-label={label} />
        <span className="hint">Write-only: RuleDeck never shows this value.</span>
      </label>
    );
  }

  if (options) {
    const chosen = value ? value.split(",") : [];
    if (multi || chosen.length > 1) {
      return (
        <fieldset className={cls}>
          <legend className="svc-label">{label}</legend>
          <div className="svc-choices">
            {options.map((o) => (
              <label key={o.value} className="checkbox">
                <input
                  type="checkbox"
                  checked={chosen.includes(o.value)}
                  onChange={(e) => onChange((e.target.checked ? [...chosen, o.value] : chosen.filter((c) => c !== o.value)).join(","))}
                />
                {o.label || o.value}
              </label>
            ))}
            {options.length === 0 && <span className="muted">No choices available.</span>}
          </div>
        </fieldset>
      );
    }
    return (
      <label className={cls}>
        <span className="svc-label">{label}</span>
        <select value={chosen[0] ?? ""} onChange={(e) => onChange(e.target.value)} aria-label={label}>
          <option value="">{options.some((o) => o.value === "") ? "" : "(none)"}</option>
          {options
            .filter((o) => o.value !== "")
            .map((o) => (
              <option key={o.value} value={o.value}>
                {o.label || o.value}
              </option>
            ))}
        </select>
      </label>
    );
  }

  if (isBoolean(path, value)) {
    return (
      <label className={`${cls} svc-bool checkbox`}>
        <input type="checkbox" checked={value === "1"} onChange={(e) => onChange(e.target.checked ? "1" : "0")} aria-label={label} />
        <span className="svc-label">{label}</span>
      </label>
    );
  }

  return (
    <label className={cls}>
      <span className="svc-label">{label}</span>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} spellCheck={false} />
    </label>
  );
}

/** A form for one flat item: fields in the given order, grouped by section when asked. */
export function ItemForm({
  item,
  base,
  order,
  optionsOf,
  multi,
  secrets,
  grouped,
  onChange,
}: {
  item: Item;
  /** The values as loaded (to mark changed fields); null for a new item. */
  base: Item | null;
  order: string[];
  optionsOf: (path: string) => OptionChoice[] | undefined;
  multi: string[];
  secrets: ReadonlySet<string>;
  grouped?: boolean;
  onChange: (path: string, value: string) => void;
}) {
  const paths = [...new Set([...order.filter((k) => k in item), ...Object.keys(item)])];
  const field = (p: string): ReactNode => (
    <FieldControl
      key={p}
      path={p}
      value={item[p] ?? ""}
      options={optionsOf(p)}
      multi={multi.includes(p)}
      secret={secrets.has(p)}
      changed={base ? (base[p] ?? "") !== (item[p] ?? "") : (item[p] ?? "") !== ""}
      onChange={(v) => onChange(p, v)}
    />
  );
  if (!grouped) return <div className="svc-fields">{paths.map(field)}</div>;
  const sections = new Map<string, string[]>();
  for (const p of paths) sections.set(sectionOf(p), [...(sections.get(sectionOf(p)) ?? []), p]);
  return (
    <div className="svc-sections">
      {[...sections].map(([name, list], i) => (
        <details key={name} open={i < 2 || list.some((p) => base && (base[p] ?? "") !== (item[p] ?? ""))}>
          <summary>{name ? humanize(name) : "General"}</summary>
          <div className="svc-fields">{list.map(field)}</div>
        </details>
      ))}
    </div>
  );
}
