import { describe, expect, it } from "vitest";
import { addGridItem, computeServiceChanges, createServiceWc, deleteGridItem, flattenModel, isNewId, setSetting, unflatten, updateGridItem, type ServiceSnapshot } from "./service.ts";
import { certStatus, daysLeft } from "./service.ts";
import { isSecretField, SERVICES, serviceById } from "./service-catalog.ts";

const raw = {
  general: {
    enabled: "1",
    port: "53",
    interfaces: { lan: { value: "LAN", selected: 1 }, opt1: { value: "DMZ", selected: 1 }, wan: { value: "WAN", selected: 0 } },
    mode: { a: { value: "Alpha", selected: "1" }, b: { value: "Beta", selected: 0 } },
    empty: [],
    nothing: null,
  },
  hosts: { "6687cf94-bcbd-4039-95c5-9d9cbb61eaa1": { host: "x" } },
  api_secret: "hunter2",
  nested: { password: "pw", note: "n" },
};

describe("flattening", () => {
  const f = flattenModel(raw);
  it("flattens sections, options and empties", () => {
    expect(f.values).toMatchObject({ "general.enabled": "1", "general.port": "53", "general.interfaces": "lan,opt1", "general.mode": "a", "general.empty": "", "general.nothing": "" });
    expect(f.options["general.interfaces"]).toEqual([
      { value: "lan", label: "LAN" },
      { value: "opt1", label: "DMZ" },
      { value: "wan", label: "WAN" },
    ]);
  });
  it("skips tables nested in a tree (uuid keys)", () => {
    expect(Object.keys(f.values).some((k) => k.startsWith("hosts"))).toBe(false);
  });
  it("never keeps secret values", () => {
    expect(f.values.api_secret).toBe("");
    expect(f.values["nested.password"]).toBe("");
    expect(f.secrets.sort()).toEqual(["api_secret", "nested.password"]);
    expect(JSON.stringify(f)).not.toContain("hunter2");
    expect(isSecretField("general.password")).toBe(true);
    expect(isSecretField("general.passive")).toBe(false);
  });
  it("round-trips through unflatten", () => {
    expect(unflatten({ "general.enabled": "0", "general.port": "5353", top: "x" })).toEqual({ general: { enabled: "0", port: "5353" }, top: "x" });
  });
});

describe("catalogue", () => {
  it("has unique ids and complete grids", () => {
    expect(new Set(SERVICES.map((s) => s.id)).size).toBe(SERVICES.length);
    for (const s of SERVICES) {
      for (const g of s.grids) {
        for (const p of [g.search, g.get, g.add, g.set, g.del]) expect(p).toMatch(/^[a-z0-9_]+(\/[a-z0-9_]+){1,2}$/);
        expect(g.nameFields.length).toBeGreaterThan(0);
      }
    }
  });
});

const def = serviceById("dnsmasq")!;
const snap = (): ServiceSnapshot => ({
  serviceId: "dnsmasq",
  siteId: "s",
  loadedAt: "",
  settings: { enable: "1", "dhcp.fqdn": "1", password: "" },
  grids: { hosts: [{ id: "u1", item: { host: "nas", domain: "lan", ip: "10.0.0.5", descr: "" } }, { id: "u2", item: { host: "pi", domain: "lan", ip: "10.0.0.6", descr: "" } }] },
  options: {},
  defaults: {},
  secrets: ["password"],
  fingerprints: {},
});

describe("service change sets", () => {
  it("is empty without edits", () => {
    expect(computeServiceChanges(def, createServiceWc(snap()))).toEqual([]);
  });
  it("reports settings, modified, created and deleted items", () => {
    let wc = createServiceWc(snap());
    wc = setSetting(wc, "enable", "0");
    wc = updateGridItem(wc, "hosts", "u1", { ip: "10.0.0.50" });
    wc = deleteGridItem(wc, "hosts", "u2");
    const added = addGridItem(wc, "hosts", { host: "new", domain: "lan", ip: "10.0.0.7", descr: "" });
    expect(isNewId(added.id)).toBe(true);
    const ch = computeServiceChanges(def, added.wc);
    expect(ch.map((c) => `${c.area}:${c.kind}:${c.label}`)).toEqual(["settings:modify:General settings", "hosts:modify:nas lan", "hosts:create:new lan", "hosts:delete:pi lan"]);
    expect(ch[1]!.patch).toEqual({ ip: "10.0.0.50" }); // only the changed field
    expect(ch[2]!.patch).toEqual({ host: "new", domain: "lan", ip: "10.0.0.7" }); // empties left out
  });
  it("edit then revert is no change", () => {
    let wc = updateGridItem(createServiceWc(snap()), "hosts", "u1", { ip: "1.1.1.1" });
    wc = updateGridItem(wc, "hosts", "u1", { ip: "10.0.0.5" });
    expect(computeServiceChanges(def, wc)).toEqual([]);
  });
  it("masks secrets in the visible change but keeps them in the patch", () => {
    const wc = setSetting(createServiceWc(snap()), "password", "s3cret");
    const c = computeServiceChanges(def, wc)[0]!;
    expect(c.fields[0]!.after).not.toContain("s3cret");
    expect(c.patch.password).toBe("s3cret");
  });
});

describe("certificate status", () => {
  const now = Date.parse("2026-10-26T00:00:00Z");
  it("classifies by expiry", () => {
    expect(certStatus({ validTo: "2026-10-01T00:00:00Z" }, now)).toBe("expired");
    expect(certStatus({ validTo: "2026-11-10T00:00:00Z" }, now)).toBe("expiring");
    expect(certStatus({ validTo: "2027-10-26T00:00:00Z" }, now)).toBe("ok");
    expect(certStatus({ validTo: null }, now)).toBe("unknown");
    expect(daysLeft({ validTo: "2026-11-05T00:00:00Z" }, now)).toBe(10);
  });
});
