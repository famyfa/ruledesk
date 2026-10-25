import { describe, expect, it } from "vitest";
import { addFilterTerm, compileFilter, LOG_FILTER_FIELDS, parseIpRange, RULE_FILTER_FIELDS, ALIAS_FILTER_FIELDS } from "./filter.ts";
import { aliasRecord, indexAliases, logRecord, ruleRecord } from "./filter-records.ts";
import { alias, rule } from "./test-fixtures.ts";
import type { FirewallLogEntry } from "./domain.ts";

const logEnv = { fields: LOG_FILTER_FIELDS };
const ruleEnv = { fields: RULE_FILTER_FIELDS, portNames: new Map([["https", 443]]) };

const entry = (p: Partial<FirewallLogEntry> = {}): FirewallLogEntry => ({
  digest: "d", time: "t", host: "h", action: "pass", dir: "in", interface: "vtnet0", ipVersion: "4", protocol: "tcp",
  src: "10.1.2.3", srcPort: "40000", dst: "192.168.1.10", dstPort: "443", length: "", tcpFlags: "", reason: "", ruleId: "r", ruleLabel: "Allow web", ...p,
});
const logTest = (expr: string, e = entry()) => {
  const f = compileFilter(expr, logEnv);
  expect(f.error).toBeNull();
  return f.test(logRecord(e, "Berlin"));
};

describe("ip ranges", () => {
  it("parses v4, v6, cidr and ranges", () => {
    expect(parseIpRange("10.0.0.0/8")).toMatchObject({ v: 4 });
    expect(parseIpRange("10.0.0.1-10.0.0.9")).toMatchObject({ v: 4 });
    expect(parseIpRange("fe80::1")).toMatchObject({ v: 6 });
    expect(parseIpRange("::ffff:10.0.0.1")).toMatchObject({ v: 6 });
    expect(parseIpRange("example.com")).toBeNull();
    expect(parseIpRange("10.0.0.300")).toBeNull();
    expect(parseIpRange("10.0.0.0/33")).toBeNull();
  });
});

describe("log filters", () => {
  it("matches by CIDR containment (not only exact source ips)", () => {
    expect(logTest("addr.src in 10.0.0.0/8")).toBe(true);
    expect(logTest("addr.src in 172.16.0.0/12")).toBe(false);
    expect(logTest("addr.dst in 192.168.1.0/24")).toBe(true);
    expect(logTest("addr in 192.168.1.0/24")).toBe(true); // either side
    expect(logTest("addr.src in 172.16.0.0/12,10.1.0.0/16")).toBe(true);
  });
  it("supports eq/neq/contains/notin and symbols", () => {
    expect(logTest("action eq pass")).toBe(true);
    expect(logTest("action neq pass")).toBe(false);
    expect(logTest("action != block")).toBe(true);
    expect(logTest("rule contains web")).toBe(true);
    expect(logTest("rule ~ web")).toBe(true);
    expect(logTest("addr.src notin 10.0.0.0/8")).toBe(false);
    expect(logTest("action=pass")).toBe(true);
  });
  it("compares ports numerically with ranges", () => {
    expect(logTest("port.dst in 400-500")).toBe(true);
    expect(logTest("port.dst eq 80")).toBe(false);
    expect(logTest("port eq 40000")).toBe(true);
  });
  it("combines with and/or/not and parentheses", () => {
    expect(logTest("( addr.src in 10.0.0.0/8 ) and ( action eq block )")).toBe(false);
    expect(logTest("( addr.src in 10.0.0.0/8 ) and not ( action eq block )")).toBe(true);
    expect(logTest("action eq block or port.dst eq 443")).toBe(true);
    expect(logTest("action eq block or ( port.dst eq 80 and dir eq in )")).toBe(false);
  });
  it("treats plain words as free text over all fields", () => {
    expect(logTest("192.168")).toBe(true);
    expect(logTest("vtnet0 web")).toBe(true);
    expect(logTest("nothing-here")).toBe(false);
  });
  it("filters by site name", () => {
    expect(logTest("site eq berlin")).toBe(true);
    expect(logTest("site eq munich")).toBe(false);
  });
  it("reports readable syntax errors and stays unfiltered", () => {
    expect(compileFilter("( action eq pass", logEnv).error?.message).toMatch(/parenthesis/);
    expect(compileFilter("bogus eq 1", logEnv).error?.message).toMatch(/Unknown field "bogus"/);
    expect(compileFilter("action eq", logEnv).error?.message).toMatch(/value/);
    expect(compileFilter('rule eq "open', logEnv).error?.message).toMatch(/quote/);
    expect(compileFilter("action eq pass )", logEnv).error).not.toBeNull();
    expect(compileFilter("( )", logEnv).error).not.toBeNull();
    expect(compileFilter("bogus eq 1", logEnv).test(logRecord(entry()))).toBe(true);
  });
  it("builds terms for click-to-filter", () => {
    expect(addFilterTerm("", "action", "eq", "block")).toBe("( action eq block )");
    expect(addFilterTerm("( dir eq in )", "rule", "eq", "Allow web")).toBe('( dir eq in ) and ( rule eq "Allow web" )');
    expect(compileFilter(addFilterTerm("", "rule", "eq", "Allow web"), logEnv).test(logRecord(entry()))).toBe(true);
  });
});

describe("rule filters", () => {
  const aliases = indexAliases([
    alias("a1", "WEB", { entries: ["10.1.0.0/16", "10.2.0.5"] }),
    alias("a2", "ALL_NETS", { entries: ["WEB", "172.16.0.0/12"] }),
    alias("p1", "WEBPORTS", { type: "port", entries: ["80", "8000-8100"] }),
  ]);
  const r = rule("r1", {
    description: "Allow web",
    source: { negate: false, items: [{ kind: "alias", name: "ALL_NETS" }] },
    destination: { negate: false, items: [{ kind: "literal", value: "192.168.5.0/24" }] },
    destinationPort: { kind: "alias", name: "WEBPORTS" },
    interfaces: ["lan"],
  });
  const t = (expr: string, x = r) => {
    const f = compileFilter(expr, ruleEnv);
    expect(f.error).toBeNull();
    return f.test(ruleRecord(x, aliases, "Berlin"));
  };
  it("looks through (nested) aliases", () => {
    expect(t("addr.src in 10.2.0.5")).toBe(true);
    expect(t("addr.src in 172.20.0.0/16")).toBe(true);
    expect(t("addr.src in 8.8.8.8")).toBe(false);
    expect(t("alias eq WEB")).toBe(false); // only aliases the rule names itself
    expect(t("alias eq ALL_NETS")).toBe(true);
    expect(t("addr.src eq WEB")).toBe(true); // nested names are searchable
  });
  it("matches ports inside port aliases and by name", () => {
    expect(t("port.dst eq 8050")).toBe(true);
    expect(t("port.dst eq 443")).toBe(false);
    expect(t("port.dst eq https")).toBe(false);
    expect(t("port.dst eq 80")).toBe(true);
  });
  it("an any-rule is found by address queries", () => {
    expect(t("addr.dst in 1.2.3.4", rule("r2"))).toBe(true);
  });
  it("matches simple fields", () => {
    expect(t("interface eq lan and enabled eq yes and log eq no")).toBe(true);
    expect(t("rule contains WEB")).toBe(true);
  });
});

describe("alias filters", () => {
  const list = [alias("a1", "WEB", { entries: ["10.1.0.0/16"] }), alias("a2", "ALL", { entries: ["WEB", "172.16.0.5"] })];
  const idx = indexAliases(list);
  it("finds aliases by contained address, through nesting", () => {
    const f = compileFilter("addr in 10.1.2.3", { fields: ALIAS_FILTER_FIELDS });
    expect(list.filter((a) => f.test(aliasRecord(a, idx))).map((a) => a.name)).toEqual(["WEB", "ALL"]);
    const g = compileFilter("addr eq 172.16.0.5", { fields: ALIAS_FILTER_FIELDS });
    expect(list.filter((a) => g.test(aliasRecord(a, idx))).map((a) => a.name)).toEqual(["ALL"]);
  });
});
