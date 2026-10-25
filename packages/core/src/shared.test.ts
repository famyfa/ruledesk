import { describe, expect, it } from "vitest";
import type { Alias, FirewallRule, FirewallSnapshot } from "./domain.ts";
import {
  aliasShareProblems,
  buildSharedView,
  canonicalizeRule,
  interfaceGuards,
  localizeRule,
  MappingError,
  projectToSite,
  ruleShareProblems,
  SHARED_CATEGORY_UUID as M,
  sharedStateMatches,
  uuidOfLocalId,
  type SiteInput,
} from "./shared.ts";
import { addRule, createWorkingCopy, deleteRules, moveRule, updateRule } from "./working-copy.ts";
import { rule } from "./test-fixtures.ts";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const UA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const maps = {
  ber: { LAN: { key: "lan", label: "LAN" }, DMZ: { key: "opt1", label: "DMZ" } },
  muc: { LAN: { key: "lan", label: "LAN" }, DMZ: { key: "opt2", label: "DMZ" } },
};

const ifaces = (dmzKey: string) => [
  { key: "lan", label: "LAN", kind: "interface" as const },
  { key: "wan", label: "WAN", kind: "interface" as const },
  { key: dmzKey, label: "DMZ", kind: "interface" as const },
];

const dmzRule = (id: string, iface: string, patch: Partial<FirewallRule> = {}): FirewallRule =>
  rule(id, { interfaces: [iface], description: `rule ${id.slice(0, 2)}`, categories: [M], destination: { negate: false, items: [{ kind: "interfaceNet", iface }] }, ...patch });

const webAlias = (patch: Partial<Alias> = {}): Alias => ({
  id: UA, name: "WEB", type: "host", enabled: true, entries: ["10.0.0.1"], description: "", categories: [M], extra: {}, ...patch,
});

function snap(id: string, dmzKey: string, rules: FirewallRule[], aliases: Alias[] = []): FirewallSnapshot {
  return {
    firewallId: id,
    loadedAt: "2026-10-24T00:00:00Z",
    rules,
    aliases,
    options: { interfaces: ifaces(dmzKey), aliasTypes: [{ value: "host", label: "Host(s)" }, { value: "network", label: "Network(s)" }], protocols: ["any", "TCP"], wellKnownPorts: [] },
    fingerprints: {},
  };
}

function sites(berRules: FirewallRule[], mucRules: FirewallRule[], berAliases = [webAlias()], mucAliases = [webAlias()]): SiteInput[] {
  return [
    { siteId: "ber", siteName: "Berlin", map: maps.ber, snapshot: snap("ber", "opt1", berRules, berAliases) },
    { siteId: "muc", siteName: "Munich", map: maps.muc, snapshot: snap("muc", "opt2", mucRules, mucAliases) },
  ];
}

describe("interface translation", () => {
  it("round-trips logical <-> physical per site", () => {
    const physical = dmzRule(U1, "opt1");
    const logical = canonicalizeRule(physical, maps.ber, "ber");
    expect(logical.interfaces).toEqual(["DMZ"]);
    expect(logical.destination.items).toEqual([{ kind: "interfaceNet", iface: "DMZ" }]);
    const atMuc = localizeRule(logical, maps.muc, "muc");
    expect(atMuc.interfaces).toEqual(["opt2"]);
    expect(atMuc.destination.items).toEqual([{ kind: "interfaceNet", iface: "opt2" }]);
  });

  it("refuses unmapped interfaces instead of dropping them", () => {
    expect(() => canonicalizeRule(dmzRule(U1, "wan"), maps.ber, "ber")).toThrow(MappingError);
    expect(() => localizeRule({ ...dmzRule(U1, "opt1"), interfaces: ["GUEST"] }, maps.ber, "ber")).toThrow(/no mapping/);
  });

  it("checks the live label so a re-assigned interface isn't used blindly", () => {
    expect(interfaceGuards(maps.ber, ifaces("opt1"))).toEqual([]);
    const relabelled = ifaces("opt1").map((i) => (i.key === "opt1" ? { ...i, label: "GUEST" } : i));
    expect(interfaceGuards(maps.ber, relabelled)[0]).toMatch(/labelled "GUEST".*expects "DMZ"/);
    expect(interfaceGuards({ ...maps.ber, X: { key: "opt9", label: "X" } }, ifaces("opt1"))[0]).toMatch(/doesn't exist/);
  });
});

describe("share eligibility", () => {
  it("rejects site-specific fields, nosync and non-shared aliases", () => {
    expect(ruleShareProblems(dmzRule(U1, "DMZ"), new Set())).toEqual([]);
    expect(ruleShareProblems({ ...dmzRule(U1, "DMZ"), extra: { gateway: "WAN_GW" } }, new Set())[0]).toMatch(/gateway/);
    expect(ruleShareProblems({ ...dmzRule(U1, "DMZ"), extra: { nosync: "1" } }, new Set())[0]).toMatch(/sync/);
    const usesAlias = { ...dmzRule(U1, "DMZ"), source: { negate: false, items: [{ kind: "alias" as const, name: "LOCAL" }] } };
    expect(ruleShareProblems(usesAlias, new Set(["WEB"]))[0]).toMatch(/LOCAL/);
    expect(aliasShareProblems(webAlias({ type: "networkgroup" }), new Set(), new Set())[0]).toMatch(/can't be shared/);
    expect(aliasShareProblems(webAlias({ entries: ["OTHER"] }), new Set(), new Set(["OTHER"]))[0]).toMatch(/OTHER/);
  });

  it("extracts the uuid of new shared objects", () => {
    expect(uuidOfLocalId(`new:${U1}`)).toBe(U1);
    expect(uuidOfLocalId("new:1")).toBeNull();
  });
});

describe("shared view and drift", () => {
  it("builds a logical baseline when sites agree", () => {
    const v = buildSharedView(sites([dmzRule(U1, "opt1")], [dmzRule(U1, "opt2")]));
    expect(v.drift).toEqual([]);
    expect(v.baseline.rules.map((r) => r.interfaces)).toEqual([["DMZ"]]);
    expect(v.baseline.aliases.map((a) => a.name)).toEqual(["WEB"]);
    expect(v.baseline.options.interfaces.map((i) => i.key)).toEqual(["LAN", "DMZ"]);
  });

  it("reports missing, differing and unmappable objects", () => {
    const v = buildSharedView(
      sites(
        [dmzRule(U1, "opt1"), dmzRule(U2, "opt1"), rule("33333333-3333-4333-8333-333333333333", { interfaces: ["wan"], categories: [M] })],
        [dmzRule(U1, "opt2", { action: "block" })],
        [webAlias()],
        [webAlias({ entries: ["10.0.0.2"] })],
      ),
    );
    const kinds = v.drift.map((d) => `${d.kind}:${d.objectType}`).sort();
    expect(kinds).toEqual(["differs:alias", "differs:rule", "missing:rule", "unmappable:rule"]);
    const differs = v.drift.find((d) => d.kind === "differs" && d.objectType === "rule")!;
    expect(differs.sites.muc).toEqual([{ field: "action", label: "Action", before: "pass", after: "block" }]);
  });

  it("calls out a present-but-unmarked copy", () => {
    const v = buildSharedView(sites([dmzRule(U1, "opt1")], [dmzRule(U1, "opt2", { categories: [] })]));
    expect(v.drift[0]!.sites.muc).toBe("present but not marked shared");
  });

  it("blocks a site whose interface labels don't match the topology", () => {
    const s = sites([dmzRule(U1, "opt1")], [dmzRule(U1, "opt2")]);
    s[1]!.snapshot.options.interfaces = ifaces("opt2").map((i) => (i.key === "opt2" ? { ...i, label: "GUEST" } : i));
    expect(Object.keys(buildSharedView(s).blockedSites)).toEqual(["muc"]);
  });
});

describe("projection to each site", () => {
  const local = (id: string, iface: string, desc: string) => rule(id, { interfaces: [iface], description: desc });

  function setup() {
    const s = sites(
      [local("lb1", "opt1", "ber local 1"), dmzRule(U1, "opt1"), local("lb2", "opt1", "ber local 2")],
      [dmzRule(U1, "opt2"), local("lm1", "opt2", "muc local")],
    );
    const shared = createWorkingCopy(buildSharedView(s).baseline);
    return { s, shared };
  }

  it("edits a shared rule in place at every site, with that site's interface", () => {
    const { s, shared } = setup();
    const wc = updateRule(shared, U1, { log: true });
    const ber = projectToSite(s[0]!, wc);
    const muc = projectToSite(s[1]!, wc);
    expect(ber.errors).toEqual([]);
    expect(ber.wc.current.rules.map((r) => r.id)).toEqual(["lb1", U1, "lb2"]);
    expect(ber.wc.current.rules[1]!.log).toBe(true);
    expect(ber.wc.current.rules[1]!.interfaces).toEqual(["opt1"]);
    expect(muc.wc.current.rules[0]!.interfaces).toEqual(["opt2"]);
    expect(muc.wc.current.rules[0]!.log).toBe(true);
    // untouched local rules keep their identity (no spurious writes)
    expect(ber.wc.current.rules[0]).toBe(s[0]!.snapshot.rules[0]);
  });

  it("creates a new shared rule with the same uuid everywhere, right after its shared predecessor", () => {
    const { s, shared } = setup();
    const { wc, id } = addRule(shared, { afterId: U1, patch: { description: "new shared", interfaces: ["DMZ"], categories: [M] } });
    const uuid = uuidOfLocalId(id)!;
    const ber = projectToSite(s[0]!, wc);
    const muc = projectToSite(s[1]!, wc);
    expect(ber.wc.current.rules.map((r) => r.id)).toEqual(["lb1", U1, `new:${uuid}`, "lb2"]);
    expect(muc.wc.current.rules.map((r) => r.id)).toEqual([U1, `new:${uuid}`, "lm1"]);
    expect(muc.wc.current.rules[1]!.interfaces).toEqual(["opt2"]);
    expect(muc.wc.current.rules[1]!.categories).toEqual([M]);
  });

  it("puts the first shared rule of a group at the top, before local rules", () => {
    const s = sites([local("lb1", "opt1", "ber local")], [local("lm1", "opt2", "muc local")], [], []);
    const shared = createWorkingCopy(buildSharedView(s).baseline);
    const { wc } = addRule(shared, { patch: { description: "first shared", interfaces: ["DMZ"], categories: [M] } });
    const ber = projectToSite(s[0]!, wc);
    expect(ber.wc.current.rules.map((r) => r.description)).toEqual(["first shared", "ber local"]);
    expect(ber.notes[0]).toMatch(/top of its group/);
  });

  it("deletes a shared rule everywhere and leaves local rules alone", () => {
    const { s, shared } = setup();
    const wc = deleteRules(shared, [U1]);
    expect(projectToSite(s[0]!, wc).wc.current.rules.map((r) => r.id)).toEqual(["lb1", "lb2"]);
    expect(projectToSite(s[1]!, wc).wc.current.rules.map((r) => r.id)).toEqual(["lm1"]);
  });

  it("keeps the shared order across sites without moving local rules", () => {
    const s = sites(
      [dmzRule(U1, "opt1"), local("lb1", "opt1", "ber local"), dmzRule(U2, "opt1")],
      [dmzRule(U1, "opt2"), dmzRule(U2, "opt2"), local("lm1", "opt2", "muc local")],
    );
    const shared = createWorkingCopy(buildSharedView(s).baseline);
    const wc = moveRule(shared, U2, U1);
    expect(projectToSite(s[0]!, wc).wc.current.rules.map((r) => r.id)).toEqual([U2, "lb1", U1]);
    expect(projectToSite(s[1]!, wc).wc.current.rules.map((r) => r.id)).toEqual([U2, U1, "lm1"]);
  });

  it("refuses a site where a logical interface isn't mapped", () => {
    const { s, shared } = setup();
    const { wc } = addRule(shared, { patch: { description: "x", interfaces: ["GUEST"], categories: [M] } });
    expect(projectToSite(s[0]!, wc).errors.join()).toMatch(/GUEST/);
  });

  it("verifies the result against the shared state", () => {
    const { s, shared } = setup();
    const wc = updateRule(shared, U1, { log: true });
    expect(sharedStateMatches(s[0]!, wc.current, [U1])[0]).toMatch(/Rule "rule 11" differs: Logging yes → no/);
    const after = { ...s[0]!, snapshot: { ...s[0]!.snapshot, rules: projectToSite(s[0]!, wc).wc.current.rules } };
    expect(sharedStateMatches(after, wc.current, [U1])).toEqual([]);
  });
});
