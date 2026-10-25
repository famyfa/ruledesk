import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildMockServer, type MockServer } from "../../../apps/mock-opnsense/src/server.ts";
import { OpnsenseClient } from "./client.ts";
import { OpnsenseError } from "./errors.ts";
import { loginWithPassword, logoutSession, parseCsrfHeaderToken, parseLoginForm } from "./login.ts";

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
  new OpnsenseClient({ baseUrl, auth: { kind: "apikey", apiKey: "mock-key", apiSecret: over.apiSecret ?? "mock-secret" }, timeoutMs: over.timeoutMs });

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
    const c = new OpnsenseClient({ baseUrl: "http://127.0.0.1:1", auth: { kind: "apikey", apiKey: "k", apiSecret: "s" } });
    await expect(c.getVersion()).rejects.toMatchObject({ kind: "network" });
  });
});

describe("signing in with username and password (GUI session)", () => {
  const signIn = (user = "admin", pw = "ruledeck-dev") => loginWithPassword({ baseUrl }, user, pw);
  const post = (path: string, body: unknown = {}) =>
    fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("parses the login form and the CSRF header token", () => {
    expect(parseLoginForm('<form method="post"><input type="hidden" name="abc" value="tok" /><input name="usernamefld"></form>')).toEqual({ key: "abc", token: "tok" });
    expect(parseCsrfHeaderToken('xhr.setRequestHeader("X-CSRFToken", "t0k" );')).toBe("t0k");
  });

  it("signs in and uses the session for reads and writes, recorded under the user", async () => {
    const { credentials } = await signIn();
    expect(credentials.kind).toBe("session");
    const c = new OpnsenseClient({ baseUrl, auth: credentials });
    const r = await c.readAll();
    expect(r.rules.length).toBeGreaterThan(0);
    await c.setRule(r.rules.find((x) => x.origin === "mvc")!.id, { log: "1" });
    const { history } = (await (await fetch(`${baseUrl}/__mock/history`)).json()) as { history: { user: string }[] };
    expect(history.at(-1)!.user).toBe("admin");
  });

  it("rejects a wrong password without leaking it", async () => {
    const err = await signIn("admin", "wrong-password-123").catch((e) => e);
    expect(err).toBeInstanceOf(OpnsenseError);
    expect(err.kind).toBe("auth");
    expect(JSON.stringify(err.toJSON())).not.toContain("wrong-password-123");
  });

  it("reports missing privileges as forbidden, not as signed out", async () => {
    const { credentials } = await signIn("viewer", "viewer-pass");
    const c = new OpnsenseClient({ baseUrl, auth: credentials });
    await c.readAll().catch(() => {}); // reading options may be partly forbidden
    await expect(c.setRule("0c6f0f84-1b2a-4c1e-8f0e-000000000002", { log: "1" })).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("treats an expired firewall session as signed out", async () => {
    const { credentials } = await signIn();
    const c = new OpnsenseClient({ baseUrl, auth: credentials });
    await post("/__mock/expire-sessions");
    await expect(c.getVersion()).rejects.toMatchObject({ kind: "auth" });
  });

  it("refuses API writes without the CSRF token", async () => {
    const { credentials } = await signIn();
    const c = new OpnsenseClient({ baseUrl, auth: { ...credentials, csrfToken: "nope" } });
    await expect(c.setRule("0c6f0f84-1b2a-4c1e-8f0e-000000000002", { log: "1" })).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("explains the DNS-rebind protection page", async () => {
    await post("/__mock/dns-rebind", { on: true });
    await expect(signIn()).rejects.toThrow(/DNS-rebind/);
  });

  it("logs out of the firewall session", async () => {
    const { credentials } = await signIn();
    await logoutSession({ baseUrl }, credentials);
    await expect(new OpnsenseClient({ baseUrl, auth: credentials }).getVersion()).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("firewall log", () => {
  const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("reads the newest lines first and links them to rules", async () => {
    const { entries, missed } = await client().readFirewallLog({ limit: 10 });
    expect(entries).toHaveLength(10);
    expect(missed).toBe(false);
    expect(entries[0]!.digest).toMatch(/^[0-9a-f]{32}$/);
    const ruleUuids = new Set((await client().readAll()).rules.map((r) => r.id));
    expect(entries.every((e) => e.ruleId === "0" || ruleUuids.has(e.ruleId))).toBe(true);
    expect(entries.some((e) => e.ruleLabel !== "")).toBe(true);
  });

  it("returns only newer lines when given the digest of the newest known line", async () => {
    const first = (await client().readFirewallLog({ limit: 5 })).entries;
    expect((await client().readFirewallLog({ limit: 50, sinceDigest: first[0]!.digest })).entries).toEqual([]);
    await post("/__mock/log", [{ src: "198.51.100.1", dstport: "8080", action: "block" }, { src: "198.51.100.2", dstport: "8081" }]);
    const newer = await client().readFirewallLog({ limit: 50, sinceDigest: first[0]!.digest });
    expect(newer.entries.map((e) => e.src)).toEqual(["198.51.100.2", "198.51.100.1"]);
    expect(newer.missed).toBe(false);
  });

  it("says when lines may have been missed (digest not in the window)", async () => {
    const old = (await client().readFirewallLog({ limit: 1 })).entries[0]!;
    await post("/__mock/log", Array.from({ length: 8 }, (_, i) => ({ src: `198.51.100.${i}` })));
    const r = await client().readFirewallLog({ limit: 5, sinceDigest: old.digest });
    expect(r.entries).toHaveLength(5);
    expect(r.missed).toBe(true);
  });

  it("a read-only user can read the log", async () => {
    const { credentials } = await loginWithPassword({ baseUrl }, "viewer", "viewer-pass");
    expect((await new OpnsenseClient({ baseUrl, auth: credentials }).readFirewallLog({ limit: 3 })).entries).toHaveLength(3);
  });

  it("reports a missing privilege as forbidden", async () => {
    const { credentials } = await loginWithPassword({ baseUrl }, "nolog", "nolog-pass");
    await expect(new OpnsenseClient({ baseUrl, auth: credentials }).readFirewallLog({ limit: 3 })).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("rejects an answer that isn't a list", async () => {
    await post("/__mock/faults", [{ match: "diagnostics/firewall/log", type: "validation" }]);
    await expect(client().readFirewallLog({ limit: 3 })).rejects.toMatchObject({ kind: "validation" });
  });
});
