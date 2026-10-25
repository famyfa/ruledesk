import { useMemo, useState } from "react";
import {
  addRule,
  newRuleTemplate,
  changedRuleFields,
  formatAddress,
  formatPort,
  RULE_ACTIONS,
  updateRule,
  updateRules,
  type FirewallRule,
  type WorkingCopy,
  type RulePatch,
} from "@ruledeck/core";
import { useWorkspace } from "../workspace.tsx";
import { RuleGrid } from "../grid/RuleGrid.tsx";
import { RuleEditorDialog } from "../forms/RuleEditorDialog.tsx";
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
  // `opened` is the working copy as it was when the form opened, so Cancel can undo
  // everything done inside the form (including aliases created there).
  const [editor, setEditor] = useState<
    ({ mode: "edit"; id: string } | { mode: "new"; afterId?: string; rule: FirewallRule }) & { opened: WorkingCopy }
  | null>(null);

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
      </div>

      {selected.size > 0 && <BulkBar ids={[...selected]} onDone={() => setSelected(new Set())} />}

      {editor && (() => {
        const rule = editor.mode === "edit" ? wc.current.rules.find((r) => r.id === editor.id) : editor.rule;
        if (!rule) return null;
        const position = editor.mode === "edit" ? wc.current.rules.findIndex((r) => r.id === rule.id) + 1 : (wc.current.rules.findIndex((r) => r.id === editor.afterId) + 2 || wc.current.rules.length + 1);
        return (
          <RuleEditorDialog
            key={editor.mode === "edit" ? editor.id : "new"}
            rule={rule}
            isNew={editor.mode === "new"}
            ctx={ctx}
            position={position}
            onCancel={() => {
              // Undo anything done in the form, such as aliases created or edited there.
              if (wc !== editor.opened) edit(() => editor.opened);
              setEditor(null);
            }}
            onSave={(patch) => {
              if (editor.mode === "edit") {
                if (Object.keys(patch).length) edit((w) => updateRule(w, rule.id, patch));
              } else {
                let newId = "";
                const ok = edit((w) => {
                  const r = addRule(w, { afterId: editor.afterId, patch: { ...patch, interfaces: patch.interfaces ?? rule.interfaces, interfaceNot: patch.interfaceNot ?? rule.interfaceNot } });
                  newId = r.id;
                  return r.wc;
                });
                if (ok) setActiveId(newId);
              }
              setEditor(null);
            }}
          />
        );
      })()}

      <div className="rules-main">
        <RuleGrid
          rows={rows}
          ctx={ctx}
          selected={selected}
          setSelected={setSelected}
          activeId={activeId}
          setActiveId={setActiveId}
          onInspect={(id) => setEditor({ mode: "edit", id, opened: wc })}
          onEdit={(id) => setEditor({ mode: "edit", id, opened: wc })}
          onAdd={(afterId) => {
            const anchor = wc.current.rules.find((r) => r.id === afterId);
            const rule = { ...newRuleTemplate("new", anchor?.prioGroup), interfaces: anchor ? [...anchor.interfaces] : [], interfaceNot: anchor?.interfaceNot ?? false };
            setEditor({ mode: "new", afterId, rule, opened: wc });
          }}
        />
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
