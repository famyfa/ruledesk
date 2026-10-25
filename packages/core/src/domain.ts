/**
 * Normalized domain model. These types describe RuleDeck's view of the firewall,
 * not the OPNsense wire format. See docs/field-mapping.md for the mapping.
 */

export type RuleAction = "pass" | "block" | "reject" | "match";
export type RuleDirection = "in" | "out" | "any";
export type IpProtocol = "inet" | "inet6" | "inet46";

export const RULE_ACTIONS: readonly RuleAction[] = ["pass", "block", "reject", "match"];
export const RULE_DIRECTIONS: readonly RuleDirection[] = ["in", "out", "any"];
export const IP_PROTOCOLS: readonly IpProtocol[] = ["inet", "inet6", "inet46"];

export type AddressItem =
  | { kind: "self" }
  | { kind: "interfaceNet"; iface: string }
  | { kind: "interfaceAddr"; iface: string }
  | { kind: "alias"; name: string }
  | { kind: "literal"; value: string };

/** `items: []` means "any". */
export interface AddressSpec {
  negate: boolean;
  items: AddressItem[];
}

export type PortSpec =
  | { kind: "any" }
  | { kind: "literal"; value: string }
  | { kind: "alias"; name: string };

export type RuleOrigin = "mvc" | "legacy";

export interface FirewallRule {
  /** OPNsense uuid, or a local id (`new:<n>`) for rules not yet created. */
  id: string;
  origin: RuleOrigin;
  enabled: boolean;
  action: RuleAction;
  quick: boolean;
  /** Empty = floating / any interface. */
  interfaces: string[];
  interfaceNot: boolean;
  direction: RuleDirection;
  ipProtocol: IpProtocol;
  protocol: string;
  source: AddressSpec;
  sourcePort: PortSpec;
  destination: AddressSpec;
  destinationPort: PortSpec;
  description: string;
  log: boolean;
  categories: string[];
  sequence: number;
  /** Volatile, read-only grouping key from OPNsense (floating/group/interface). */
  prioGroup?: string;
  /** Volatile, read-only sort key from OPNsense. */
  sortOrder?: string;
  /** Every other raw field, preserved verbatim so nothing is silently dropped. */
  extra: Record<string, string>;
}

export interface Alias {
  /** OPNsense uuid, or a local id (`new:<n>`) for aliases not yet created. */
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  entries: string[];
  description: string;
  categories: string[];
  extra: Record<string, string>;
}

export interface InterfaceInfo {
  key: string;
  label: string;
  kind: "interface" | "group" | "floating" | "any";
}

/** Option lists discovered from the firewall rather than hard-coded. */
export interface SelectionOptions {
  interfaces: InterfaceInfo[];
  aliasTypes: { value: string; label: string }[];
  protocols: string[];
  wellKnownPorts: { value: string; label: string }[];
}

export interface FirewallInfo {
  id: string;
  name: string;
  productVersion: string;
  features: FeatureFlags;
}

export interface FeatureFlags {
  rulesRead: boolean;
  rulesWrite: boolean;
  aliasesWrite: boolean;
  portSelectOptions: boolean;
  /** Human-readable reasons for any disabled feature. */
  notes: string[];
}

export interface FirewallSnapshot {
  firewallId: string;
  loadedAt: string;
  rules: FirewallRule[];
  aliases: Alias[];
  options: SelectionOptions;
  /** id -> fingerprint of the raw object at load time (for conflict detection). */
  fingerprints: Record<string, string>;
}

/** One line of the firewall log (pf filterlog), normalized. All values are display strings. */
export interface FirewallLogEntry {
  /** md5 of the raw log line; used to ask only for newer lines. */
  digest: string;
  time: string;
  host: string;
  action: string;
  dir: string;
  /** Device name as logged by pf (e.g. vtnet1), not the OPNsense interface key. */
  interface: string;
  ipVersion: string;
  protocol: string;
  src: string;
  srcPort: string;
  dst: string;
  dstPort: string;
  length: string;
  tcpFlags: string;
  reason: string;
  /** Identity of the rule that matched: the rule uuid, or a pf label for automatic rules. */
  ruleId: string;
  /** Description of that rule from the running ruleset. */
  ruleLabel: string;
}

export const ANY_ADDRESS: AddressSpec = { negate: false, items: [] };
export const ANY_PORT: PortSpec = { kind: "any" };

export function isLocalId(id: string): boolean {
  return id.startsWith("new:");
}
