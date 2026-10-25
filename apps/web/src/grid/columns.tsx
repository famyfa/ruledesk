import type { ReactNode } from "react";
import {
  formatAddress,
  formatPort,
  IP_PROTOCOLS,
  RULE_ACTIONS,
  RULE_DIRECTIONS,
  type AddressSpec,
  type FirewallRule,
  type PortSpec,
  type RulePatch,
} from "@ruledeck/core";
import { aliasPreview, itemLabel, resolveAddressToken, resolvePortToken, type ObjectContext } from "./objects.ts";
import { BADGE } from "../forms/pickerParts.tsx";

export type EditorKind = "bool" | "select" | "text" | "address" | "port" | "interfaces" | "none";

export interface Column {
  key: string;
  label: string;
  width: number;
  editor: EditorKind;
  sticky?: boolean;
  /** Field key used for change/validation highlighting (RULE_FIELDS keys). */
  field?: string;
  selectOptions?: (ctx: ObjectContext, rule: FirewallRule) => { value: string; label: string }[];
  render: (rule: FirewallRule, ctx: ObjectContext) => ReactNode;
  /** Plain-text value for copy. */
  copy: (rule: FirewallRule, ctx: ObjectContext) => string;
  /** Parse pasted text into a patch; returns an error string when it can't. */
  paste?: (text: string, ctx: ObjectContext, rule: FirewallRule) => RulePatch | string;
  /** Read the editor value from the rule and build a patch from the edited value. */
  get?: (rule: FirewallRule) => unknown;
  set?: (value: unknown) => RulePatch;
}

const ACTION_LABEL: Record<string, string> = { pass: "Pass", block: "Block", reject: "Reject", match: "Match" };
const DIR_LABEL: Record<string, string> = { in: "In", out: "Out", any: "Any" };
const IPV_LABEL: Record<string, string> = { inet: "IPv4", inet6: "IPv6", inet46: "IPv4+6" };

const parseBool = (t: string): boolean | null => {
  const v = t.trim().toLowerCase();
  if (["1", "yes", "true", "on", "enabled", "x", "✓"].includes(v)) return true;
  if (["0", "no", "false", "off", "disabled", ""].includes(v)) return false;
  return null;
};

function enumPaste<T extends string>(values: readonly T[], labels: Record<string, string>, field: keyof FirewallRule) {
  return (text: string): RulePatch | string => {
    const v = text.trim().toLowerCase();
    const hit = values.find((x) => x === v || labels[x]?.toLowerCase() === v);
    return hit ? ({ [field]: hit } as RulePatch) : `"${text.trim()}" is not one of ${values.join(", ")}.`;
  };
}

function AddressCell({ spec, ctx }: { spec: AddressSpec; ctx: ObjectContext }) {
  if (spec.items.length === 0) return <span className={`addr${spec.negate ? " negated" : ""}`}>{spec.negate ? "NOT any" : <span className="muted">any</span>}</span>;
  return (
    <span className={`addr${spec.negate ? " negated" : ""}`}>
      {spec.negate && <span className="not-tag">NOT</span>}
      {spec.items.map((i, idx) => {
        const alias = i.kind === "alias" ? ctx.aliases.find((a) => a.name === i.name) : undefined;
        const title = i.kind === "alias" ? (alias ? `${alias.name}: ${aliasPreview(alias, 10)}` : `Alias ${i.name} not found`) : itemLabel(i, ctx);
        return (
          <span key={idx} className={`chip chip-${i.kind}${i.kind === "alias" && !alias ? " chip-missing" : ""}`} title={title}>
            <span className={`obj-badge obj-${i.kind}`} aria-hidden>
              {BADGE[i.kind]}
            </span>
            {itemLabel(i, ctx)}
          </span>
        );
      })}
    </span>
  );
}

function PortCell({ port, ctx }: { port: PortSpec; ctx: ObjectContext }) {
  if (port.kind === "any") return <span className="muted">any</span>;
  if (port.kind === "alias") {
    const alias = ctx.aliases.find((a) => a.name === port.name);
    return (
      <span className={`chip chip-alias${alias ? "" : " chip-missing"}`} title={alias ? aliasPreview(alias, 10) : "Alias not found"}>
        <span className="obj-badge obj-alias" aria-hidden>
          A
        </span>
        {port.name}
      </span>
    );
  }
  return <span>{port.value}</span>;
}

function parseAddressText(text: string, ctx: ObjectContext): AddressSpec | string {
  let t = text.trim();
  let negate = false;
  if (t.startsWith("!") || /^not\s/i.test(t)) {
    negate = true;
    t = t.replace(/^!|^not\s+/i, "");
  }
  const items = [];
  for (const tok of t.split(/[\s,;]+/).filter(Boolean)) {
    const r = resolveAddressToken(tok, ctx);
    if (!r) return `"${tok}" is not a known address, interface or alias.`;
    if (r !== "any") items.push(r);
  }
  return { negate, items };
}

export const COLUMNS: Column[] = [
  {
    key: "description",
    label: "Name",
    width: 260,
    sticky: true,
    editor: "text",
    field: "description",
    render: (r) => r.description || <span className="muted">—</span>,
    copy: (r) => r.description,
    paste: (t) => ({ description: t.replace(/[\r\n]+/g, " ").trim() }),
    get: (r) => r.description,
    set: (v) => ({ description: String(v) }),
  },
  {
    key: "enabled",
    label: "On",
    width: 44,
    editor: "bool",
    sticky: true,
    field: "enabled",
    render: (r) => (
      <span className={`bool ${r.enabled ? "on" : "off"}`} aria-label={r.enabled ? "Enabled" : "Disabled"}>
        {r.enabled ? "✓" : "–"}
      </span>
    ),
    copy: (r) => (r.enabled ? "yes" : "no"),
    paste: (t) => {
      const b = parseBool(t);
      return b === null ? `"${t}" is not yes/no.` : { enabled: b };
    },
    get: (r) => r.enabled,
    set: (v) => ({ enabled: Boolean(v) }),
  },
  {
    key: "action",
    label: "Action",
    width: 78,
    editor: "select",
    sticky: true,
    field: "action",
    selectOptions: () => RULE_ACTIONS.map((a) => ({ value: a, label: ACTION_LABEL[a]! })),
    render: (r) => <span className={`action action-${r.action}`}>{ACTION_LABEL[r.action] ?? r.action}</span>,
    copy: (r) => r.action,
    paste: enumPaste(RULE_ACTIONS, ACTION_LABEL, "action"),
    get: (r) => r.action,
    set: (v) => ({ action: v as FirewallRule["action"] }),
  },
  {
    key: "interfaces",
    label: "Interface",
    width: 120,
    editor: "interfaces",
    field: "interfaces",
    render: (r, ctx) =>
      r.interfaces.length === 0 ? (
        <span className="muted">{r.interfaceNot ? "NOT any" : "any (floating)"}</span>
      ) : (
        <span>
          {r.interfaceNot && <span className="not-tag">NOT</span>}
          {r.interfaces.map((k) => ctx.options.interfaces.find((i) => i.key === k)?.label ?? k).join(", ")}
        </span>
      ),
    copy: (r) => r.interfaces.join(","),
    paste: (t, ctx) => {
      const keys: string[] = [];
      for (const tok of t.split(/[\s,;]+/).filter(Boolean)) {
        const hit = ctx.options.interfaces.find((i) => i.key.toLowerCase() === tok.toLowerCase() || i.label.toLowerCase() === tok.toLowerCase());
        if (!hit) return `Unknown interface "${tok}".`;
        keys.push(hit.key);
      }
      return { interfaces: keys };
    },
    get: (r) => r.interfaces,
    set: (v) => ({ interfaces: v as string[] }),
  },
  {
    key: "direction",
    label: "Dir",
    width: 54,
    editor: "select",
    field: "direction",
    selectOptions: () => RULE_DIRECTIONS.map((d) => ({ value: d, label: DIR_LABEL[d]! })),
    render: (r) => DIR_LABEL[r.direction] ?? r.direction,
    copy: (r) => r.direction,
    paste: enumPaste(RULE_DIRECTIONS, DIR_LABEL, "direction"),
    get: (r) => r.direction,
    set: (v) => ({ direction: v as FirewallRule["direction"] }),
  },
  {
    key: "ipProtocol",
    label: "IP",
    width: 62,
    editor: "select",
    field: "ipProtocol",
    selectOptions: () => IP_PROTOCOLS.map((d) => ({ value: d, label: IPV_LABEL[d]! })),
    render: (r) => IPV_LABEL[r.ipProtocol] ?? r.ipProtocol,
    copy: (r) => IPV_LABEL[r.ipProtocol] ?? r.ipProtocol,
    paste: enumPaste(IP_PROTOCOLS, IPV_LABEL, "ipProtocol"),
    get: (r) => r.ipProtocol,
    set: (v) => ({ ipProtocol: v as FirewallRule["ipProtocol"] }),
  },
  {
    key: "protocol",
    label: "Proto",
    width: 78,
    editor: "select",
    field: "protocol",
    selectOptions: (ctx) => ctx.options.protocols.map((p) => ({ value: p, label: p })),
    render: (r) => (r.protocol === "any" ? <span className="muted">any</span> : r.protocol),
    copy: (r) => r.protocol,
    paste: (t, ctx) => {
      const hit = ctx.options.protocols.find((p) => p.toLowerCase() === t.trim().toLowerCase());
      return hit ? { protocol: hit } : `Unknown protocol "${t.trim()}".`;
    },
    get: (r) => r.protocol,
    set: (v) => ({ protocol: String(v) }),
  },
  {
    key: "source",
    label: "Source",
    width: 190,
    editor: "address",
    field: "source",
    render: (r, ctx) => <AddressCell spec={r.source} ctx={ctx} />,
    copy: (r) => formatAddress(r.source),
    paste: (t, ctx) => {
      const p = parseAddressText(t, ctx);
      return typeof p === "string" ? p : { source: p };
    },
    get: (r) => r.source,
    set: (v) => ({ source: v as AddressSpec }),
  },
  {
    key: "sourcePort",
    label: "Src port",
    width: 90,
    editor: "port",
    field: "sourcePort",
    render: (r, ctx) => <PortCell port={r.sourcePort} ctx={ctx} />,
    copy: (r) => formatPort(r.sourcePort),
    paste: (t, ctx) => {
      const p = resolvePortToken(t, ctx);
      return p ? { sourcePort: p } : `"${t.trim()}" is not a port, range or port alias.`;
    },
    get: (r) => r.sourcePort,
    set: (v) => ({ sourcePort: v as PortSpec }),
  },
  {
    key: "destination",
    label: "Destination",
    width: 190,
    editor: "address",
    field: "destination",
    render: (r, ctx) => <AddressCell spec={r.destination} ctx={ctx} />,
    copy: (r) => formatAddress(r.destination),
    paste: (t, ctx) => {
      const p = parseAddressText(t, ctx);
      return typeof p === "string" ? p : { destination: p };
    },
    get: (r) => r.destination,
    set: (v) => ({ destination: v as AddressSpec }),
  },
  {
    key: "destinationPort",
    label: "Dst port",
    width: 100,
    editor: "port",
    field: "destinationPort",
    render: (r, ctx) => <PortCell port={r.destinationPort} ctx={ctx} />,
    copy: (r) => formatPort(r.destinationPort),
    paste: (t, ctx) => {
      const p = resolvePortToken(t, ctx);
      return p ? { destinationPort: p } : `"${t.trim()}" is not a port, range or port alias.`;
    },
    get: (r) => r.destinationPort,
    set: (v) => ({ destinationPort: v as PortSpec }),
  },
  {
    key: "log",
    label: "Log",
    width: 44,
    editor: "bool",
    field: "log",
    render: (r) => (
      <span className={`bool ${r.log ? "on" : "off"}`} aria-label={r.log ? "Logging on" : "Logging off"}>
        {r.log ? "✓" : "–"}
      </span>
    ),
    copy: (r) => (r.log ? "yes" : "no"),
    paste: (t) => {
      const b = parseBool(t);
      return b === null ? `"${t}" is not yes/no.` : { log: b };
    },
    get: (r) => r.log,
    set: (v) => ({ log: Boolean(v) }),
  },
];
