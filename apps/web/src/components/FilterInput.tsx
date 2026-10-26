import { useMemo, useRef, useState } from "react";
import { compileFilter, FILTER_OPS, type FilterEnv, type FilterFieldInfo, type FilterSyntaxError } from "@ruledeck/core";

/**
 * Filter box: type an expression such as
 * `( addr.src in 10.0.0.0/8 ) and ( action eq block )`, get field/operator
 * suggestions while typing, and a help list of all fields. Plain words are a
 * free-text search.
 */

export function useFilter(expr: string, env: FilterEnv) {
  return useMemo(() => compileFilter(expr, env), [expr, env]);
}

interface Suggestion {
  label: string;
  hint: string;
  /** Text that replaces the word being typed. */
  insert: string;
}

function suggest(value: string, fields: readonly FilterFieldInfo[]): { from: number; items: Suggestion[] } {
  const m = /[^\s()]*$/.exec(value)!;
  const word = m[0];
  const from = m.index;
  const before = value.slice(0, from).trimEnd().split(/\s+/);
  const prev = before[before.length - 1]?.replace(/^\(/, "").toLowerCase() ?? "";
  const prevField = fields.find((f) => f.name === prev);
  if (prevField) {
    return {
      from,
      items: FILTER_OPS.filter((o) => o.startsWith(word.toLowerCase()) && o !== word.toLowerCase()).map((o) => ({
        label: o,
        hint: o === "in" ? "inside a network or range" : o === "contains" ? "text contains" : o === "eq" ? "equals" : o === "neq" ? "does not equal" : "not inside",
        insert: `${o} `,
      })),
    };
  }
  if (!word || FILTER_OPS.includes(prev as never)) return { from, items: [] };
  const w = word.toLowerCase();
  return {
    from,
    items: fields.filter((f) => f.name.startsWith(w) && f.name !== w).map((f) => ({ label: f.name, hint: f.description, insert: `${f.name} ` })),
  };
}

export function FilterInput({
  value,
  onChange,
  fields,
  error,
  placeholder,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  fields: readonly FilterFieldInfo[];
  error: FilterSyntaxError | null;
  placeholder?: string;
  label: string;
}) {
  const [focused, setFocused] = useState(false);
  const [help, setHelp] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const sug = useMemo(() => suggest(value, fields), [value, fields]);

  const pick = (s: Suggestion) => {
    onChange(value.slice(0, sug.from) + s.insert);
    input.current?.focus();
  };
  const insertExample = (example: string) => {
    onChange(value.trim() ? `${value.trim()} and ( ${example} )` : `( ${example} )`);
    input.current?.focus();
  };

  return (
    <div className="filter-input">
      <div className={`filter-box${error ? " has-error" : ""}`}>
        <input
          ref={input}
          type="search"
          value={value}
          placeholder={placeholder ?? "Filter: ( addr.src in 10.0.0.0/8 ) and ( action eq block )"}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "Tab" && sug.items.length === 1) {
              e.preventDefault();
              pick(sug.items[0]!);
            }
          }}
          aria-label={label}
          aria-invalid={!!error}
          spellCheck={false}
          autoComplete="off"
        />
        <button type="button" className="ghost" onClick={() => setHelp((h) => !h)} aria-expanded={help} title="Filter syntax and fields">
          ?
        </button>
      </div>
      {error && (
        <div className="filter-error" role="alert">
          {error.message}
        </div>
      )}
      {focused && sug.items.length > 0 && (
        <ul className="filter-suggest" role="listbox">
          {sug.items.map((s) => (
            <li key={s.label}>
              <button type="button" role="option" aria-selected={false} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s)}>
                <b>{s.label}</b>
                <span className="muted">{s.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {help && (
        <div className="filter-help" role="region" aria-label="Filter help">
          <p>
            Combine terms with <code>and</code>, <code>or</code>, <code>not</code> and parentheses. Operators: <code>eq</code> <code>neq</code> <code>contains</code> <code>in</code> <code>notin</code>. Use{" "}
            <code>in</code> with networks and ranges (<code>10.0.0.0/8</code>, <code>80-443</code>). Words without a field are searched everywhere.
          </p>
          <table>
            <tbody>
              {fields.map((f) => (
                <tr key={f.name}>
                  <td>
                    <b>{f.name}</b>
                  </td>
                  <td>{f.description}</td>
                  <td>
                    <button type="button" className="link-button mono" onClick={() => insertExample(f.example)}>
                      {f.example}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
