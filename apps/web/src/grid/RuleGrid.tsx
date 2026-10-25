import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  batch,
  changedRuleFields,
  cloneRule,
  deleteRules,
  moveRule,
  nudgeRule,
  ruleStatus,
  updateRule,
  type FirewallRule,
  type FieldIssues,
  type RulePatch,
} from "@ruledeck/core";
import { useWorkspace } from "../workspace.tsx";
import { COLUMNS } from "./columns.tsx";
import { measureColumnWidths } from "./widths.ts";
import type { ObjectContext } from "./objects.ts";

const ROW_HEIGHT = 32;
const LEAD = [
  { key: "select", width: 30 },
  { key: "status", width: 52 },
  { key: "pos", width: 52 },
];

interface Cell {
  row: number;
  col: number;
}

export interface RuleGridProps {
  rows: FirewallRule[];
  ctx: ObjectContext;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  onInspect: (id: string) => void;
  /** Open the rule editor dialog for a rule. */
  onEdit: (id: string) => void;
  /** Open the rule editor dialog for a new rule (placed after `afterId`). */
  onAdd: (afterId?: string) => void;
}

/**
 * The rule grid: view, select, reorder, bulk actions, copy/paste. Editing a
 * rule happens in the rule editor dialog (double-click or Enter).
 */
export function RuleGrid({ rows, ctx, selected, setSelected, activeId, setActiveId, onInspect, onEdit, onAdd }: RuleGridProps) {
  const { wc, edit, notify, validation } = useWorkspace();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [cell, setCell] = useState<Cell>(() => ({ row: Math.max(0, rows.findIndex((r) => r.id === activeId)), col: 0 }));
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const anchorRow = useRef<number | null>(null);

  const allRules = wc?.current.rules ?? [];
  const positions = useMemo(() => new Map(allRules.map((r, i) => [r.id, i + 1])), [allRules]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // The grid owns the active cell; `lastId` remembers which rule it is on so
  // the cell can follow that rule when rows are filtered, moved or inserted.
  const lastId = useRef<string | null>(activeId);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    const idx = lastId.current ? rows.findIndex((r) => r.id === lastId.current) : -1;
    if (idx >= 0) {
      setCell((c) => (c.row === idx ? c : { ...c, row: idx }));
    } else {
      const fallback = rows[Math.min(cell.row, rows.length - 1)];
      lastId.current = fallback?.id ?? null;
      setActiveId(lastId.current);
    }
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  // Someone outside the grid picked a rule (add, clone, "show rule" links).
  useEffect(() => {
    if (!activeId || activeId === lastId.current) return;
    const idx = rows.findIndex((r) => r.id === activeId);
    if (idx < 0) return;
    lastId.current = activeId;
    setCell((c) => ({ ...c, row: idx }));
    virtualizer.scrollToIndex(idx, { align: "center" });
  }, [activeId, rows]); // eslint-disable-line react-hooks/exhaustive-deps

  // Report the active rule when the user moves the cell.
  useEffect(() => {
    const r = rowsRef.current[cell.row];
    if (r && r.id !== lastId.current) {
      lastId.current = r.id;
      setActiveId(r.id);
    }
  }, [cell.row, setActiveId]);

  const activeRule = rows[cell.row];

  const focusCell = useCallback(() => {
    requestAnimationFrame(() => {
      // Don't pull focus out of a dialog that's open on top of the grid.
      if (document.activeElement?.closest("[role=dialog]")) return;
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-cell="${cell.row}:${cell.col}"]`);
      el?.focus({ preventScroll: true });
    });
  }, [cell]);

  useEffect(() => {
    focusCell();
  }, [cell, focusCell]);

  const moveTo = useCallback(
    (row: number, col: number) => {
      const r = Math.max(0, Math.min(rows.length - 1, row));
      const c = Math.max(0, Math.min(COLUMNS.length - 1, col));
      setCell({ row: r, col: c });
      virtualizer.scrollToIndex(r, { align: "auto" });
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-cell="${r}:${c}"]`);
      el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
    [rows.length, virtualizer],
  );

  const step = (dir: "right" | "left") => {
    if (dir === "right") cell.col === COLUMNS.length - 1 ? moveTo(cell.row + 1, 0) : moveTo(cell.row, cell.col + 1);
    else cell.col === 0 ? moveTo(cell.row - 1, COLUMNS.length - 1) : moveTo(cell.row, cell.col - 1);
  };

  const readOnly = (rule: FirewallRule | undefined) => {
    if (!rule) return true;
    if (rule.origin !== "mvc") {
      notify("info", "This rule is managed outside the rules API (legacy or automatic) and is read-only in RuleDeck.");
      return true;
    }
    return false;
  };

  // ------------------------------------------------------------- row actions
  const targetIds = () => (selected.size ? [...selected] : activeRule ? [activeRule.id] : []);

  const doClone = (id: string) => {
    let newId = "";
    if (edit((w) => {
      const r = cloneRule(w, id);
      newId = r.id;
      return r.wc;
    })) {
      setActiveId(newId);
      notify("info", "Rule cloned below the original (staged).");
    }
  };

  const doDelete = (ids: string[]) => {
    if (!ids.length) return;
    if (edit((w) => deleteRules(w, ids))) {
      setSelected(new Set());
      notify("info", `${ids.length} rule${ids.length > 1 ? "s" : ""} deleted (staged). Ctrl+Z to undo.`);
    }
  };

  const doAdd = () => onAdd(activeRule?.origin === "mvc" ? activeRule.id : undefined);

  // ------------------------------------------------------------- keyboard
  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const { row, col } = cell;
    switch (true) {
      case e.key === "ArrowDown" && e.altKey:
      case e.key === "ArrowUp" && e.altKey: {
        e.preventDefault();
        if (activeRule && !readOnly(activeRule)) edit((w) => nudgeRule(w, activeRule.id, e.key === "ArrowUp" ? -1 : 1));
        return;
      }
      case e.key === "ArrowDown":
        e.preventDefault();
        return moveTo(row + 1, col);
      case e.key === "ArrowUp":
        e.preventDefault();
        return moveTo(row - 1, col);
      case e.key === "ArrowRight":
        e.preventDefault();
        return moveTo(row, col + 1);
      case e.key === "ArrowLeft":
        e.preventDefault();
        return moveTo(row, col - 1);
      case e.key === "PageDown":
        e.preventDefault();
        return moveTo(row + 15, col);
      case e.key === "PageUp":
        e.preventDefault();
        return moveTo(row - 15, col);
      case e.key === "Home":
        e.preventDefault();
        return mod ? moveTo(0, col) : moveTo(row, 0);
      case e.key === "End":
        e.preventDefault();
        return mod ? moveTo(rows.length - 1, col) : moveTo(row, COLUMNS.length - 1);
      case e.key === "Tab":
        e.preventDefault();
        return step(e.shiftKey ? "left" : "right");
      case e.key === "Enter" || e.key === "F2":
        e.preventDefault();
        if (activeRule) onEdit(activeRule.id);
        return;
      case e.key === " ":
        e.preventDefault();
        if (activeRule) toggleSelect(activeRule.id, e.shiftKey);
        return;
      case e.key === "Delete":
        e.preventDefault();
        return doDelete(targetIds().filter((id) => rows.find((r) => r.id === id)?.origin === "mvc"));
      case e.key === "Insert":
        e.preventDefault();
        return doAdd();
      case mod && e.key.toLowerCase() === "d":
        e.preventDefault();
        if (activeRule && !readOnly(activeRule)) doClone(activeRule.id);
        return;
      case mod && e.key.toLowerCase() === "a":
        e.preventDefault();
        setSelected(new Set(rows.map((r) => r.id)));
        return;
      case mod && e.key.toLowerCase() === "i":
        e.preventDefault();
        if (activeRule) onInspect(activeRule.id);
        return;
      case e.key === "Escape":
        if (selected.size) setSelected(new Set());
        return;
    }
  };

  const toggleSelect = (id: string, range: boolean) => {
    const idx = rows.findIndex((r) => r.id === id);
    const next = new Set(selected);
    if (range && anchorRow.current !== null) {
      const [a, b] = [anchorRow.current, idx].sort((x, y) => x - y) as [number, number];
      for (let i = a; i <= b; i++) next.add(rows[i]!.id);
    } else if (next.has(id)) next.delete(id);
    else next.add(id);
    anchorRow.current = idx;
    setSelected(next);
  };

  // ------------------------------------------------------------- clipboard
  const onCopy = (e: ClipboardEvent) => {
    e.preventDefault();
    let text: string;
    if (selected.size > 1) {
      const sel = rows.filter((r) => selected.has(r.id));
      text = sel.map((r) => COLUMNS.map((c) => c.copy(r, ctx)).join("\t")).join("\n");
    } else {
      text = activeRule ? COLUMNS[cell.col]!.copy(activeRule, ctx) : "";
    }
    e.clipboardData.setData("text/plain", text);
  };

  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain").replace(/\r/g, "").replace(/\n$/, "");
    if (!text) return;
    const grid = text.split("\n").map((line) => line.split("\t"));
    const updates: { rule: FirewallRule; patch: RulePatch }[] = [];
    for (let i = 0; i < grid.length; i++) {
      const rule = rows[cell.row + i];
      if (!rule) break;
      if (rule.origin !== "mvc") {
        notify("error", `Paste stopped: row ${cell.row + i + 1} is a read-only rule.`);
        return;
      }
      let patch: RulePatch = {};
      for (let j = 0; j < grid[i]!.length; j++) {
        const col = COLUMNS[cell.col + j];
        if (!col?.paste) continue;
        const r = col.paste(grid[i]![j]!, ctx, rule);
        if (typeof r === "string") {
          notify("error", `Paste rejected (row ${cell.row + i + 1}, ${col.label}): ${r}`);
          return;
        }
        patch = { ...patch, ...r };
      }
      updates.push({ rule, patch });
    }
    edit((w) => batch(w, (b) => updates.reduce((acc, u) => updateRule(acc, u.rule.id, u.patch), b)));
    notify("info", `Pasted into ${updates.length} row${updates.length > 1 ? "s" : ""}.`);
  };

  // ------------------------------------------------------------- drag & drop
  const onDragStart = (e: DragEvent, rule: FirewallRule) => {
    if (rule.origin !== "mvc") return e.preventDefault();
    setDragId(rule.id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", rule.id);
  };
  const onDragOver = (e: DragEvent, rule: FirewallRule) => {
    const dragged = allRules.find((r) => r.id === dragId);
    if (!dragged || rule.origin !== "mvc" || dragged.prioGroup !== rule.prioGroup) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDropTarget({ id: rule.id, after: e.clientY > rect.top + rect.height / 2 });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (dragId && dropTarget && dragId !== dropTarget.id) {
      const target = dropTarget;
      edit((w) => {
        if (!target.after) return moveRule(w, dragId, target.id);
        const group = w.current.rules.filter((r) => r.prioGroup === allRules.find((x) => x.id === target.id)?.prioGroup && r.origin === "mvc" && r.id !== dragId);
        const idx = group.findIndex((r) => r.id === target.id);
        return moveRule(w, dragId, group[idx + 1]?.id ?? null);
      });
    }
    setDragId(null);
    setDropTarget(null);
  };

  // ------------------------------------------------------------- render
  const issuesFor = (id: string): FieldIssues | undefined => validation?.rules[id];

  const onCellMouseDown = (rowIdx: number, colIdx: number) => setCell({ row: rowIdx, col: colIdx });

  // Columns are as wide as their longest content (header included), so nothing is cut off.
  const widths = useMemo(() => measureColumnWidths(COLUMNS, rows, ctx), [rows, ctx]);

  let left = 0;
  const leadLeft = LEAD.map((c) => {
    const l = left;
    left += c.width;
    return l;
  });
  const colLeft = COLUMNS.map((c, i) => {
    if (!c.sticky) return undefined;
    const l = left;
    left += widths[i]!;
    return l;
  });

  const items = virtualizer.getVirtualItems();
  const padTop = items[0]?.start ?? 0;
  const padBottom = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0);
  const totalWidth = LEAD.reduce((s, c) => s + c.width, 0) + widths.reduce((s, w) => s + w, 0) + 150;

  if (!wc) return null;

  return (
    <div className="grid-wrap">
      <div className="grid-toolbar">
        <button type="button" onClick={doAdd} title="Add a rule below the active row (Insert)">
          + Add rule
        </button>
        {activeRule && (
          <span className="hint">
            Double-click or Enter to edit · Ctrl+D clone · Alt+↑/↓ move · Del delete · Ctrl+C/V copy/paste · Ctrl+Z undo
          </span>
        )}
      </div>
      <div className="grid-scroll" ref={scrollRef}>
        <table
          className="rule-grid"
          role="grid"
          aria-rowcount={rows.length}
          aria-colcount={COLUMNS.length}
          style={{ width: totalWidth }}
          onKeyDown={onKeyDown}
          onCopy={onCopy}
          onPaste={onPaste}
        >
          <colgroup>
            {LEAD.map((c) => (
              <col key={c.key} style={{ width: c.width }} />
            ))}
            {COLUMNS.map((c, i) => (
              <col key={c.key} style={{ width: widths[i] }} />
            ))}
            <col style={{ width: 150 }} />
          </colgroup>
          <thead>
            <tr role="row">
              <th className="sticky" style={{ left: leadLeft[0] }} scope="col">
                <input
                  type="checkbox"
                  aria-label="Select all visible rules"
                  checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
                  onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                />
              </th>
              <th className="sticky" style={{ left: leadLeft[1] }} scope="col">
                State
              </th>
              <th className="sticky" style={{ left: leadLeft[2] }} scope="col" title="Evaluation order on the firewall">
                #
              </th>
              {COLUMNS.map((c, i) => (
                <th key={c.key} scope="col" className={c.sticky ? "sticky" : undefined} style={c.sticky ? { left: colLeft[i] } : undefined}>
                  {c.label}
                </th>
              ))}
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {padTop > 0 && (
              <tr aria-hidden>
                <td style={{ height: padTop }} colSpan={COLUMNS.length + 4} />
              </tr>
            )}
            {items.map((vi) => {
              const rule = rows[vi.index]!;
              const status = ruleStatus(wc, rule);
              const changed = changedRuleFields(wc, rule);
              const issues = issuesFor(rule.id);
              const ro = rule.origin !== "mvc";
              const prevGroup = rows[vi.index - 1]?.prioGroup;
              const groupStart = vi.index > 0 && prevGroup !== rule.prioGroup;
              const cls = [
                "row",
                `row-${status}`,
                ro ? "row-readonly" : "",
                selected.has(rule.id) ? "row-selected" : "",
                !rule.enabled ? "row-disabled" : "",
                issues ? "row-invalid" : "",
                groupStart ? "row-group-start" : "",
                dropTarget?.id === rule.id ? (dropTarget.after ? "drop-after" : "drop-before") : "",
                dragId === rule.id ? "row-dragging" : "",
              ].join(" ");
              return (
                <tr
                  key={rule.id}
                  role="row"
                  aria-rowindex={vi.index + 1}
                  aria-selected={selected.has(rule.id)}
                  className={cls}
                  style={{ height: ROW_HEIGHT }}
                  onDragOver={(e) => onDragOver(e, rule)}
                  onDrop={onDrop}
                  onDragLeave={() => setDropTarget((d) => (d?.id === rule.id ? null : d))}
                  data-rule-id={rule.id}
                >
                  <td className="sticky lead" style={{ left: leadLeft[0] }}>
                    <input
                      type="checkbox"
                      tabIndex={-1}
                      aria-label={`Select rule ${positions.get(rule.id)}`}
                      checked={selected.has(rule.id)}
                      onChange={() => {}}
                      onClick={(e) => toggleSelect(rule.id, e.shiftKey)}
                    />
                  </td>
                  <td className="sticky lead status-cell" style={{ left: leadLeft[1] }}>
                    <StatusTag status={status} readOnly={ro} invalid={!!issues} enabled={rule.enabled} />
                  </td>
                  <td className="sticky lead pos-cell" style={{ left: leadLeft[2] }}>
                    <span
                      className={`drag-handle${ro ? " disabled" : ""}`}
                      draggable={!ro}
                      onDragStart={(e) => onDragStart(e, rule)}
                      onDragEnd={() => {
                        setDragId(null);
                        setDropTarget(null);
                      }}
                      title={ro ? "Read-only rule" : "Drag to reorder (within its group)"}
                      aria-hidden
                    >
                      ⋮⋮
                    </span>
                    {positions.get(rule.id)}
                  </td>
                  {COLUMNS.map((col, ci) => {
                    const isActive = vi.index === cell.row && ci === cell.col;
                    const fieldIssues = col.field ? issues?.[col.field] : undefined;
                    const modified = col.field ? changed.has(col.field) : false;
                    return (
                      <td
                        key={col.key}
                        role="gridcell"
                        data-cell={`${vi.index}:${ci}`}
                        tabIndex={isActive ? 0 : -1}
                        aria-readonly={ro || undefined}
                        aria-invalid={fieldIssues ? true : undefined}
                        title={fieldIssues?.join("\n")}
                        className={[
                          "cell",
                          `col-${col.key}`,
                          col.sticky ? "sticky" : "",
                          isActive ? "cell-active" : "",
                          modified ? "cell-modified" : "",
                          fieldIssues ? "cell-invalid" : "",
                        ].join(" ")}
                        style={col.sticky ? { left: colLeft[ci] } : undefined}
                        onMouseDown={() => onCellMouseDown(vi.index, ci)}
                        onDoubleClick={() => onEdit(rule.id)}
                      >
                        <div className="cell-content">
                          {col.render(rule, ctx)}
                          {fieldIssues && (
                            <span className="cell-issue" aria-label={fieldIssues.join(" ")}>
                              ⚠
                            </span>
                          )}
                        </div>
                      </td>
                    );
                  })}
                  <td className="actions-cell">
                    <RowActions
                      readOnly={ro}
                      onClone={() => doClone(rule.id)}
                      onUp={() => edit((w) => nudgeRule(w, rule.id, -1))}
                      onDown={() => edit((w) => nudgeRule(w, rule.id, 1))}
                      onDelete={() => doDelete([rule.id])}
                      onInspect={() => onInspect(rule.id)}
                    />
                  </td>
                </tr>
              );
            })}
            {padBottom > 0 && (
              <tr aria-hidden>
                <td style={{ height: padBottom }} colSpan={COLUMNS.length + 4} />
              </tr>
            )}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty">No rules match the current filter.</div>}
      </div>
    </div>
  );
}

function StatusTag({ status, readOnly, invalid, enabled }: { status: string; readOnly: boolean; invalid: boolean; enabled: boolean }) {
  if (invalid) return <span className="tag tag-invalid" title="This rule has problems">⚠ ERR</span>;
  if (status === "added") return <span className="tag tag-added" title="New, staged locally">+ NEW</span>;
  if (status === "modified") return <span className="tag tag-modified" title="Modified, staged locally">● MOD</span>;
  if (readOnly) return <span className="tag tag-readonly" title="Legacy or automatic rule, read-only">🔒 RO</span>;
  if (!enabled) return <span className="tag tag-off">off</span>;
  return null;
}

function RowActions(props: { readOnly: boolean; onClone: () => void; onUp: () => void; onDown: () => void; onDelete: () => void; onInspect: () => void }) {
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <span className="row-actions">
      <button type="button" tabIndex={-1} title="Inspect (Ctrl+I)" aria-label="Inspect rule" onClick={stop(props.onInspect)}>
        ⓘ
      </button>
      {!props.readOnly && (
        <>
          <button type="button" tabIndex={-1} title="Clone (Ctrl+D)" aria-label="Clone rule" onClick={stop(props.onClone)}>
            ⧉
          </button>
          <button type="button" tabIndex={-1} title="Move up (Alt+↑)" aria-label="Move rule up" onClick={stop(props.onUp)}>
            ↑
          </button>
          <button type="button" tabIndex={-1} title="Move down (Alt+↓)" aria-label="Move rule down" onClick={stop(props.onDown)}>
            ↓
          </button>
          <button type="button" tabIndex={-1} title="Delete (Del)" aria-label="Delete rule" className="danger" onClick={stop(props.onDelete)}>
            🗑
          </button>
        </>
      )}
    </span>
  );
}
