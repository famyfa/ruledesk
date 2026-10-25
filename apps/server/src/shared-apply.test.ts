import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  addAlias,
  addRule,
  buildSharedView,
  createWorkingCopy,
  SHARED_CATEGORY_UUID,
  uuidOfLocalId,
  type FirewallSnapshot,
  type SiteInput,
  type WorkingCopy,
} from "@ruledeck/core";
import { buildMockServer, type MockServer } from "../../mock-opnsense/src/server.ts";
import { buildApp, CSRF_HEADER, SESSION_COOKIE } from "./app.ts";
import type { AppConfig } from "./config.ts";
import { parseTopology } from "./topology.ts";

/** Two sites, each an HA pair. Munich's DMZ is opt2 (opt1 is GUEST there). */
const mocks: Record<string, MockServer> = {};
let app: FastifyInstance;
const urlOf = (m: MockServer) => `http://127.0.0.1:${(m.app.server.address() as { port: number }).port}`;
const MAPS = {
  ber: { LAN: { key: "lan", label: "LAN" }, DMZ: { key: "opt1", label: "DMZ" } },
  muc: { LAN: { key: "lan", label: "LAN" }, DMZ: { key: "opt2", label: "DMZ" } },
};

beforeAll(async () => {
  mocks.berA = buildMockServer({ dmzKey: "opt1", uuidSalt: "aaaaaaaa" });
  mocks.berB = buildMockServer({ dmzKey: "opt1", uuidSalt: "aaaaaaaa" });
  mocks.mucA = buildMockServer({ dmzKey: "opt2", uuidSalt: "bbbbbbbb" });
  mocks.mucB = buildMockServer({ dmzKey: "opt2", uuidSalt: "bbbbbbbb" });
  for (const m of Object.values(mocks)) await m.app.listen({ port: 0, host: "127.0.0.1" });
  const topology = parseTopology(
    JSON.stringify({
      version: 1,
      sites: [
        { id: "ber", name: "Berlin", primary: { url: urlOf(mocks.berA!) }, secondary: { url: urlOf(mocks.berB!) }, interfaces: MAPS.ber },
        { id: "muc", name: "Munich", primary: { url: urlOf(mocks.mucA!) }, secondary: { url: urlOf(mocks.mucB!) }, interfaces: MAPS.muc },
      ],
    }),
  );
  const config: AppConfig = { production: false, host: "127.0.0.1", port: 0, cookieSecure: false, allowWrites: true, applyRateLimit: 1000, siteLoginFailures: 100, topology };
  app = await buildApp({ config, logger: false });
});

afterAll(async () => {
  await app.close();
  for (const m of Object.values(mocks)) await m.app.close();
});

beforeEach(async () => {
  for (const m of Object.values(mocks)) await fetch(`${urlOf(m)}/__mock/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  mocks.berA!.linkSecondary(mocks.berB!);
  mocks.mucA!.linkSecondary(mocks.mucB!);
});

async function signIn() {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { sites: { ber: { method: "password", username: "admin", password: "ruledeck-dev" }, muc: { method: "password", username: "admin", password: "ruledeck-dev" } } } });
  const cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
  return { headers: { cookie, [CSRF_HEADER]: res.json().csrfToken as string } };
}

async function snapshots(h: { headers: Record<string, string> }) {
  const get = async (id: string) => (await app.inject({ method: "GET", url: `/api/sites/${id}/snapshot`, headers: h.headers })).json().snapshot as FirewallSnapshot;
  return { ber: await get("ber"), muc: await get("muc") };
}

const inputs = (s: { ber: FirewallSnapshot; muc: FirewallSnapshot }): SiteInput[] => [
  { siteId: "ber", siteName: "Berlin", map: MAPS.ber, snapshot: s.ber },
  { siteId: "muc", siteName: "Munich", map: MAPS.muc, snapshot: s.muc },
];

/** Build one shared alias + one shared DMZ rule that uses it. */
function stageWebRule(shared: WorkingCopy) {
  const a = addAlias(shared, { name: "WEB_SERVERS", type: "host", enabled: true, entries: ["10.10.0.10", "10.10.0.11"], description: "web", categories: [SHARED_CATEGORY_UUID], extra: {} });
  const r = addRule(a.wc, {
    patch: {
      description: "Allow HTTPS to web servers",
      interfaces: ["DMZ"],
      protocol: "TCP",
      destination: { negate: false, items: [{ kind: "alias", name: "WEB_SERVERS" }] },
      destinationPort: { kind: "literal", value: "443" },
      categories: [SHARED_CATEGORY_UUID],
    },
  });
  return { wc: r.wc, ruleUuid: uuidOfLocalId(r.id)!, aliasUuid: uuidOfLocalId(a.id)! };
}

const body = (shared: WorkingCopy, snaps: { ber: FirewallSnapshot; muc: FirewallSnapshot }, extra: object = {}) => ({
  shared: { baseline: shared.baseline, current: shared.current },
  sites: { ber: { baseline: snaps.ber }, muc: { baseline: snaps.muc } },
  acknowledgeRisks: {},
  haSync: { ber: true, muc: true },
  ...extra,
});

describe("shared policy across two sites with HA pairs", () => {
  it("builds a rule once and lands it on both sites with the right interface, then syncs HA", async () => {
    const h = await signIn();
    const snaps = await snapshots(h);
    const view = buildSharedView(inputs(snaps));
    expect(view.drift).toEqual([]);
    const { wc, ruleUuid, aliasUuid } = stageWebRule(createWorkingCopy(view.baseline));

    const pre = (await app.inject({ method: "POST", url: "/api/shared/preflight", headers: h.headers, payload: body(wc, snaps) })).json().plans;
    expect(pre.map((p: { status: string }) => p.status)).toEqual(["ready", "ready"]);
    expect(pre[1].changes).toContain("CREATE  Alias: WEB_SERVERS");
    expect(pre[1].needsCategory).toBe(true);

    const res = (await app.inject({ method: "POST", url: "/api/shared/apply", headers: h.headers, payload: body(wc, snaps, { confirm: true }) })).json().result;
    expect(res.outcome).toBe("success");
    expect(res.sites.map((s: { status: string; ha?: { step: string } }) => `${s.status}/${s.ha?.step}`)).toEqual(["applied/synced", "applied/synced"]);

    for (const [primary, secondary, dmz] of [["berA", "berB", "opt1"], ["mucA", "mucB", "opt2"]] as const) {
      for (const m of [mocks[primary]!, mocks[secondary]!]) {
        const st = m.state();
        const rule = st.rules.get(ruleUuid)!;
        expect(rule.interface).toBe(dmz); // same rule, site-specific interface
        expect(rule.destination_net).toBe("WEB_SERVERS");
        expect(rule.categories).toBe(SHARED_CATEGORY_UUID);
        expect(st.aliases.get(aliasUuid)!.content).toBe("10.10.0.10\n10.10.0.11");
        expect(st.categories.get(SHARED_CATEGORY_UUID)?.name).toBe("RuleDeck shared");
      }
    }

    // Reloading shows one shared rule and no drift.
    const after = buildSharedView(inputs(await snapshots(h)));
    expect(after.drift).toEqual([]);
    expect(after.baseline.rules.map((r) => r.description)).toEqual(["Allow HTTPS to web servers"]);
    expect(after.baseline.rules[0]!.interfaces).toEqual(["DMZ"]);
  });

  it("stops at the first failing site and says exactly what happened", async () => {
    const h = await signIn();
    const snaps = await snapshots(h);
    const { wc } = stageWebRule(createWorkingCopy(buildSharedView(inputs(snaps)).baseline));
    await fetch(`${urlOf(mocks.mucA!)}/__mock/faults`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ match: "firewall/filter/set_rule", type: "http500" }]) });
    const res = (await app.inject({ method: "POST", url: "/api/shared/apply", headers: h.headers, payload: body(wc, snaps, { confirm: true }) })).json().result;
    expect(res.outcome).toBe("partial");
    expect(res.sites.map((s: { status: string }) => s.status)).toEqual(["applied", "partial"]);
    const muc = res.sites[1].result;
    expect(muc.state.activated).toBe(false);
    expect(muc.recovery[0]).toMatch(/NOT activated/);
    // Drift now shows the rule missing in Munich, so the user can finish there.
    const view = buildSharedView(inputs(await snapshots(h)));
    expect(view.drift.some((d) => d.kind === "missing" && d.sites.muc === "missing")).toBe(true);
  });

  it("blocks every site (zero writes) when an interface was relabelled at one site", async () => {
    const h = await signIn();
    const snaps = await snapshots(h);
    const { wc } = stageWebRule(createWorkingCopy(buildSharedView(inputs(snaps)).baseline));
    mocks.mucA!.state().interfaces.find((i) => i.key === "opt2")!.descr = "GUEST2";
    const res = (await app.inject({ method: "POST", url: "/api/shared/apply", headers: h.headers, payload: body(wc, snaps, { confirm: true }) })).json().result;
    expect(res.outcome).toBe("blocked");
    expect(res.plans[1].reasons.join(" ")).toMatch(/labelled "GUEST2"/);
    expect(mocks.berA!.history().length).toBe(0);
    expect(mocks.mucA!.history().length).toBe(0);
  });

  it("refuses to write to a 'primary' that has no HA sync target", async () => {
    const h = await signIn();
    const snaps = await snapshots(h);
    const { wc } = stageWebRule(createWorkingCopy(buildSharedView(inputs(snaps)).baseline));
    // As if the topology pointed at the secondary: that node has no sync target.
    mocks.berA!.linkSecondary(null);
    const res = (await app.inject({ method: "POST", url: "/api/shared/preflight", headers: h.headers, payload: body(wc, snaps) })).json().plans;
    expect(res[0].status).toBe("blocked");
    expect(res[0].reasons.join(" ")).toMatch(/no HA sync target/);
  });
});
