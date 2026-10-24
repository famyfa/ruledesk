import { useMemo, useRef, useState } from "react";
import {
  addressItemToken,
  changedRuleFields,
  formatAddress,
  formatPort,
  RULE_ACTIONS,
  ruleFieldChanges,
  updateRule,
  updateRules,
  type FirewallRule,
  type RulePatch,
} from "@ruledeck/core";
import { useWorkspace } from "../workspace.tsx";
import { RuleGrid } from "../grid/RuleGrid.tsx";
import type { ObjectContext } from "../grid/objects.ts";

interface Filters {
  text: string;
  iface: string;
  action: string;
  protocol: string;
  changedOnly: boolean;
}

const EMPTY: Filters = { text: "", iface: "", action: "", protocol: "", changedOnly: false };

function matchesText(r: FirewallRule, q: string, ctx: ObjectContext): boolean {
  const hay = [
    r.description,
    r.action,
    r.protocol,
    r.interfaces.join(" "),
    formatAddress(r.source),
    formatAddress(r.destination),
    formatPort(r.sourcePort),
    formatPort(r.destinationPort),
  ];
  // Also match addresses inside referenced aliases.
  for (const i of [...r.source.items, ...r.destination.items]) {
    if (i.kind === "alias") hay.push(ctx.aliases.find((a) => a.name === i.name)?.entries.join(" ") ?? "");
  }
  const text = hay.join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => text.includes(t));
}

export function RulesPage({ initialActiveId = null }: { initialActiveId?: string | null }) {
  const { wc, edit } = useWorkspace();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(initialActiveId);
  const [detailsOpen, setDetailsOpen] = useState(true);

  const ctx: ObjectContext | null = useMemo(() => (wc ? { options: wc.baseline.options, aliases: wc.current.aliases } : null), [wc]);

  const rows = useMemo(() => {
    if (!wc || !ctx) return [];
    return wc.current.rules.filter((r) => {
      if (filters.iface === "__floating" && r.interfaces.length === 1 && !r.interfaceNot) return false;
      if (filters.iface && filters.iface !== "__floating" && r.interfaces.length > 0 && !r.interfaces.includes(filters.iface)) return false;
      if (filters.action && r.action !== filters.action) return false;
      if (filters.protocol && r.protocol !== filters.protocol) return false;
      if (filters.changedOnly && changedRuleFields(wc, r).size === 0 && wc.baseline.rules.some((b) => b.id === r.id)) return false;
      if (filters.text && !matchesText(r, filters.text, ctx)) return false;
      return true;
    });
  }, [wc, ctx, filters]);

  if (!wc || !ctx) return null;
  const active = wc.current.rules.find((r) => r.id === activeId) ?? null;
  const activeFilters = Object.entries(filters).filter(([, v]) => v).length;

  return (
    <div className="rules-page">
      <div className="filter-bar" role="search">
        <input
          type="search"
          placeholder="Filter rules: text, address, alias, port…"
          value={filters.text}
          onChange={(e) => setFilters({ ...filters, text: e.target.value })}
          aria-label="Filter rules"
        />
        <select value={filters.iface} onChange={(e) => setFilters({ ...filters, iface: e.target.value })} aria-label="Interface filter">
          <option value="">All interfaces</option>
          <option value="__floating">Floating only</option>
          {ctx.options.interfaces.map((i) => (
            <option key={i.key} value={i.key}>
              {i.label}
            </option>
          ))}
        </select>
        <select value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} aria-label="Action filter">
          <option value="">All actions</option>
          {RULE_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select value={filters.protocol} onChange={(e) => setFilters({ ...filters, protocol: e.target.value })} aria-label="Protocol filter">
          <option value="">All protocols</option>
          {ctx.options.protocols.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <label className="checkbox">
          <input type="checkbox" checked={filters.changedOnly} onChange={(e) => setFilters({ ...filters, changedOnly: e.target.checked })} />
          Changed only
        </label>
        {activeFilters > 0 && (
          <button type="button" className="link-button" onClick={() => setFilters(EMPTY)}>
            Clear filters
          </button>
        )}
        <span className="count">
          {rows.length} of {wc.current.rules.length} rules
        </span>
        <button type="button" className="ghost" onClick={() => setDetailsOpen((o) => !o)} aria-pressed={detailsOpen}>
          {detailsOpen ? "Hide details" : "Show details"}
        </button>
      </div>

      {selected.size > 0 && <BulkBar ids={[...selected]} onDone={() => setSelected(new Set())} />}

      <div className={`rules-main${detailsOpen ? " with-details" : ""}`}>
        <RuleGrid
          rows={rows}
          ctx={ctx}
          selected={selected}
          setSelected={setSelected}
          activeId={activeId}
          setActiveId={setActiveId}
          onInspect={(id) => {
            setActiveId(id);
            setDetailsOpen(true);
          }}
        />
        {detailsOpen && <DetailsPanel rule={active} ctx={ctx} onEdit={(patch) => active && edit((w) => updateRule(w, active.id, patch))} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function BulkBar({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const { wc, edit, notify } = useWorkspace();
  const [descMode, setDescMode] = useState<"set" | "prefix" | "suffix">("prefix");
  const [descText, setDescText] = useState("");
  if (!wc) return null;
  const rules = wc.current.rules.filter((r) => ids.includes(r.id));
  const readOnly = rules.filter((r) => r.origin !== "mvc");
  const editable = rules.filter((r) => r.origin === "mvc");

  const apply = (patch: RulePatch, label: string) => {
    if (readOnly.length) {
      notify("error", `${readOnly.length} selected rule(s) are read-only (legacy/automatic). Deselect them to bulk edit.`);
      return;
    }
    if (edit((w) => updateRules(w, editable.map((r) => r.id), patch))) notify("info", `${label} on ${editable.length} rules (staged).`);
  };

  const applyDescription = () => {
    if (readOnly.length) {
      notify("error", `${readOnly.length} selected rule(s) are read-only. Deselect them to bulk edit.`);
      return;
    }
    edit((w) =>
      editable.reduce((acc, r) => {
        const d = descMode === "set" ? descText : descMode === "prefix" ? `${descText}${r.description}` : `${r.description}${descText}`;
        return updateRule(acc, r.id, { description: d });
      }, w),
    );
    notify("info", `Description updated on ${editable.length} rules (staged).`);
  };

  return (
    <div className="bulk-bar" role="toolbar" aria-label="Bulk edit selected rules">
      <strong>{ids.length} selected</strong>
      {readOnly.length > 0 && <span className="text-warn">({readOnly.length} read-only)</span>}
      <span className="sep" />
      <label>
        Action{" "}
        <select defaultValue="" onChange={(e) => e.target.value && apply({ action: e.target.value as FirewallRule["action"] }, `Action set to ${e.target.value}`)}>
          <option value="" disabled>
            set…
          </option>
          {RULE_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={() => apply({ enabled: true }, "Enabled")}>Enable</button>
      <button type="button" onClick={() => apply({ enabled: false }, "Disabled")}>Disable</button>
      <button type="button" onClick={() => apply({ log: true }, "Logging on")}>Log on</button>
      <button type="button" onClick={() => apply({ log: false }, "Logging off")}>Log off</button>
      <span className="sep" />
      <label>
        Description{" "}
        <select value={descMode} onChange={(e) => setDescMode(e.target.value as typeof descMode)} aria-label="Description operation">
          <option value="prefix">add prefix</option>
          <option value="suffix">add suffix</option>
          <option value="set">replace with</option>
        </select>
      </label>
      <input value={descText} onChange={(e) => setDescText(e.target.value)} aria-label="Description text" placeholder="text" size={14} />
      <button type="button" onClick={applyDescription} disabled={descMode !== "set" && !descText}>
        Apply
      </button>
      <span className="sep" />
      <button type="button" className="ghost" onClick={onDone}>
        Clear selection
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function DetailsPanel({ rule, ctx, onEdit }: { rule: FirewallRule | null; ctx: ObjectContext; onEdit: (patch: RulePatch) => void }) {
  const { wc, validation } = useWorkspace();
  const [showAll, setShowAll] = useState(false);
  if (!rule || !wc) {
    return (
      <aside className="details" aria-label="Rule details">
        <p className="muted">Select a rule to see its details.</p>
      </aside>
    );
  }
  const base = wc.baseline.rules.find((r) => r.id === rule.id);
  const changes = base ? ruleFieldChanges(base, rule) : [];
  const issues = validation?.rules[rule.id];
  const ro = rule.origin !== "mvc";
  const extraKeys = Object.keys(rule.extra).sort();
  const shownExtra = showAll ? extraKeys : extraKeys.filter((k) => rule.extra[k] !== "" && rule.extra[k] !== "0");

  const aliasRefs = [...rule.source.items, ...rule.destination.items]
    .filter((i) => i.kind === "alias")
    .map((i) => addressItemToken(i));
  if (rule.sourcePort.kind === "alias") aliasRefs.push(rule.sourcePort.name);
  if (rule.destinationPort.kind === "alias") aliasRefs.push(rule.destinationPort.name);

  return (
    <aside className="details" aria-label="Rule details">
      <h2>{rule.description || "(no description)"}</h2>
      <dl className="kv">
        <dt>Status</dt>
        <dd>{ro ? "Read-only (legacy/automatic)" : !base ? "New, staged locally" : changes.length ? "Modified, staged locally" : "Unchanged"}</dd>
        <dt>Position</dt>
        <dd>
          {wc.current.rules.findIndex((r) => r.id === rule.id) + 1} of {wc.current.rules.length}
          {rule.prioGroup && <span className="muted"> · group {groupName(rule.prioGroup)}</span>}
        </dd>
        <dt>Identity</dt>
        <dd className="mono">{rule.id}</dd>
        <dt>Quick</dt>
        <dd>
          <label className="checkbox">
            <input type="checkbox" checked={rule.quick} disabled={ro} onChange={(e) => onEdit({ quick: e.target.checked })} />
            Stop evaluating on match
          </label>
        </dd>
        <dt>Invert interface</dt>
        <dd>
          <label className="checkbox">
            <input type="checkbox" checked={rule.interfaceNot} disabled={ro} onChange={(e) => onEdit({ interfaceNot: e.target.checked })} />
            Match all interfaces except the selected ones
          </label>
        </dd>
      </dl>

      {issues && (
        <section>
          <h3 className="text-error">Problems</h3>
          <ul className="issue-list">
            {Object.entries(issues).flatMap(([f, msgs]) => msgs.map((m, i) => <li key={`${f}${i}`}>⚠ {m}</li>))}
          </ul>
        </section>
      )}

      {changes.length > 0 && (
        <section>
          <h3>Pending changes</h3>
          <ul className="change-fields">
            {changes.map((c) => (
              <li key={c.field}>
                <span className="field-label">{c.label}</span> <span className="before">{c.before || "(empty)"}</span> →{" "}
                <span className="after">{c.after || "(empty)"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {aliasRefs.length > 0 && (
        <section>
          <h3>Referenced aliases</h3>
          <ul className="alias-refs">
            {[...new Set(aliasRefs)].map((n) => {
              const a = ctx.aliases.find((x) => x.name === n);
              return (
                <li key={n}>
                  <strong>{n}</strong>{" "}
                  {a ? (
                    <span className="muted">
                      {a.type} · {a.entries.slice(0, 6).join(", ")}
                      {a.entries.length > 6 ? ` +${a.entries.length - 6}` : ""}
                    </span>
                  ) : (
                    <span className="text-error">missing</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section>
        <h3>
          Advanced fields{" "}
          <button type="button" className="link-button" onClick={() => setShowAll((s) => !s)}>
            {showAll ? "hide empty" : `show all (${extraKeys.length})`}
          </button>
        </h3>
        <p className="hint">Fields RuleDeck doesn't model directly. They are kept as-is and only sent when you change them.</p>
        <dl className="kv advanced">
          {shownExtra.map((k) => (
            <ExtraField key={k} name={k} value={rule.extra[k] ?? ""} readOnly={ro} onChange={(v) => onEdit({ extra: { ...rule.extra, [k]: v } })} />
          ))}
          {shownExtra.length === 0 && <dd className="muted">No non-default advanced values.</dd>}
        </dl>
      </section>
    </aside>
  );
}

function groupName(prio: string) {
  const p = Number(prio);
  if (p === 200000) return "floating";
  if (p >= 300000 && p < 400000) return "interface group";
  if (p === 400000) return "interface";
  if (p === 600000) return "invalid (not applied)";
  return prio;
}

function ExtraField({ name, value, readOnly, onChange }: { name: string; value: string; readOnly: boolean; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const cancelled = useRef(false);
  const shown = focused ? draft : value;
  return (
    <>
      <dt>
        <label htmlFor={`extra-${name}`}>{name}</label>
      </dt>
      <dd>
        <input
          id={`extra-${name}`}
          value={shown}
          disabled={readOnly}
          onFocus={() => {
            setDraft(value);
            setFocused(true);
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setFocused(false);
            if (!cancelled.current && draft !== value) onChange(draft);
            cancelled.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              cancelled.current = true;
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </dd>
    </>
  );
}
