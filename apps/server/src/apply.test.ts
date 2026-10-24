import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addAlias,
  addRule,
  createWorkingCopy,
  deleteAlias,
  deleteRules,
  moveRule,
  updateAlias,
  updateRule,
  type WorkingCopy,
} from "@ruledeck/core";
import { OpnsenseClient } from "@ruledeck/opnsense-client";
import { buildMockServer, type MockServer } from "../../mock-opnsense/src/server.ts";
import { runApply } from "./apply.ts";

let mock: MockServer;
let client: OpnsenseClient;
let base: string;

beforeAll(async () => {
  mock = buildMockServer();
  await mock.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = mock.app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
  client = new OpnsenseClient({ baseUrl: base, apiKey: "mock-key", apiSecret: "mock-secret", timeoutMs: 2000 });
});
afterAll(async () => {
  await client.close();
  await mock.app.close();
});
beforeEach(async () => {
  await fetch(`${base}/__mock/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
});

interface MockDump {
  pendingApply: boolean;
  aliasPendingReconfigure: boolean;
  applyCount: number;
  rules: { uuid: string; log: string }[];
}
const mockState = async () => (await (await fetch(`${base}/__mock/state`)).json()) as MockDump;

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function load(): Promise<WorkingCopy> {
  const r = await client.readAll();
  return createWorkingCopy({ firewallId: "default", loadedAt: new Date().toISOString(), ...r });
}

const ruleId = (wc: WorkingCopy, desc: string) => wc.current.rules.find((r) => r.description === desc)!.id;

describe("apply pipeline", () => {
  it("creates an alias and a rule that uses it, activates and verifies", async () => {
    let wc = await load();
    wc = addAlias(wc, { name: "WEB_SERVERS", type: "network", enabled: true, entries: ["192.168.1.10", "192.168.1.0/28"], description: "web", categories: [], extra: {} }).wc;
    const added = addRule(wc, {
      afterId: ruleId(wc, "Allow web to DMZ"),
      patch: {
        description: "Allow HTTPS to web servers",
        protocol: "TCP",
        destination: { negate: false, items: [{ kind: "alias", name: "WEB_SERVERS" }] },
        destinationPort: { kind: "literal", value: "443" },
      },
    });
    wc = added.wc;

    const res = await runApply(client, wc, { acknowledgeRisks: false });
    expect(res.steps.map((s) => `${s.status}:${s.label}`)).toEqual([
      "done:Create alias WEB_SERVERS",
      'done:Create rule "Allow HTTPS to web servers"',
      "done:Reload aliases",
      "done:Activate firewall rules",
      "done:Verify result on firewall",
    ]);
    expect(res.outcome).toBe("success");
    expect(res.state).toEqual({ written: 2, totalWrites: 2, activated: true, verified: true });

    // The firewall now has the alias and the rule, linked by name, placed right after its anchor.
    const after = await client.readAll();
    const rule = after.rules.find((r) => r.description === "Allow HTTPS to web servers")!;
    expect(rule.destination.items).toEqual([{ kind: "alias", name: "WEB_SERVERS" }]);
    const order = after.rules.map((r) => r.description);
    expect(order.indexOf("Allow HTTPS to web servers")).toBe(order.indexOf("Allow web to DMZ") + 1);
    const state = await mockState();
    expect(state.pendingApply).toBe(false);
    expect(state.aliasPendingReconfigure).toBe(false);
  });

  it("updates only changed fields, reorders, deletes, and verifies the order", async () => {
    let wc = await load();
    const blockDmz = ruleId(wc, "Block DMZ to LAN");
    wc = updateRule(wc, blockDmz, { log: true });
    wc = moveRule(wc, ruleId(wc, "Default allow LAN IPv6 to any"), ruleId(wc, "Default allow LAN to any"));
    wc = deleteRules(wc, [ruleId(wc, "SSH from WAN (disabled)")]);
    wc = updateAlias(wc, wc.current.aliases.find((a) => a.name === "RFC1918")!.id, { description: "Private ranges" });

    const res = await runApply(client, wc, { acknowledgeRisks: false });
    expect(res.outcome).toBe("success");
    const after = await client.readAll();
    const descs = after.rules.map((r) => r.description);
    expect(descs.indexOf("Default allow LAN IPv6 to any")).toBeLessThan(descs.indexOf("Default allow LAN to any"));
    expect(descs).not.toContain("SSH from WAN (disabled)");
    expect(after.rules.find((r) => r.id === blockDmz)!.log).toBe(true);
    // Unknown fields untouched.
    expect(after.rules.find((r) => r.id === blockDmz)!.extra.statetype).toBe("keep");
    expect(after.aliases.find((a) => a.name === "RFC1918")!.description).toBe("Private ranges");
  });

  it("refuses to apply when someone changed the same rule on the firewall", async () => {
    let wc = await load();
    const id = ruleId(wc, "Block DMZ to LAN");
    wc = updateRule(wc, id, { log: true });
    await post("/__mock/external-edit", { uuid: id, fields: { description: "changed by someone else" } });

    const res = await runApply(client, wc, { acknowledgeRisks: false });
    expect(res.outcome).toBe("conflict");
    expect(res.conflicts![0]).toMatchObject({ id, reason: "modified" });
    expect(res.conflicts![0]!.fields!.some((f) => f.field === "description")).toBe(true);
    expect(res.steps).toEqual([]);
    const state = await mockState();
    expect(state.rules.find((r) => r.uuid === id)!.log).toBe("0"); // not overwritten
  });

  it("refuses to reorder a group that changed meanwhile", async () => {
    let wc = await load();
    wc = moveRule(wc, ruleId(wc, "Block DMZ to LAN"), ruleId(wc, "Admin access to firewall GUI"));
    const other = ruleId(wc, "Allow web to DMZ");
    await post("/__mock/external-edit", { uuid: other, fields: { sequence: "450" } });
    const res = await runApply(client, wc, { acknowledgeRisks: false });
    expect(res.outcome).toBe("conflict");
    expect(res.conflicts!.some((c) => c.reason === "order_changed")).toBe(true);
  });

  it("detects a name clash for a new alias", async () => {
    let wc = await load();
    wc = addAlias(wc, { name: "NEW_ONE", type: "host", enabled: true, entries: ["10.0.0.1"], description: "", categories: [], extra: {} }).wc;
    await client.addAlias({ name: "NEW_ONE", type: "host", content: "10.0.0.2" });
    const res = await runApply(client, wc, { acknowledgeRisks: false });
    expect(res.outcome).toBe("conflict");
    expect(res.conflicts![0]!.reason).toBe("name_taken");
  });

  it("stops at the first failed write and reports a partial state with recovery steps", async () => {
    let wc = await load();
    wc = addAlias(wc, { name: "A1", type: "host", enabled: true, entries: ["10.0.0.1"], description: "", categories: [], extra: {} }).wc;
    wc = updateRule(wc, ruleId(wc, "Block DMZ to LAN"), { log: true });
    wc = updateRule(wc, ruleId(wc, "Allow web to DMZ"), { log: false });
    await post("/__mock/faults", [{ match: "firewall/filter/set_rule", type: "validation" }]);

    const res = await runApply(client, wc, { acknowledgeRisks: false });
    expect(res.outcome).toBe("partial");
    expect(res.steps.map((s) => s.status)).toEqual(["done", "failed", "skipped", "skipped"]);
    expect(res.steps[1]!.error).toMatch(/rejected the change.*rule.description/);
    expect(res.state).toMatchObject({ written: 1, activated: false, verified: false });
    expect(res.recovery![0]).toMatch(/NOT activated/);
    const state = await mockState();
    expect(state.applyCount).toBe(0); // never activated
  });

  it("reports an activation failure honestly", async () => {
    let wc = await load();
    wc = updateRule(wc, ruleId(wc, "Block DMZ to LAN"), { log: true });
    await post("/__mock/faults", [{ match: "firewall/filter/apply", type: "http500" }]);
    const res = await runApply(client, wc, { acknowledgeRisks: false });
    expect(res.outcome).toBe("partial");
    expect(res.state).toMatchObject({ written: 1, activated: false });
    expect(res.steps.at(-1)).toMatchObject({ label: "Activate firewall rules", status: "failed" });
  });

  it("does not write invalid changes", async () => {
    let wc = await load();
    wc = updateRule(wc, ruleId(wc, "Block DMZ to LAN"), { destination: { negate: false, items: [{ kind: "alias", name: "MISSING" }] } });
    const res = await runApply(client, wc, { acknowledgeRisks: false });
    expect(res.outcome).toBe("invalid");
    expect(res.validation!.errorCount).toBe(1);
  });

  it("requires acknowledging lockout risks", async () => {
    let wc = await load();
    wc = updateRule(wc, ruleId(wc, "Admin access to firewall GUI"), { enabled: false });
    const res = await runApply(client, wc, { acknowledgeRisks: false });
    expect(res.outcome).toBe("risky");
    expect(res.risks![0]!.label).toBe("Admin access to firewall GUI");
    const ok = await runApply(client, wc, { acknowledgeRisks: true });
    expect(ok.outcome).toBe("success");
  });

  it("deletes a referenced alias only together with the referencing change", async () => {
    let wc = await load();
    const rfc = wc.current.aliases.find((a) => a.name === "RFC1918")!;
    const floating = ruleId(wc, "Floating: block private sources");
    wc = updateRule(wc, floating, { source: { negate: false, items: [{ kind: "literal", value: "10.0.0.0/8" }] } });
    wc = deleteAlias(wc, rfc.id);
    const res = await runApply(client, wc, { acknowledgeRisks: true });
    expect(res.outcome).toBe("success");
    const after = await client.readAll();
    expect(after.aliases.some((a) => a.name === "RFC1918")).toBe(false);
  });
});
