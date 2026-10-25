import { describe, expect, it } from "vitest";
import { aliasFromRecord, aliasToRecord, fingerprint, flattenRecord, ruleChangedFields, ruleFromRecord, ruleToRecord, RULE_VOLATILE, uniqueRuleIds } from "./adapter.ts";
import { featuresFor, parseVersion } from "./version.ts";
import { apiPath, validateBaseUrl } from "./http.ts";
import { mapResponseError } from "./errors.ts";

const ctx = { interfaces: new Set(["lan", "wan", "opt1"]), aliases: new Set(["RFC1918", "WEB_PORTS"]) };

const raw = {
  uuid: "u1",
  enabled: "1",
  action: "pass",
  quick: "1",
  interface: "lan",
  interfacenot: "0",
  direction: "in",
  ipprotocol: "inet",
  protocol: "TCP",
  source_net: "RFC1918,lanip",
  source_not: "1",
  source_port: "",
  destination_net: "any",
  destination_not: "0",
  destination_port: "WEB_PORTS",
  description: "web",
  log: "0",
  categories: "",
  sequence: "100",
  sort_order: "400000.0000100",
  prio_group: "400000",
  statetype: "keep",
  "max-src-nodes": "10",
  "received-on": "",
  "%action": "Pass",
  alias_meta_source_net: [],
};

describe("flattenRecord", () => {
  it("joins selected option keys and drops decorations", () => {
    const flat = flattenRecord({
      action: { pass: { value: "Pass", selected: 1 }, block: { value: "Block", selected: 0 } },
      interface: { lan: { value: "LAN", selected: 1 }, wan: { value: "WAN", selected: 1 } },
      "%action": "Pass",
      category_colors: [],
      enabled: true,
      sequence: 10,
    });
    expect(flat).toEqual({ action: "pass", interface: "lan,wan", enabled: "1", sequence: "10" });
  });
  it("uses newlines for alias content", () => {
    const flat = flattenRecord({ content: { "10.0.0.1": { value: "10.0.0.1", selected: 1 }, OTHER: { value: "OTHER", selected: 0 }, "10.0.0.2": { value: "10.0.0.2", selected: 1 } } }, { content: "\n" });
    expect(flat.content).toBe("10.0.0.1\n10.0.0.2");
  });
});

describe("rule mapping", () => {
  const flat = flattenRecord(raw);
  const rule = ruleFromRecord(flat, ctx);

  it("normalizes known fields", () => {
    expect(rule).toMatchObject({
      id: "u1",
      origin: "mvc",
      interfaces: ["lan"],
      protocol: "TCP",
      source: { negate: true, items: [{ kind: "alias", name: "RFC1918" }, { kind: "interfaceAddr", iface: "lan" }] },
      destination: { negate: false, items: [] },
      destinationPort: { kind: "alias", name: "WEB_PORTS" },
      sequence: 100,
      prioGroup: "400000",
    });
  });

  it("keeps unknown fields in extra and drops decorations", () => {
    expect(rule.extra).toEqual({ statetype: "keep", "max-src-nodes": "10", "received-on": "" });
  });

  it("round-trips without losing fields", () => {
    const back = ruleToRecord(rule);
    for (const [k, v] of Object.entries(flat)) {
      if (RULE_VOLATILE.has(k)) continue;
      expect(back[k], k).toBe(v);
    }
  });

  it("sends only changed fields for an update", () => {
    const after = { ...rule, action: "block" as const, destination: { negate: false, items: [{ kind: "literal" as const, value: "10.0.0.1" }] } };
    expect(ruleChangedFields(rule, after)).toEqual({ action: "block", destination_net: "10.0.0.1" });
  });

  it("marks rows without uuid as read-only legacy rules", () => {
    const legacy = ruleFromRecord({ legacy: "1", description: "Anti-Lockout Rule", ref: "anti-lockout", interface: "lan" }, ctx);
    expect(legacy.origin).toBe("legacy");
    expect(legacy.id).toBe("legacy:anti-lockout");
  });
});

describe("alias mapping", () => {
  it("round-trips", () => {
    const rec = { uuid: "a1", name: "WEB", type: "host", enabled: "1", content: "10.0.0.1\n10.0.0.2", description: "d", categories: "", proto: "", current_items: "2" };
    const alias = aliasFromRecord(rec);
    expect(alias.entries).toEqual(["10.0.0.1", "10.0.0.2"]);
    expect(alias.extra).toEqual({ proto: "" });
    expect(aliasToRecord(alias)).toEqual({ proto: "", name: "WEB", type: "host", enabled: "1", content: "10.0.0.1\n10.0.0.2", description: "d", categories: "" });
  });
});

describe("fingerprint", () => {
  it("ignores volatile fields and key order", () => {
    const a = fingerprint({ action: "pass", sort_order: "1", description: "x" }, RULE_VOLATILE);
    const b = fingerprint({ description: "x", action: "pass", sort_order: "2" }, RULE_VOLATILE);
    const c = fingerprint({ description: "y", action: "pass" }, RULE_VOLATILE);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("versions", () => {
  it("parses", () => {
    expect(parseVersion("26.1.11_2")).toMatchObject({ major: 26, minor: 1, patch: 11 });
    expect(parseVersion("garbage")).toBeNull();
  });
  it("enables writes only on verified series", () => {
    expect(featuresFor("26.7.7")).toMatchObject({ rulesWrite: true, portSelectOptions: true });
    expect(featuresFor("26.1.3")).toMatchObject({ rulesWrite: true });
    expect(featuresFor("25.7.1")).toMatchObject({ rulesWrite: false, portSelectOptions: false });
    expect(featuresFor("27.1")).toMatchObject({ rulesWrite: false });
    expect(featuresFor("27.1").notes[0]).toMatch(/not been verified/);
    expect(featuresFor(null)).toMatchObject({ rulesWrite: false });
    expect(featuresFor(null).notes[0]).toMatch(/System: Firmware/);
  });
});

describe("connection safety", () => {
  it("requires https except for loopback", () => {
    expect(() => validateBaseUrl("http://fw.lan")).toThrow(/https/);
    expect(validateBaseUrl("http://127.0.0.1:8443").port).toBe("8443");
    expect(validateBaseUrl("https://fw.lan").hostname).toBe("fw.lan");
  });
  it("rejects credentials, paths and queries in the URL", () => {
    expect(() => validateBaseUrl("https://u:p@fw.lan")).toThrow(/credentials/);
    expect(() => validateBaseUrl("https://fw.lan/api")).toThrow(/path/);
    expect(() => validateBaseUrl("https://fw.lan/?x=1")).toThrow(/query/);
  });
  it("refuses unsafe path parameters", () => {
    expect(apiPath("firewall/filter/get_rule", "0c6f0f84-1b2a")).toBe("/api/firewall/filter/get_rule/0c6f0f84-1b2a");
    expect(() => apiPath("firewall/filter/get_rule", "../../core")).toThrow(/unsafe/);
    expect(() => apiPath("firewall/filter/get_rule", "a/b")).toThrow(/unsafe/);
  });
});

describe("error mapping", () => {
  it("maps statuses and bodies", () => {
    expect(mapResponseError(200, { result: "saved" }, "x")).toBeNull();
    expect(mapResponseError(401, {}, "x")?.kind).toBe("auth");
    expect(mapResponseError(403, {}, "x")?.kind).toBe("forbidden");
    expect(mapResponseError(404, {}, "x")?.kind).toBe("unsupported");
    expect(mapResponseError(500, {}, "x")?.kind).toBe("server");
    expect(mapResponseError(200, { errorMessage: "Alias in use" }, "x")?.kind).toBe("rejected");
    const v = mapResponseError(200, { result: "failed", validations: { "rule.action": "bad" } }, "x");
    expect(v?.kind).toBe("validation");
    expect(v?.details.validations).toEqual({ "rule.action": "bad" });
  });
});

describe("ids of read-only rules", () => {
  const ctx2 = { interfaces: new Set(["lan"]), aliases: new Set<string>() };
  it("are unique even when the firewall gives several rules the same label or reference", () => {
    const rows = ["443", "80", "22"].map((port, i) => ruleFromRecord({ legacy: "1", ref: "system/anti-lockout", description: "anti-lockout rule", destination_port: port, interface: "lan" }, ctx2, i));
    expect(new Set(rows.map((r) => r.id)).size).toBe(1); // the raw ids collide ...
    const fixed = uniqueRuleIds(rows);
    expect(new Set(fixed.map((r) => r.id)).size).toBe(3); // ... and are made unique here
    expect(fixed.map((r) => r.id)).toEqual(["legacy:system/anti-lockout", "legacy:system/anti-lockout#2", "legacy:system/anti-lockout#3"]);
    expect(fixed.every((r) => r.origin === "legacy")).toBe(true);
  });
  it("prefer the pf label over the shared reference", () => {
    const r = ruleFromRecord({ legacy: "1", uuid: "abc123", ref: "system/x", description: "d" }, ctx2, 0);
    expect(r.id).toBe("legacy:abc123");
  });
});
