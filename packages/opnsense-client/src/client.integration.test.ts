import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildMockServer, type MockServer } from "../../../apps/mock-opnsense/src/server.ts";
import { OpnsenseClient } from "./client.ts";
import { OpnsenseError } from "./errors.ts";

let mock: MockServer;
let baseUrl: string;

beforeAll(async () => {
  mock = buildMockServer();
  await mock.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = mock.app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await mock.app.close();
});

beforeEach(async () => {
  await fetch(`${baseUrl}/__mock/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
});

const client = (over: Partial<{ apiSecret: string; timeoutMs: number }> = {}) =>
  new OpnsenseClient({ baseUrl, apiKey: "mock-key", apiSecret: over.apiSecret ?? "mock-secret", timeoutMs: over.timeoutMs });

const fault = (match: string, type: string, count = 1) =>
  fetch(`${baseUrl}/__mock/faults`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ match, type, count }]) });

describe("OpnsenseClient against the mock", () => {
  it("detects the version", async () => {
    expect(await client().getVersion()).toBe("26.7.7");
  });

  it("reads rules, aliases and options in firewall order", async () => {
    const res = await client().readAll();
    expect(res.rules.map((r) => r.description)).toEqual([
      "Floating: block private sources",
      "Admin access to firewall GUI",
      "Default allow LAN to any",
      "Default allow LAN IPv6 to any",
      "Allow web to DMZ",
      "Block DMZ to LAN",
      "SSH from WAN (disabled)",
      "Anti-Lockout Rule",
    ]);
    expect(res.rules[0]?.prioGroup).toBe("200000");
    expect(res.rules.at(-1)?.origin).toBe("legacy");
    expect(res.rules[1]?.source.items).toEqual([{ kind: "alias", name: "ADMIN_HOSTS" }]);
    expect(res.rules[1]?.destination.items).toEqual([{ kind: "self" }]);
    expect(res.rules[4]?.destinationPort).toEqual({ kind: "alias", name: "WEB_PORTS" });
    expect(res.rules[6]?.destination.items).toEqual([{ kind: "interfaceAddr", iface: "wan" }]);
    expect(res.rules[2]?.extra.statetype).toBe("keep");
    expect(res.aliases.map((a) => a.name)).toEqual(["ADMIN_HOSTS", "RFC1918", "WEB_PORTS"]);
    expect(res.aliases.find((a) => a.name === "RFC1918")?.entries).toHaveLength(3);
    expect(res.options.interfaces.map((i) => i.key).sort()).toEqual(["lan", "opt1", "wan"]);
    expect(res.options.aliasTypes.map((t) => t.value)).toContain("network");
    expect(res.options.protocols).toContain("TCP/UDP");
    expect(res.options.wellKnownPorts.find((p) => p.value === "https")).toBeTruthy();
    expect(Object.keys(res.fingerprints)).toHaveLength(res.rules.length + res.aliases.length);
  });

  it("pages through large result sets", async () => {
    const c = client();
    const rows = await c.listRawRules();
    expect(rows.length).toBe(8);
  });

  it("maps bad credentials to an auth error without leaking the secret", async () => {
    const err = await client({ apiSecret: "wrong-secret" }).getVersion().catch((e) => e);
    expect(err).toBeInstanceOf(OpnsenseError);
    expect(err.kind).toBe("auth");
    expect(JSON.stringify(err.toJSON())).not.toContain("wrong-secret");
  });

  it("maps a 500 to a server error", async () => {
    await fault("core/firmware", "http500");
    await expect(client().getVersion()).rejects.toMatchObject({ kind: "server" });
  });

  it("maps a missing endpoint to unsupported", async () => {
    await fault("core/firmware", "unsupported");
    await expect(client().getVersion()).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("treats a missing port-options endpoint as optional (25.x)", async () => {
    await fetch(`${baseUrl}/__mock/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: "25.7.1" }) });
    const res = await client().readAll();
    expect(res.options.wellKnownPorts).toEqual([]);
  });

  it("times out", async () => {
    await fault("core/firmware", "timeout");
    await expect(client({ timeoutMs: 300 }).getVersion()).rejects.toMatchObject({ kind: "timeout" });
  });

  it("maps a refused connection to a network error", async () => {
    const c = new OpnsenseClient({ baseUrl: "http://127.0.0.1:1", apiKey: "k", apiSecret: "s" });
    await expect(c.getVersion()).rejects.toMatchObject({ kind: "network" });
  });
});
