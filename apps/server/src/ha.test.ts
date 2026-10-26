import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OpnsenseClient } from "@ruledeck/opnsense-client";
import { buildMockServer, type MockServer } from "../../mock-opnsense/src/server.ts";
import { readHa, runSwitch } from "./ha.ts";

let mock: MockServer;
let peer: MockServer;
let client: OpnsenseClient;
let base: string;

beforeAll(async () => {
  mock = buildMockServer();
  peer = buildMockServer();
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
  mock.linkSecondary(peer);
});

const control = (body: object) => fetch(`${base}/__mock/carp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const fast = { pollMs: 20, timeoutMs: 1500 };

describe("HA state", () => {
  it("reads the VIPs, flags and the peer", async () => {
    const v = await readHa(client);
    expect(v.role).toBe("master");
    expect(v.peerReachable).toBe(true);
    expect(v.state).toMatchObject({ maintenance: false, allow: true, demotion: 0 });
    expect(v.state.vips.map((x) => x.interface)).toEqual(["WAN", "LAN"]);
    expect(v.enter.allowed).toBe(true);
  });
});

describe("graceful switch", () => {
  it("enters maintenance, reads it back, and switches back", async () => {
    const out = await runSwitch(client, true, fast);
    expect(out.outcome).toBe("done");
    expect(out.after).toMatchObject({ maintenance: true });
    expect(out.after!.vips.every((v) => v.status === "BACKUP")).toBe(true);
    const back = await runSwitch(client, false, fast);
    expect(back.outcome).toBe("done");
    expect(back.after!.vips.every((v) => v.status === "MASTER")).toBe(true);
  });

  it("waits while the peer takes over", async () => {
    await control({ takeoverDelayMs: 300 });
    const out = await runSwitch(client, true, fast);
    expect(out.outcome).toBe("done");
  });

  it("never toggles twice: entering when already in maintenance changes nothing", async () => {
    await runSwitch(client, true, fast);
    const again = await runSwitch(client, true, fast);
    expect(again.outcome).toBe("already");
    expect((await readHa(client)).state.maintenance).toBe(true); // not toggled back
    const stillOut = await runSwitch(client, false, fast);
    expect(stillOut.outcome).toBe("done");
    expect((await runSwitch(client, false, fast)).outcome).toBe("already");
    expect((await readHa(client)).state.maintenance).toBe(false);
  });

  it("refuses when the peer can't be reached, and changes nothing", async () => {
    mock.linkSecondary(null);
    const out = await runSwitch(client, true, fast);
    expect(out.outcome).toBe("refused");
    expect(out.checks.find((c) => c.id === "peer")?.ok).toBe(false);
    expect((await readHa(client)).state.maintenance).toBe(false);
  });

  it("refuses when CARP is switched off", async () => {
    await control({ allow: false });
    expect((await runSwitch(client, true, fast)).outcome).toBe("refused");
  });

  it("says so when the node doesn't become master again (no automatic fix)", async () => {
    await runSwitch(client, true, fast);
    await control({ stuckBackup: true });
    const out = await runSwitch(client, false, { pollMs: 20, timeoutMs: 200 });
    expect(out.outcome).toBe("unverified");
    expect(out.message).toMatch(/not become master/);
    expect(out.after!.maintenance).toBe(false); // the toggle itself happened exactly once
  });

  it("a rejected toggle is reported and not repeated", async () => {
    await fetch(`${base}/__mock/faults`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ match: "diagnostics/interface/carp_status", type: "http500", count: 1 }]) });
    const out = await runSwitch(client, true, fast);
    expect(out.outcome).toBe("failed");
    expect((await readHa(client)).state.maintenance).toBe(false);
  });
});
