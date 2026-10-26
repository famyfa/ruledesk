import { describe, expect, it } from "vitest";
import { describeHa, haRole, switchChecks, switchSettled, type HaState } from "./ha.ts";

const vip = (status: string, mode = "carp") => ({ interface: "WAN", vhid: "1", subnet: "10.0.0.1", status, mode });
const state = (p: Partial<HaState> = {}): HaState => ({ vips: [vip("MASTER"), vip("MASTER")], demotion: 0, allow: true, maintenance: false, ...p });

describe("HA role", () => {
  it("is judged by the CARP VIPs only", () => {
    expect(haRole(state())).toBe("master");
    expect(haRole(state({ vips: [vip("BACKUP"), vip("BACKUP")] }))).toBe("backup");
    expect(haRole(state({ vips: [vip("MASTER"), vip("BACKUP")] }))).toBe("mixed");
    expect(haRole(state({ vips: [vip("MASTER", "ipalias")] }))).toBe("none");
    expect(haRole(state({ vips: [vip("BACKUP"), vip("MASTER", "ipalias")] }))).toBe("backup");
  });
});

describe("switch checks", () => {
  it("allows entering maintenance only for a healthy master with a reachable peer", () => {
    expect(switchChecks(state(), true, true)).toMatchObject({ allowed: true, already: false });
    expect(switchChecks(state(), true, false).allowed).toBe(false);
    expect(switchChecks(state({ demotion: 240 }), true, true).allowed).toBe(false);
    expect(switchChecks(state({ allow: false }), true, true).allowed).toBe(false);
    expect(switchChecks(state({ vips: [vip("BACKUP")] }), true, true).allowed).toBe(false); // already not master
    expect(switchChecks(state({ vips: [] }), true, true).allowed).toBe(false);
  });
  it("entering again is a no-op, not a second toggle", () => {
    const s = state({ maintenance: true, demotion: 240, vips: [vip("BACKUP")] });
    expect(switchChecks(s, true, true)).toMatchObject({ allowed: false, already: true });
  });
  it("leaving needs maintenance mode; leaving when not in it is a no-op", () => {
    expect(switchChecks(state({ maintenance: true }), false, true)).toMatchObject({ allowed: true, already: false });
    expect(switchChecks(state(), false, true)).toMatchObject({ allowed: false, already: true });
  });
});

describe("settled", () => {
  it("enter: maintenance and no VIP master", () => {
    expect(switchSettled(state({ maintenance: true, vips: [vip("BACKUP"), vip("BACKUP")] }), true)).toBe(true);
    expect(switchSettled(state({ maintenance: true }), true)).toBe(false);
    expect(switchSettled(state({ vips: [vip("BACKUP")] }), true)).toBe(false);
  });
  it("leave: no maintenance and master again", () => {
    expect(switchSettled(state(), false)).toBe(true);
    expect(switchSettled(state({ vips: [vip("BACKUP")] }), false)).toBe(false);
    expect(switchSettled(state({ maintenance: true }), false)).toBe(false);
  });
  it("has readable descriptions", () => {
    expect(describeHa(state())).toBe("Master");
    expect(describeHa(state({ maintenance: true, vips: [vip("BACKUP")] }))).toMatch(/peer carries/);
  });
});
