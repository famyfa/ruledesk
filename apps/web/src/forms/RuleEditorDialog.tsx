import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  IP_PROTOCOLS,
  RULE_ACTIONS,
  RULE_DIRECTIONS,
  validateRule,
  type FirewallRule,
  type RulePatch,
} from "@ruledeck/core";
import type { ObjectContext } from "../grid/objects.ts";
import { AddressField, InterfacesField, PortField } from "./fields.tsx";

/**
 * Panorama-style rule editor: one dialog with tabs. Nothing reaches the working
 * copy until OK, and OK applies everything as a single undo step.
 */

const TABS = ["General", "Source", "Destination", "Service", "Actions", "Advanced"] as const;
type Tab = (typeof TABS)[number];

/** Which tab each validation field lives on. */
const FIELD_TAB: Record<string, Tab> = {
  description: "General",
  interfaces: "General",
  direction: "General",
  ipProtocol: "General",
  source: "Source",
  sourcePort: "Service",
  destination: "Destination",
  destinationPort: "Service",
  protocol: "Service",
  action: "Actions",
};

const ACTION_LABEL: Record<string, string> = { pass: "Pass", block: "Block", reject: "Reject", match: "Match" };
const DIR_LABEL: Record<string, string> = { in: "In", out: "Out", any: "Any" };
const IPV_LABEL: Record<string, string> = { inet: "IPv4", inet6: "IPv6", inet46: "IPv4 + IPv6" };
const PORT_PROTOCOLS = new Set(["tcp", "udp", "tcp/udp"]);

/** The rule fields the dialog edits (everything except identity and order). */
function patchOf(before: FirewallRule, after: FirewallRule): RulePatch {
  const keys: (keyof RulePatch)[] = [
    "enabled", "action", "quick", "interfaces", "interfaceNot", "direction", "ipProtocol", "protocol",
    "source", "sourcePort", "destination", "destinationPort", "description", "log", "extra",
  ];
  const patch: Record<string, unknown> = {};
  for (const k of keys) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) patch[k] = after[k];
  return patch as RulePatch;
}

export function RuleEditorDialog({
  rule,
  isNew,
  ctx,
  position,
  onSave,
  onCancel,
}: {
  rule: FirewallRule;
  isNew: boolean;
  ctx: ObjectContext;
  position: number;
  onSave: (patch: RulePatch) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<FirewallRule>(rule);
  const [tab, setTab] = useState<Tab>("General");
  const [triedSave, setTriedSave] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);
  const readOnly = rule.origin !== "mvc";

  useEffect(() => firstField.current?.focus(), []);

  const set = (p: Partial<FirewallRule>) => setDraft((d) => ({ ...d, ...p }));
  const aliasesByName = useMemo(() => new Map(ctx.aliases.map((a) => [a.name, a])), [ctx.aliases]);
  const issues = useMemo(() => validateRule(draft, aliasesByName, ctx.options), [draft, aliasesByName, ctx.options]);
  const errorCount = Object.values(issues).flat().length;
  const tabErrors = (t: Tab) => Object.entries(issues).filter(([f]) => (FIELD_TAB[f] ?? "General") === t).flatMap(([, m]) => m).length;
  const portsAllowed = PORT_PROTOCOLS.has(draft.protocol.toLowerCase());
  const changed = Object.keys(patchOf(rule, draft)).length > 0;

  const save = () => {
    setTriedSave(true);
    if (errorCount) {
      const first = Object.keys(issues)[0];
      if (first) setTab(FIELD_TAB[first] ?? "General");
      return;
    }
    onSave(patchOf(rule, draft));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    }
  };

  const errs = (field: string) => (triedSave || draft !== rule ? issues[field] : undefined);
  const protocols = ctx.options.protocols.includes(draft.protocol) ? ctx.options.protocols : [draft.protocol, ...ctx.options.protocols];

  return (
    <div className="modal-backdrop">
      <div className="modal rule-editor" role="dialog" aria-modal="true" aria-label={isNew ? "New rule" : "Edit rule"} onKeyDown={onKeyDown}>
        <header className="rule-editor-head">
          <h2>{isNew ? "New rule" : readOnly ? "Rule (read-only)" : "Edit rule"}</h2>
          <span className="muted">
            #{position}
            {draft.description ? ` · ${draft.description}` : ""}
          </span>
        </header>
        {readOnly && <p className="banner banner-info">This rule is managed outside the rules API (legacy or automatic). RuleDeck can show it but not change it.</p>}

        <div className="tabs" role="tablist" aria-label="Rule sections">
          {TABS.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t}
              {tabErrors(t) > 0 && <span className="tab-error" aria-label={`${tabErrors(t)} problems`}> ⚠{tabErrors(t)}</span>}
            </button>
          ))}
        </div>

        <fieldset className="rule-editor-body" disabled={readOnly}>
          {tab === "General" && (
            <div className="form-grid">
              <div className="form-field wide">
                <label htmlFor="re-desc">Description</label>
                <input id="re-desc" ref={firstField} value={draft.description} onChange={(e) => set({ description: e.target.value })} placeholder="What this rule is for" />
              </div>
              <label className="checkbox">
                <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
                Enabled
              </label>
              <InterfacesField value={draft.interfaces} onChange={(interfaces) => set({ interfaces })} ctx={ctx} errors={errs("interfaces")} />
              <label className="checkbox">
                <input type="checkbox" checked={draft.interfaceNot} onChange={(e) => set({ interfaceNot: e.target.checked })} />
                Invert interfaces (match all except the selected ones)
              </label>
              <div className="form-field">
                <label htmlFor="re-dir">Direction</label>
                <select id="re-dir" value={draft.direction} onChange={(e) => set({ direction: e.target.value as FirewallRule["direction"] })}>
                  {RULE_DIRECTIONS.map((d) => (
                    <option key={d} value={d}>
                      {DIR_LABEL[d]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-field">
                <label htmlFor="re-ipv">IP version</label>
                <select id="re-ipv" value={draft.ipProtocol} onChange={(e) => set({ ipProtocol: e.target.value as FirewallRule["ipProtocol"] })}>
                  {IP_PROTOCOLS.map((d) => (
                    <option key={d} value={d}>
                      {IPV_LABEL[d]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {tab === "Source" && (
            <AddressField label="Source address" value={draft.source} onChange={(source) => set({ source })} ctx={ctx} errors={errs("source")} />
          )}

          {tab === "Destination" && (
            <AddressField label="Destination address" value={draft.destination} onChange={(destination) => set({ destination })} ctx={ctx} errors={errs("destination")} />
          )}

          {tab === "Service" && (
            <div className="form-grid">
              <div className="form-field">
                <label htmlFor="re-proto">Protocol</label>
                <select id="re-proto" value={draft.protocol} onChange={(e) => set({ protocol: e.target.value })}>
                  {protocols.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              {!portsAllowed && <p className="hint wide">Ports apply to TCP and UDP only.</p>}
              <PortField label="Destination port" value={draft.destinationPort} onChange={(destinationPort) => set({ destinationPort })} ctx={ctx} errors={errs("destinationPort")} disabled={!portsAllowed && draft.destinationPort.kind === "any"} />
              <PortField label="Source port" value={draft.sourcePort} onChange={(sourcePort) => set({ sourcePort })} ctx={ctx} errors={errs("sourcePort")} disabled={!portsAllowed && draft.sourcePort.kind === "any"} />
              <p className="hint wide">Source port is rarely needed; leave it at any unless you know you need it.</p>
            </div>
          )}

          {tab === "Actions" && (
            <div className="form-grid">
              <fieldset className="form-field radio-list wide">
                <legend>Action</legend>
                {RULE_ACTIONS.map((a) => (
                  <label key={a} className={`checkbox action-${a}`}>
                    <input type="radio" name="re-action" checked={draft.action === a} onChange={() => set({ action: a })} />
                    {ACTION_LABEL[a]}
                  </label>
                ))}
              </fieldset>
              <label className="checkbox">
                <input type="checkbox" checked={draft.log} onChange={(e) => set({ log: e.target.checked })} />
                Log packets that match this rule
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={draft.quick} onChange={(e) => set({ quick: e.target.checked })} />
                Quick (stop evaluating further rules on match)
              </label>
            </div>
          )}

          {tab === "Advanced" && (
            <div className="form-grid">
              <p className="hint wide">Fields RuleDeck doesn't model directly. They're kept as they are and only sent when you change them.</p>
              {Object.keys(draft.extra).sort().map((k) => (
                <div className="form-field" key={k}>
                  <label htmlFor={`re-x-${k}`}>{k}</label>
                  <input id={`re-x-${k}`} value={draft.extra[k] ?? ""} onChange={(e) => set({ extra: { ...draft.extra, [k]: e.target.value } })} spellCheck={false} />
                </div>
              ))}
              {Object.keys(draft.extra).length === 0 && <p className="muted wide">No advanced fields on this rule.</p>}
            </div>
          )}
        </fieldset>

        <footer className="form-actions">
          {triedSave && errorCount > 0 && (
            <span className="text-error" role="alert">
              Fix {errorCount} problem{errorCount === 1 ? "" : "s"} first.
            </span>
          )}
          <span className="hint">Staged locally. Ctrl+Enter = OK.</span>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          {!readOnly && (
            <button type="button" className="primary" onClick={save} disabled={!isNew && !changed}>
              OK
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
