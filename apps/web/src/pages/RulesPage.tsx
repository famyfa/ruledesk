import { useMemo, useState } from "react";
import {
  addRule,
  newRuleTemplate,
  changedRuleFields,
  indexAliases,
  ruleRecord,
  RULE_FILTER_FIELDS,
  RULE_ACTIONS,
  updateRule,
  updateRules,
  type FirewallRule,
  type WorkingCopy,
  type RulePatch,
} from "@ruledeck/core";
import { useWorkspace } from "../workspace.tsx";
import { FilterInput, useFilter } from "../components/FilterInput.tsx";
import { SyncDialog } from "../components/SyncDialog.tsx";
import { RuleGrid } from "../grid/RuleGrid.tsx";
import { RuleEditorDialog } from "../forms/RuleEditorDialog.tsx";
import type { ObjectContext } from "../grid/objects.ts";

interface Filters {
  text: string;
  iface: string;
  action: string;
  protocol: string;
  changedOnly: boolean;
  /** Hide automatic/legacy rules that can't be edited. */
  hideReadOnly: boolean;
}

const EMPTY: Filters = { text: "", iface: "", action: "", protocol: "", changedOnly: false, hideReadOnly: true };

export function RulesPage({ initialActiveId = null }: { initialActiveId?: string | null }) {
  const { wc, edit, sites, siteId } = useWorkspace();
  const [syncOpen, setSyncOpen] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(initialActiveId);
  // `opened` is the working copy as it was when the form opened, so Cancel can undo
  // everything done inside the form (including aliases created there).
  const [editor, setEditor] = useState<
    ({ mode: "edit"; id: string } | { mode: "new"; afterId?: string; rule: FirewallRule }) & { opened: WorkingCopy }
  | null>(null);

  const ctx: ObjectContext | null = useMemo(() => (wc ? { options: wc.baseline.options, aliases: wc.current.aliases } : null), [wc]);

  const env = useMemo(
    () => ({
      fields: RULE_FILTER_FIELDS,
      portNames: new Map((wc?.baseline.options.wellKnownPorts ?? []).flatMap((p) => {
        const n = /\((\d+)\)/.exec(p.label);
        return n ? [[p.value.toLowerCase(), Number(n[1])] as [string, number]] : [];
      })),
    }),
    [wc?.baseline.options.wellKnownPorts],
  );
  const filter = useFilter(filters.text, env);

  const rows = useMemo(() => {
    if (!wc || !ctx) return [];
    const aliasIndex = indexAliases(wc.current.aliases);
    return wc.current.rules.filter((r) => {
      if (filters.hideReadOnly && r.origin !== "mvc") return false;
      if (filters.iface === "__floating" && r.interfaces.length === 1 && !r.interfaceNot) return false;
      if (filters.iface && filters.iface !== "__floating" && r.interfaces.length > 0 && !r.interfaces.includes(filters.iface)) return false;
      if (filters.action && r.action !== filters.action) return false;
      if (filters.protocol && r.protocol !== filters.protocol) return false;
      if (filters.changedOnly && changedRuleFields(wc, r).size === 0 && wc.baseline.rules.some((b) => b.id === r.id)) return false;
      if (!filter.empty && !filter.test(ruleRecord(r, aliasIndex))) return false;
      return true;
    });
  }, [wc, ctx, filters, filter]);

  if (!wc || !ctx) return null;
  const activeFilters = Object.entries(filters).filter(([k, v]) => (k === "hideReadOnly" ? !v : v)).length;

  return (
    <div className="rules-page">
      <div className="filter-bar" role="search">
        <FilterInput value={filters.text} onChange={(v) => setFilters({ ...filters, text: v })} fields={RULE_FILTER_FIELDS} error={filter.error} label="Filter rules" />
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
          <input type="checkbox" checked={filters.hideReadOnly} onChange={(e) => setFilters({ ...filters, hideReadOnly: e.target.checked })} />
          Hide default read-only rules
        </label>
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
        {sites.filter((s) => s.signedIn).length > 1 && siteId && (
          <button type="button" onClick={() => setSyncOpen(true)} title="Copy rules to another site (staged there for review)">
            Sync to site…
          </button>
        )}
        {syncOpen && siteId && <SyncDialog kind="rules" fromId={siteId} preselect={[...selected]} onClose={() => setSyncOpen(false)} />}
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
