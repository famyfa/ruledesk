import { describe, expect, it } from "vitest";
import { applyServiceSync, planServiceSync } from "./service-sync.ts";
import { computeServiceChanges, createServiceWc, type ServiceSnapshot } from "./service.ts";
import { serviceById } from "./service-catalog.ts";

const def = serviceById("dnsmasq")!;
const snap = (siteId: string, hosts: Record<string, string>[], extra: Partial<ServiceSnapshot> = {}): ServiceSnapshot => ({
  serviceId: "dnsmasq",
  siteId,
  loadedAt: "",
  settings: { enable: "1", regdhcp: "0", interface: "lan", password: "" },
  grids: { hosts: hosts.map((h, i) => ({ id: `${siteId}-${i}`, item: { host: "", domain: "", ip: "", hwaddr: "", descr: "", ...h } })), ranges: [] },
  options: { "settings:interface": [{ value: "lan", label: "LAN" }, { value: "opt1", label: "DMZ" }] },
  defaults: { hosts: { host: "", domain: "", ip: "", hwaddr: "", descr: "" } },
  secrets: ["password"],
  fingerprints: {},
  ...extra,
});

describe("service sync", () => {
  const source = snap("ber", [
    { host: "nas", domain: "lan", ip: "10.0.0.5", descr: "Storage" },
    { host: "cam", domain: "lan", ip: "10.0.0.9" },
    { host: "same", domain: "lan", ip: "10.0.0.1" },
  ]);
  const target = () => createServiceWc(snap("muc", [{ host: "nas", domain: "LAN", ip: "10.1.0.5" }, { host: "same", domain: "lan", ip: "10.0.0.1" }]));
  const all = { settings: false, grids: { hosts: source.grids.hosts!.map((r) => r.id) } };

  it("creates what's missing, updates what differs (matched by host+domain, ignoring case), skips what's the same", () => {
    const plan = planServiceSync(def, source, target(), all);
    expect(plan.items.map((i) => `${i.label}:${i.kind}`)).toEqual(["nas lan:update", "cam lan:create", "same lan:same"]);
    expect(plan.items[0]!.changes.map((c) => c.field).sort()).toEqual(["descr", "domain", "ip"]);
    const wc = applyServiceSync(target(), plan);
    const ch = computeServiceChanges(def, wc);
    expect(ch.map((c) => `${c.kind}:${c.label}`)).toEqual(["modify:nas lan", "create:cam lan"]);
    expect(ch[0]!.patch).toEqual({ domain: "lan", ip: "10.0.0.5", descr: "Storage" }); // only differing fields
  });

  it("copies settings but never secrets", () => {
    const src = snap("ber", [], { settings: { enable: "0", regdhcp: "1", interface: "lan", password: "" } });
    const t = createServiceWc(snap("muc", [], { settings: { enable: "1", regdhcp: "0", interface: "lan", password: "" } }));
    const plan = planServiceSync(def, src, t, { settings: true, grids: {} });
    expect(plan.items[0]).toMatchObject({ area: "settings", kind: "update" });
    expect(Object.keys(plan.items[0]!.values).sort()).toEqual(["enable", "regdhcp"]);
    expect(applyServiceSync(t, plan).settings).toMatchObject({ enable: "0", regdhcp: "1", password: "" });
  });

  it("translates choices by label and blocks what has no counterpart", () => {
    const src = snap("ber", [], {
      settings: { enable: "1", regdhcp: "0", interface: "opt3", password: "" },
      options: { "settings:interface": [{ value: "lan", label: "LAN" }, { value: "opt3", label: "DMZ" }] },
    });
    const t = createServiceWc(snap("muc", [], { settings: { enable: "1", regdhcp: "0", interface: "lan", password: "" } }));
    const ok = planServiceSync(def, src, t, { settings: true, grids: {} });
    expect(ok.items[0]!.values.interface).toBe("opt1"); // DMZ is opt1 here
    const noDmz = createServiceWc(snap("muc", [], { options: { "settings:interface": [{ value: "lan", label: "LAN" }] } }));
    const blocked = planServiceSync(def, src, noDmz, { settings: true, grids: {} });
    expect(blocked.items[0]).toMatchObject({ kind: "blocked" });
    expect(blocked.items[0]!.reasons[0]).toMatch(/DMZ.*doesn't exist/);
    expect(applyServiceSync(noDmz, blocked)).toBe(noDmz);
  });

  it("blocks entries without a key or with ambiguous matches", () => {
    const src = snap("ber", [{ host: "", domain: "", ip: "1.1.1.1" }, { host: "dup", domain: "lan", ip: "1.1.1.2" }]);
    const t = createServiceWc(snap("muc", [{ host: "dup", domain: "lan" }, { host: "dup", domain: "lan" }]));
    const plan = planServiceSync(def, src, t, { settings: false, grids: { hosts: src.grids.hosts!.map((r) => r.id) } });
    expect(plan.items.map((i) => i.kind)).toEqual(["blocked", "blocked"]);
    expect(plan.items[0]!.reasons[0]).toMatch(/can't be matched/);
    expect(plan.items[1]!.reasons[0]).toMatch(/2 entries match/);
  });

  it("only copies what is selected", () => {
    const plan = planServiceSync(def, source, target(), { settings: false, grids: { hosts: [source.grids.hosts![1]!.id] } });
    expect(plan.items.map((i) => i.label)).toEqual(["cam lan"]);
  });
});
