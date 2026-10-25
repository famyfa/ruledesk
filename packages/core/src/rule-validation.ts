import type { Alias, FirewallRule, SelectionOptions } from "./domain.ts";
import { IP_PROTOCOLS, RULE_ACTIONS, RULE_DIRECTIONS } from "./domain.ts";
import { isAddressLiteral, isIPv4, isIPv6, isPortLiteral, validateAliasEntries, validateAliasName } from "./validation.ts";
import type { WorkingState } from "./working-copy.ts";

/** field key -> messages. Field keys match RULE_FIELDS keys in diff.ts. */
export type FieldIssues = Record<string, string[]>;

export interface ValidationReport {
  rules: Record<string, FieldIssues>;
  aliases: Record<string, FieldIssues>;
  errorCount: number;
}

const PORT_PROTOCOLS = new Set(["tcp", "udp", "tcp/udp"]);

function push(issues: FieldIssues, field: string, msg: string) {
  (issues[field] ??= []).push(msg);
}

function literalFamily(value: string): "inet" | "inet6" | null {
  const addr = value.split("/")[0]!.split("-")[0]!;
  if (isIPv4(addr)) return "inet";
  if (isIPv6(addr)) return "inet6";
  return null;
}

export function validateRule(
  rule: FirewallRule,
  aliasesByName: ReadonlyMap<string, Alias>,
  options?: SelectionOptions,
): FieldIssues {
  const issues: FieldIssues = {};
  if (rule.origin !== "mvc") return issues;

  if (!RULE_ACTIONS.includes(rule.action)) push(issues, "action", `Unknown action "${rule.action}".`);
  if (!RULE_DIRECTIONS.includes(rule.direction)) push(issues, "direction", `Unknown direction "${rule.direction}".`);
  if (!IP_PROTOCOLS.includes(rule.ipProtocol)) push(issues, "ipProtocol", `Unknown IP version "${rule.ipProtocol}".`);
  if (!rule.protocol) push(issues, "protocol", "Protocol is required.");

  if (options) {
    const known = new Set(options.interfaces.map((i) => i.key));
    for (const i of rule.interfaces) if (!known.has(i)) push(issues, "interfaces", `Unknown interface "${i}".`);
  }

  for (const field of ["source", "destination"] as const) {
    for (const item of rule[field].items) {
      if (item.kind === "alias") {
        const alias = aliasesByName.get(item.name);
        if (!alias) push(issues, field, `Alias "${item.name}" does not exist.`);
        else if (alias.type === "port") push(issues, field, `"${item.name}" is a port alias and can't be used as an address.`);
      } else if (item.kind === "literal") {
        if (!isAddressLiteral(item.value)) push(issues, field, `"${item.value}" is not a valid address, network or range.`);
        const fam = literalFamily(item.value);
        if (fam && rule.ipProtocol !== "inet46" && fam !== rule.ipProtocol) {
          push(issues, field, `"${item.value}" doesn't match the rule's IP version.`);
        }
      }
    }
  }

  for (const field of ["sourcePort", "destinationPort"] as const) {
    const port = rule[field];
    if (port.kind === "any") continue;
    if (!PORT_PROTOCOLS.has(rule.protocol.toLowerCase())) {
      push(issues, field, "Ports can only be set for TCP and/or UDP rules.");
    }
    if (port.kind === "alias") {
      const alias = aliasesByName.get(port.name);
      if (!alias) push(issues, field, `Alias "${port.name}" does not exist.`);
      else if (alias.type !== "port") push(issues, field, `"${port.name}" is not a port alias.`);
    } else if (!isPortLiteral(port.value)) {
      push(issues, field, `"${port.value}" is not a valid port or range.`);
    }
  }
  return issues;
}

export function validateAlias(alias: Alias, state: WorkingState): FieldIssues {
  const issues: FieldIssues = {};
  const otherNames = state.aliases.filter((a) => a.id !== alias.id).map((a) => a.name);
  for (const m of validateAliasName(alias.name, otherNames)) push(issues, "name", m);
  if (!alias.type) push(issues, "type", "Type is required.");
  const names = new Set(state.aliases.map((a) => a.name));
  for (const m of validateAliasEntries(alias.type, alias.entries, names)) push(issues, "entries", m);
  if (alias.entries.includes(alias.name)) push(issues, "entries", "An alias can't contain itself.");
  return issues;
}

/**
 * Validate the working state. Objects that are untouched since load (same object
 * as in `baseline`) are skipped for alias content checks, since OPNsense already
 * accepted them and our local checks are stricter than needed for some types.
 * Rules are always checked for references, so deleting an alias in use shows up.
 */
export function validateWorkingState(
  state: WorkingState,
  options?: SelectionOptions,
  baseline?: { aliases: Alias[]; rules: FirewallRule[] },
): ValidationReport {
  const byName = new Map(state.aliases.map((a) => [a.name, a]));
  // "Untouched" = equal to the baseline object with the same id. Compared by content, not identity,
  // because the server receives the working copy as JSON.
  const baseAliases = new Map((baseline?.aliases ?? []).map((a) => [a.id, JSON.stringify(a)]));
  const baseRules = new Map((baseline?.rules ?? []).map((r) => [r.id, JSON.stringify(r)]));
  const isUntouchedRule = (r: FirewallRule) => baseRules.get(r.id) === JSON.stringify(r);
  const isUntouchedAlias = (a: Alias) => baseAliases.get(a.id) === JSON.stringify(a);
  const report: ValidationReport = { rules: {}, aliases: {}, errorCount: 0 };
  for (const r of state.rules) {
    let issues = validateRule(r, byName, options);
    if (isUntouchedRule(r)) {
      // Only surface broken alias references on rules the user didn't touch.
      issues = Object.fromEntries(
        Object.entries(issues)
          .map(([k, msgs]) => [k, msgs.filter((m) => m.endsWith("does not exist."))] as const)
          .filter(([, msgs]) => msgs.length > 0),
      );
    }
    if (Object.keys(issues).length) {
      report.rules[r.id] = issues;
      report.errorCount += Object.values(issues).flat().length;
    }
  }
  for (const a of state.aliases) {
    if (isUntouchedAlias(a)) continue;
    const issues = validateAlias(a, state);
    if (Object.keys(issues).length) {
      report.aliases[a.id] = issues;
      report.errorCount += Object.values(issues).flat().length;
    }
  }
  return report;
}
