import { describe, expect, it } from "vitest";
import {
  checkAliasEntries,
  isCidr,
  isIPv4,
  isIPv6,
  isIpRange,
  isPortLiteral,
  parseEntryList,
  validateAliasEntries,
  validateAliasName,
} from "./validation.ts";

describe("IPv4", () => {
  it.each(["0.0.0.0", "192.168.1.10", "255.255.255.255", "10.0.0.1"])("accepts %s", (v) => {
    expect(isIPv4(v)).toBe(true);
  });
  it.each(["256.1.1.1", "1.2.3", "1.2.3.4.5", "01.2.3.4", "a.b.c.d", "", "1.2.3.4 "])("rejects %s", (v) => {
    expect(isIPv4(v)).toBe(false);
  });
});

describe("IPv6", () => {
  it.each(["::", "::1", "fe80::1", "2001:db8::", "2001:0db8:0000:0000:0000:ff00:0042:8329", "::ffff:192.168.1.1", "2001:db8:1:2:3:4:5::"])(
    "accepts %s",
    (v) => expect(isIPv6(v)).toBe(true),
  );
  it.each(["", ":::", "1::2::3", "12345::", "2001:db8:1:2:3:4:5:6:7", "g::1", "::ffff:999.1.1.1", "1:2:3:4:5:6:7"])(
    "rejects %s",
    (v) => expect(isIPv6(v)).toBe(false),
  );
});

describe("CIDR and ranges", () => {
  it("accepts valid CIDRs", () => {
    expect(isCidr("10.0.0.0/8")).toBe(true);
    expect(isCidr("0.0.0.0/0")).toBe(true);
    expect(isCidr("2001:db8::/32")).toBe(true);
    expect(isCidr("2001:db8::/128")).toBe(true);
  });
  it("rejects invalid CIDRs", () => {
    expect(isCidr("10.0.0.0/33")).toBe(false);
    expect(isCidr("2001:db8::/129")).toBe(false);
    expect(isCidr("10.0.0.0/")).toBe(false);
    expect(isCidr("10.0.0.0")).toBe(false);
    expect(isCidr("host/24")).toBe(false);
  });
  it("checks ranges", () => {
    expect(isIpRange("10.0.0.1-10.0.0.9")).toBe(true);
    expect(isIpRange("10.0.0.1-::1")).toBe(false);
    expect(isIpRange("10.0.0.1")).toBe(false);
  });
});

describe("ports", () => {
  it.each(["1", "443", "65535", "80-90", "80:90", "https"])("accepts %s", (v) => expect(isPortLiteral(v)).toBe(true));
  it.each(["0", "65536", "90-80", "1-2-3", "", "a b"])("rejects %s", (v) => expect(isPortLiteral(v)).toBe(false));
  it("uses a well-known list when given", () => {
    const wk = new Set(["https"]);
    expect(isPortLiteral("https", wk)).toBe(true);
    expect(isPortLiteral("nonsense", wk)).toBe(false);
  });
});

describe("alias names", () => {
  it("accepts valid names", () => {
    expect(validateAliasName("WEB_SERVERS")).toEqual([]);
    expect(validateAliasName("a")).toEqual([]);
    expect(validateAliasName("_x1")).toEqual([]);
  });
  it("rejects bad syntax", () => {
    expect(validateAliasName("1abc")).not.toEqual([]);
    expect(validateAliasName("has-dash")).not.toEqual([]);
    expect(validateAliasName("__double")).not.toEqual([]);
    expect(validateAliasName("x".repeat(32))).not.toEqual([]);
    expect(validateAliasName("")).toEqual(["Name is required."]);
  });
  it("rejects reserved words and service names", () => {
    expect(validateAliasName("block").join()).toMatch(/reserved/);
    expect(validateAliasName("https").join()).toMatch(/service or protocol/);
  });
  it("detects duplicates case-insensitively, ignoring own name", () => {
    expect(validateAliasName("Web", ["WEB"]).join()).toMatch(/already exists/);
    expect(validateAliasName("WEB", ["WEB"], "WEB")).toEqual([]);
  });
});

describe("alias entries", () => {
  it("parses pasted lists with mixed separators", () => {
    expect(parseEntryList("192.168.1.10\r\n192.168.1.11, 192.168.1.12;\n\n 10.0.0.0/8 ")).toEqual([
      "192.168.1.10",
      "192.168.1.11",
      "192.168.1.12",
      "10.0.0.0/8",
    ]);
  });
  it("validates network entries and flags duplicates", () => {
    const checks = checkAliasEntries("network", ["10.0.0.0/8", "bogus!", "10.0.0.0/8", "!192.168.0.0/16"]);
    expect(checks[0]).toEqual({ entry: "10.0.0.0/8" });
    expect(checks[1]?.error).toMatch(/not a network/);
    expect(checks[2]?.duplicate).toBe(true);
    expect(checks[3]?.error).toBeUndefined();
  });
  it("accepts hostnames for host aliases", () => {
    expect(validateAliasEntries("host", ["example.com", "192.168.1.1", "10.0.0.1-10.0.0.5"])).toEqual([]);
  });
  it("validates port aliases", () => {
    expect(validateAliasEntries("port", ["443", "8000-8080"])).toEqual([]);
    expect(validateAliasEntries("port", ["99999"])).toHaveLength(1);
  });
  it("allows nested alias references", () => {
    expect(validateAliasEntries("network", ["RFC1918"], new Set(["RFC1918"]))).toEqual([]);
  });
  it("requires at least one entry for basic types", () => {
    expect(validateAliasEntries("network", [])).toEqual(["Add at least one entry."]);
    expect(validateAliasEntries("geoip", [])).toEqual([]);
  });
});
