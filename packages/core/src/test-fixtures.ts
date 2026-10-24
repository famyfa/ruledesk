import type { Alias, FirewallRule, FirewallSnapshot } from "./domain.ts";
import { newRuleTemplate } from "./working-copy.ts";

export function rule(id: string, patch: Partial<FirewallRule> = {}): FirewallRule {
  return { ...newRuleTemplate(id, "400000"), interfaces: ["lan"], ...patch };
}

export function alias(id: string, name: string, patch: Partial<Alias> = {}): Alias {
  return { id, name, type: "network", enabled: true, entries: ["10.0.0.0/8"], description: "", categories: [], extra: {}, ...patch };
}

export function snapshot(rules: FirewallRule[], aliases: Alias[] = []): FirewallSnapshot {
  return {
    firewallId: "fw1",
    loadedAt: "2026-10-24T00:00:00Z",
    rules,
    aliases,
    options: {
      interfaces: [
        { key: "lan", label: "LAN", kind: "interface" },
        { key: "wan", label: "WAN", kind: "interface" },
      ],
      aliasTypes: [
        { value: "host", label: "Host(s)" },
        { value: "network", label: "Network(s)" },
        { value: "port", label: "Port(s)" },
      ],
      protocols: ["any", "TCP", "UDP", "TCP/UDP", "ICMP"],
      wellKnownPorts: [{ value: "https", label: "HTTPS (443)" }],
    },
    fingerprints: {},
  };
}
