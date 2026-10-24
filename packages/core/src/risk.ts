import type { AddressSpec, FirewallRule } from "./domain.ts";
import type { WorkingCopy } from "./working-copy.ts";
import { ruleLabel } from "./working-copy.ts";

/**
 * Heuristic lockout checks for the review screen. These can't prove safety;
 * they point at changes that commonly cut off management access.
 */

export interface RiskWarning {
  ruleId: string;
  label: string;
  message: string;
}

const MGMT_PORTS = new Set(["22", "80", "443", "ssh", "http", "https", "8443"]);

function targetsFirewall(spec: AddressSpec): boolean {
  if (spec.negate) return false;
  if (spec.items.length === 0) return true; // any includes the firewall
  return spec.items.some((i) => i.kind === "self" || i.kind === "interfaceAddr");
}

function coversManagement(r: FirewallRule): boolean {
  if (!targetsFirewall(r.destination)) return false;
  const p = r.destinationPort;
  if (p.kind === "any") return true;
  if (p.kind === "literal") {
    if (MGMT_PORTS.has(p.value.toLowerCase())) return true;
    const m = /^(\d+)[-:](\d+)$/.exec(p.value);
    if (m) return [22, 80, 443, 8443].some((x) => x >= Number(m[1]) && x <= Number(m[2]));
    return false;
  }
  return true; // port alias: can't tell, assume it might
}

/** A rule that lets traffic reach the firewall's management services. */
function allowsManagement(r: FirewallRule): boolean {
  return r.origin === "mvc" && r.enabled && r.action === "pass" && coversManagement(r);
}

/** A rule that could stop traffic to management services. */
function blocksManagement(r: FirewallRule): boolean {
  return r.enabled && (r.action === "block" || r.action === "reject") && coversManagement(r);
}

export function lockoutWarnings(wc: WorkingCopy): RiskWarning[] {
  const out: RiskWarning[] = [];
  const base = new Map(wc.baseline.rules.map((r) => [r.id, r]));
  const cur = new Map(wc.current.rules.map((r) => [r.id, r]));

  for (const [id, b] of base) {
    const c = cur.get(id);
    if (!allowsManagement(b)) continue;
    if (!c) {
      out.push({ ruleId: id, label: ruleLabel(b), message: "Deletes a rule that allows access to the firewall itself. You could lose access to the web UI or SSH." });
    } else if (!allowsManagement(c) || JSON.stringify(c.source) !== JSON.stringify(b.source) || JSON.stringify(c.interfaces) !== JSON.stringify(b.interfaces)) {
      out.push({ ruleId: id, label: ruleLabel(c), message: "Changes a rule that allows access to the firewall itself. Check that your own address still matches." });
    }
  }
  for (const [id, c] of cur) {
    const b = base.get(id);
    if (!blocksManagement(c)) continue;
    if (!b || !blocksManagement(b) || JSON.stringify(b) !== JSON.stringify(c)) {
      out.push({
        ruleId: id,
        label: ruleLabel(c),
        message: `${c.action === "block" ? "Blocks" : "Rejects"} traffic that may include access to the firewall itself${c.interfaces.length === 0 ? " on all interfaces" : ""}. Rules are evaluated top to bottom; make sure an allow rule for your management access comes first.`,
      });
    }
  }
  // Reordering: a block rule moved above an allow rule.
  const idx = (list: FirewallRule[], id: string) => list.findIndex((r) => r.id === id);
  for (const c of wc.current.rules) {
    if (!blocksManagement(c) || !base.has(c.id)) continue;
    for (const a of wc.current.rules) {
      if (!allowsManagement(a) || !base.has(a.id) || a.prioGroup !== c.prioGroup) continue;
      const wasAfter = idx(wc.baseline.rules, c.id) > idx(wc.baseline.rules, a.id);
      const nowBefore = idx(wc.current.rules, c.id) < idx(wc.current.rules, a.id);
      if (wasAfter && nowBefore && !out.some((w) => w.ruleId === c.id)) {
        out.push({ ruleId: c.id, label: ruleLabel(c), message: `Now comes before "${ruleLabel(a)}", which allows management access.` });
      }
    }
  }
  return out;
}
