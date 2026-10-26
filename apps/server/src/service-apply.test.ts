import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addGridItem, createServiceWc, deleteGridItem, serviceById, setSetting, updateGridItem, type ServiceDef, type ServiceWc } from "@ruledeck/core";
import { OpnsenseClient } from "@ruledeck/opnsense-client";
import { buildMockServer, type MockServer } from "../../mock-opnsense/src/server.ts";
import { runServiceApply } from "./service-apply.ts";

let mock: MockServer;
let client: OpnsenseClient;
let base: string;

beforeAll(async () => {
  mock = buildMockServer();
  await mock.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(mock.app.server.address() as { port: number }).port}`;
  client = new OpnsenseClient({ baseUrl: base, auth: { kind: "apikey", apiKey: "mock-key", apiSecret: "mock-secret" }, timeoutMs: 2000 });
});
afterAll(async () => {
  await client.close();
  await mock.app.close();
});
beforeEach(async () => {
  await fetch(`${base}/__mock/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
});

type Dump = Record<string, { settings: Record<string, string> | null; pending: boolean; reconfigureCount: number; grids: Record<string, Record<string, Record<string, string>>> }>;
const dump = async () => (await (await fetch(`${base}/__mock/services`)).json()) as Dump;
const external = (body: object) => fetch(`${base}/__mock/service-edit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const load = async (def: ServiceDef): Promise<ServiceWc> => createServiceWc(await client.readServiceSnapshot(def, "site"));
const idOf = (wc: ServiceWc, grid: string, field: string, value: string) => wc.grids[grid]!.find((r) => r.item[field] === value)!.id;

describe("reading a service", () => {
  it("reads settings and tables as flat maps and keeps secrets out", async () => {
    const def = serviceById("kea4")!;
    const snap = await client.readServiceSnapshot(def, "site");
    expect(snap.settings).toMatchObject({ "general.enabled": "0", "general.valid_lifetime": "4000" });
    expect(snap.settings!["general.ddns_domain_key_secret"]).toBe("");
    expect(snap.secrets).toContain("general.ddns_domain_key_secret");
    expect(JSON.stringify(snap)).not.toContain("mock-secret-do-not-leak");
    expect(snap.grids.subnets).toHaveLength(1);
    expect(snap.grids.subnets![0]!.item.subnet).toBe("192.168.1.0/24");
    expect(snap.options["settings:general.interfaces"]!.map((o) => o.value)).toEqual(["lan", "opt1"]);
  });

  it("never returns a CARP password", async () => {
    const snap = await client.readServiceSnapshot(serviceById("vips")!, "site");
    expect(JSON.stringify(snap)).not.toContain("mock-carp-password");
    expect(snap.secrets).toContain("password");
  });
});

describe("read-only services never leak secrets", () => {
  it("users, WireGuard and NAT are read without passwords, keys or seeds", async () => {
    for (const id of ["access", "wireguard", "nat"]) {
      const snap = await client.readServiceSnapshot(serviceById(id)!, "site");
      const text = JSON.stringify(snap);
      for (const secret of ["mock-hash-do-not-leak", "MOCKOTPSEED", "mock-wg-private-do-not-leak", "mock-psk-do-not-leak"]) expect(text).not.toContain(secret);
    }
    const users = await client.readServiceSnapshot(serviceById("access")!, "site");
    expect(users.grids.users![0]!.item.name).toBe("admin");
    expect(users.secrets).toEqual(expect.arrayContaining(["password", "otp_seed"]));
    const wg = await client.readServiceSnapshot(serviceById("wireguard")!, "site");
    expect(wg.secrets).toEqual(expect.arrayContaining(["privkey", "psk"]));
  });
});

describe("certificates", () => {
  it("keeps only whitelisted fields (no private key, no PEM)", async () => {
    const certs = await client.listCertificates();
    expect(certs.map((c) => c.description)).toEqual(["Web GUI TLS certificate", "VPN certificate", "Old certificate", "Internal CA"]);
    const text = JSON.stringify(certs);
    expect(text).not.toContain("MOCKPRIVATEKEY");
    expect(text).not.toContain("BEGIN");
    expect(certs[0]).toMatchObject({ inUse: true, isCa: false });
    expect(certs[3]!.isCa).toBe(true);
    expect(certs[0]!.altNames).toEqual(["a.example", "b.example"]);
    expect(Object.keys(certs[0]!).sort()).toEqual(["altNames", "caRef", "commonName", "description", "inUse", "isCa", "refid", "subject", "type", "uuid", "validFrom", "validTo"]);
  });
});

describe("applying service changes", () => {
  const def = serviceById("dnsmasq")!;

  it("writes settings, adds, edits and deletes, activates once, and reads back", async () => {
    let wc = await load(def);
    wc = setSetting(wc, "regdhcp", "1");
    wc = updateGridItem(wc, "hosts", idOf(wc, "hosts", "host", "nas"), { ip: "192.168.1.50" });
    wc = deleteGridItem(wc, "hosts", idOf(wc, "hosts", "host", "printer"));
    wc = addGridItem(wc, "hosts", { host: "cam", domain: "lan", ip: "192.168.1.9", hwaddr: "", descr: "" }).wc;
    const r = await runServiceApply(client, def, wc, "site");
    expect(r.outcome).toBe("success");
    expect(r.state).toMatchObject({ written: 4, totalWrites: 4, activated: true, verified: true });
    const m = (await dump()).dnsmasq!;
    expect(m.settings!.regdhcp).toBe("1");
    expect(Object.values(m.grids.hosts!).map((h) => `${h.host}:${h.ip}`).sort()).toEqual(["cam:192.168.1.9", "nas:192.168.1.50"]);
    expect(m.reconfigureCount).toBe(1);
    expect(m.pending).toBe(false);
  });

  it("sends only the fields that changed", async () => {
    let wc = await load(def);
    wc = updateGridItem(wc, "hosts", idOf(wc, "hosts", "host", "nas"), { descr: "Backup box" });
    expect((await runServiceApply(client, def, wc, "site")).outcome).toBe("success");
    const nas = Object.values((await dump()).dnsmasq!.grids.hosts!).find((h) => h.host === "nas")!;
    expect(nas).toMatchObject({ descr: "Backup box", ip: "192.168.1.5" });
  });

  it("stops on a conflict and writes nothing", async () => {
    let wc = await load(def);
    wc = updateGridItem(wc, "hosts", idOf(wc, "hosts", "host", "nas"), { ip: "192.168.1.50" });
    await external({ service: "dnsmasq", grid: "hosts", match: { host: "nas" }, fields: { ip: "192.168.1.77" } });
    const r = await runServiceApply(client, def, wc, "site");
    expect(r.outcome).toBe("conflict");
    expect(r.conflicts![0]!.message).toMatch(/changed on the firewall/);
    expect(r.state.written).toBe(0);
    expect(Object.values((await dump()).dnsmasq!.grids.hosts!).find((h) => h.host === "nas")!.ip).toBe("192.168.1.77");
    expect((await dump()).dnsmasq!.reconfigureCount).toBe(0);
  });

  it("reports a firewall validation error as failed, with nothing activated", async () => {
    let wc = await load(def);
    wc = updateGridItem(wc, "hosts", idOf(wc, "hosts", "host", "nas"), { ip: "INVALID" });
    const r = await runServiceApply(client, def, wc, "site");
    expect(r.outcome).toBe("failed");
    expect(r.steps.at(-1)!.error).toMatch(/not allowed/);
    expect((await dump()).dnsmasq!.reconfigureCount).toBe(0);
  });

  it("a later failure after a write is 'partial' with recovery advice and no activation", async () => {
    let wc = await load(def);
    wc = setSetting(wc, "regdhcp", "1"); // written first
    wc = updateGridItem(wc, "hosts", idOf(wc, "hosts", "host", "nas"), { ip: "INVALID" });
    const r = await runServiceApply(client, def, wc, "site");
    expect(r.outcome).toBe("partial");
    expect(r.state).toMatchObject({ written: 1, activated: false });
    expect(r.recovery!.join(" ")).toMatch(/History/);
    expect(r.steps.map((s) => s.status)).toEqual(["done", "failed"]);
  });

  it("detects an entry deleted elsewhere", async () => {
    let wc = await load(def);
    const id = idOf(wc, "hosts", "host", "nas");
    wc = updateGridItem(wc, "hosts", id, { ip: "192.168.1.50" });
    await external({ service: "dnsmasq", grid: "hosts", match: { host: "nas" }, remove: true });
    const r = await runServiceApply(client, def, wc, "site");
    expect(r.outcome).toBe("conflict");
    expect(r.conflicts![0]!.message).toMatch(/no longer exists/);
  });

  it("does nothing without changes", async () => {
    expect((await runServiceApply(client, def, await load(def), "site")).outcome).toBe("nothing");
  });

  it("writes a typed secret but never shows it, and says it can't be read back", async () => {
    const kea = serviceById("kea4")!;
    let wc = await load(kea);
    wc = setSetting(wc, "general.ddns_domain_key_secret", "new-top-secret");
    const r = await runServiceApply(client, kea, wc, "site");
    expect(r.outcome).toBe("success");
    expect(r.secretsNotVerified).toBe(true);
    expect(JSON.stringify(r)).not.toContain("new-top-secret");
    expect((await dump()).kea4!.settings!["general.ddns_domain_key_secret"]).toBe("new-top-secret");
  });

  it("an untouched secret is not sent (the firewall keeps its value)", async () => {
    const kea = serviceById("kea4")!;
    let wc = await load(kea);
    wc = setSetting(wc, "general.valid_lifetime", "5000");
    expect((await runServiceApply(client, kea, wc, "site")).outcome).toBe("success");
    expect((await dump()).kea4!.settings!["general.ddns_domain_key_secret"]).toBe("mock-secret-do-not-leak");
  });

  it("works for network services too (gateways)", async () => {
    const gw = serviceById("gateways")!;
    let wc = await load(gw);
    wc = updateGridItem(wc, "gateways", wc.grids.gateways![0]!.id, { priority: "100" });
    const r = await runServiceApply(client, gw, wc, "site");
    expect(r.outcome).toBe("success");
    expect(Object.values((await dump()).gateways!.grids.gateways!)[0]!.priority).toBe("100");
  });
});
