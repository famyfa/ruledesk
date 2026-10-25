import { describe, expect, it } from "vitest";
import { applySyncPlan, planSync } from "./sync.ts";
import { computeChangeSet } from "./diff.ts";
import { createWorkingCopy } from "./working-copy.ts";
import { alias, rule, snapshot } from "./test-fixtures.ts";

const web = { kind: "alias", name: "WEB" } as const;
const src = () =>
  snapshot(
    [
      rule("s1", { description: "Allow web", destination: { negate: false, items: [web] }, destinationPort: { kind: "literal", value: "443" } }),
      rule("s2", { description: "Block rest", action: "block" }),
    ],
    [alias("a1", "WEB", { entries: ["10.1.0.0/16"] }), alias("a2", "GROUP", { type: "networkgroup", entries: ["WEB"] })],
  );

describe("sync", () => {
  it("creates missing aliases and rules at the target, bringing needed aliases along", () => {
    const s = src();
    const target = createWorkingCopy(snapshot([], []));
    const plan = planSync(s, target, { ruleIds: ["s1", "s2"], aliasIds: [] });
    expect(plan.items.map((i) => `${i.objectType}:${i.label}:${i.kind}${i.dependency ? ":dep" : ""}`)).toEqual([
      "alias:WEB:create:dep",
      "rule:Allow web:create",
      "rule:Block rest:create",
    ]);
    const wc = applySyncPlan(target, plan, s.rules);
    expect(wc.current.aliases.map((a) => a.name)).toEqual(["WEB"]);
    expect(wc.current.rules.map((r) => r.description)).toEqual(["Allow web", "Block rest"]);
    expect(computeChangeSet(wc).counts).toMatchObject({ create: 3 });
    expect(wc.past.length).toBe(1); // one undo step
  });

  it("nested aliases are created before the alias that uses them", () => {
    const s = src();
    const plan = planSync(s, createWorkingCopy(snapshot([], [])), { ruleIds: [], aliasIds: ["a2"] });
    expect(plan.items.map((i) => i.label)).toEqual(["WEB", "GROUP"]);
    const wc = applySyncPlan(createWorkingCopy(snapshot([], [])), plan, s.rules);
    expect(wc.current.aliases.map((a) => a.name)).toEqual(["WEB", "GROUP"]);
  });

  it("matches by name/description and updates only what differs", () => {
    const s = src();
    const target = createWorkingCopy(
      snapshot(
        [rule("t9", { description: "Allow web", destination: { negate: false, items: [web] }, destinationPort: { kind: "literal", value: "80" }, categories: ["cat-local"] })],
        [alias("b1", "WEB", { entries: ["10.9.0.0/16"], categories: ["cat-local"] })],
      ),
    );
    const plan = planSync(s, target, { ruleIds: ["s1"], aliasIds: ["a1"] });
    expect(plan.items.find((i) => i.objectType === "rule")).toMatchObject({ kind: "update", targetId: "t9" });
    expect(plan.items.find((i) => i.objectType === "alias")).toMatchObject({ kind: "update", targetId: "b1" });
    const wc = applySyncPlan(target, plan, s.rules);
    expect(wc.current.aliases[0]).toMatchObject({ entries: ["10.1.0.0/16"], categories: ["cat-local"] }); // categories stay local
    expect(wc.current.rules[0]).toMatchObject({ id: "t9", destinationPort: { kind: "literal", value: "443" }, categories: ["cat-local"] });
    expect(computeChangeSet(wc).counts).toMatchObject({ modify: 2, create: 0 });
  });

  it("reports identical objects as same and stages nothing", () => {
    const s = src();
    const target = createWorkingCopy(snapshot([rule("t1", { description: "Block rest", action: "block" })], []));
    const plan = planSync(s, target, { ruleIds: ["s2"], aliasIds: [] });
    expect(plan.items[0]!.kind).toBe("same");
    expect(applySyncPlan(target, plan, s.rules)).toBe(target);
  });

  it("warns when an alias used by a rule differs at the target, without changing it", () => {
    const s = src();
    const target = createWorkingCopy(snapshot([], [alias("b1", "WEB", { entries: ["10.9.0.0/16"] })]));
    const plan = planSync(s, target, { ruleIds: ["s1"], aliasIds: [] });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.warnings[0]).toMatch(/WEB differs/);
    expect(applySyncPlan(target, plan, s.rules).current.aliases[0]!.entries).toEqual(["10.9.0.0/16"]);
  });

  it("blocks rules that can't be translated, are ambiguous, or are site-specific", () => {
    const s = src();
    s.rules.push(rule("s3", { description: "Via gateway", extra: { gateway: "WAN_GW" } }));
    s.rules.push(rule("s4", { description: "On DMZ", interfaces: ["opt9"] }));
    s.options.interfaces.push({ key: "opt9", label: "DMZ", kind: "interface" });
    s.rules.push(rule("s5", { description: "Dup" }));
    const target = createWorkingCopy(snapshot([rule("t1", { description: "Dup" }), rule("t2", { description: "Dup" })], []));
    const plan = planSync(s, target, { ruleIds: ["s3", "s4", "s5"], aliasIds: [] });
    expect(plan.items.map((i) => i.kind)).toEqual(["blocked", "blocked", "blocked"]);
    expect(plan.items[0]!.reasons[0]).toMatch(/gateway/);
    expect(plan.items[1]!.reasons[0]).toMatch(/DMZ/);
    expect(plan.items[2]!.reasons[0]).toMatch(/2 rules named/);
    expect(applySyncPlan(target, plan, s.rules)).toBe(target);
  });

  it("translates interfaces by label when keys differ", () => {
    const s = src();
    s.options.interfaces.push({ key: "opt1", label: "DMZ", kind: "interface" });
    s.rules.push(rule("s6", { description: "DMZ out", interfaces: ["opt1"] }));
    const t = snapshot([], []);
    t.options.interfaces.push({ key: "opt3", label: "DMZ", kind: "interface" });
    const plan = planSync(s, createWorkingCopy(t), { ruleIds: ["s6"], aliasIds: [] });
    expect((plan.items[0]!.desired as { interfaces: string[] }).interfaces).toEqual(["opt3"]);
  });

  it("new rules go below the counterpart of the rule above them", () => {
    const s = src();
    const target = createWorkingCopy(snapshot([rule("t1", { description: "Allow web", destination: { negate: false, items: [web] }, destinationPort: { kind: "literal", value: "443" } }), rule("t2", { description: "Other" })], [alias("b1", "WEB")]));
    const plan = planSync(s, target, { ruleIds: ["s1", "s2"], aliasIds: [] });
    const wc = applySyncPlan(target, plan, s.rules);
    expect(wc.current.rules.map((r) => r.description)).toEqual(["Allow web", "Block rest", "Other"]);
  });

  it("refuses alias types that depend on the firewall", () => {
    const s = snapshot([], [alias("a9", "IFACES", { type: "internal" })]);
    const plan = planSync(s, createWorkingCopy(snapshot([], [])), { ruleIds: [], aliasIds: ["a9"] });
    expect(plan.items[0]!.kind).toBe("blocked");
  });
});
