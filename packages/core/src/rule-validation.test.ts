import { describe, expect, it } from "vitest";
import { validateWorkingState } from "./rule-validation.ts";
import { createWorkingCopy, deleteAlias, updateRule } from "./working-copy.ts";
import { parseAddress, parsePort, serializeAddress } from "./address.ts";
import { alias, rule, snapshot } from "./test-fixtures.ts";

describe("rule validation", () => {
  const wc = createWorkingCopy(
    snapshot([rule("r1", { protocol: "TCP" })], [alias("a1", "NETS"), alias("a2", "WEB_PORTS", { type: "port", entries: ["443"] })]),
  );

  it("passes a valid rule", () => {
    const next = updateRule(wc, "r1", {
      destination: { negate: false, items: [{ kind: "alias", name: "NETS" }] },
      destinationPort: { kind: "alias", name: "WEB_PORTS" },
    });
    expect(validateWorkingState(next.current, next.baseline.options, next.baseline).errorCount).toBe(0);
  });

  it("flags missing aliases, wrong alias types, bad literals and ports without TCP/UDP", () => {
    const next = updateRule(wc, "r1", {
      protocol: "ICMP",
      source: { negate: false, items: [{ kind: "alias", name: "WEB_PORTS" }, { kind: "literal", value: "10.0.0.300" }] },
      destination: { negate: false, items: [{ kind: "alias", name: "MISSING" }] },
      destinationPort: { kind: "literal", value: "443" },
    });
    const issues = validateWorkingState(next.current).rules["r1"]!;
    expect(issues["source"]).toHaveLength(2);
    expect(issues["destination"]![0]).toMatch(/does not exist/);
    expect(issues["destinationPort"]![0]).toMatch(/TCP and\/or UDP/);
  });

  it("flags IP version mismatches", () => {
    const next = updateRule(wc, "r1", { source: { negate: false, items: [{ kind: "literal", value: "2001:db8::/32" }] } });
    expect(validateWorkingState(next.current).rules["r1"]!["source"]![0]).toMatch(/IP version/);
  });

  it("reports rules left pointing at a deleted alias", () => {
    const withRef = updateRule(wc, "r1", { destination: { negate: false, items: [{ kind: "alias", name: "NETS" }] } });
    const next = deleteAlias(withRef, "a1", { acknowledgeReferences: true });
    expect(validateWorkingState(next.current, undefined, next.baseline).errorCount).toBe(1);
  });

  it("flags unknown interfaces when options are known", () => {
    const next = updateRule(wc, "r1", { interfaces: ["opt9"] });
    expect(validateWorkingState(next.current, next.baseline.options).rules["r1"]!["interfaces"]).toHaveLength(1);
  });
});

describe("address parsing", () => {
  const ctx = { interfaces: new Set(["lan", "wan"]), aliases: new Set(["NETS"]) };
  it("classifies tokens", () => {
    expect(parseAddress("any", false, ctx)).toEqual({ negate: false, items: [] });
    expect(parseAddress("(self),lan,lanip,NETS,10.0.0.0/8,FUTURE", true, ctx)).toEqual({
      negate: true,
      items: [
        { kind: "self" },
        { kind: "interfaceNet", iface: "lan" },
        { kind: "interfaceAddr", iface: "lan" },
        { kind: "alias", name: "NETS" },
        { kind: "literal", value: "10.0.0.0/8" },
        { kind: "alias", name: "FUTURE" },
      ],
    });
  });
  it("round-trips", () => {
    const raw = "(self),lan,lanip,NETS,10.0.0.0/8";
    expect(serializeAddress(parseAddress(raw, false, ctx))).toEqual({ net: raw, not: false });
    expect(serializeAddress({ negate: false, items: [] })).toEqual({ net: "any", not: false });
  });
  it("parses ports", () => {
    expect(parsePort("", new Set())).toEqual({ kind: "any" });
    expect(parsePort("443", new Set())).toEqual({ kind: "literal", value: "443" });
    expect(parsePort("WEB", new Set(["WEB"]))).toEqual({ kind: "alias", name: "WEB" });
  });
});
