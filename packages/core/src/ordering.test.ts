import { describe, expect, it } from "vitest";
import { derivePrioGroup, planGroupSequences, planOrdering } from "./ordering.ts";
import { addRule, createWorkingCopy, moveRule, updateRule } from "./working-copy.ts";
import { rule, snapshot } from "./test-fixtures.ts";

const ifaces = [
  { key: "lan", label: "LAN", kind: "interface" as const },
  { key: "wan", label: "WAN", kind: "interface" as const },
  { key: "grp", label: "GRP", kind: "group" as const },
];

describe("derivePrioGroup", () => {
  it("follows OPNsense's priority rules", () => {
    expect(derivePrioGroup({ interfaces: [], interfaceNot: false }, ifaces)).toBe("200000");
    expect(derivePrioGroup({ interfaces: ["lan", "wan"], interfaceNot: false }, ifaces)).toBe("200000");
    expect(derivePrioGroup({ interfaces: ["lan"], interfaceNot: true }, ifaces)).toBe("200000");
    expect(derivePrioGroup({ interfaces: ["lan"], interfaceNot: false }, ifaces)).toBe("400000");
    expect(derivePrioGroup({ interfaces: ["grp"], interfaceNot: false }, ifaces, new Map([["grp", "300005"]]))).toBe("300005");
    expect(derivePrioGroup({ interfaces: ["nope"], interfaceNot: false }, ifaces)).toBe("600000");
  });
});

describe("planGroupSequences", () => {
  it("changes nothing when already ordered", () => {
    expect(planGroupSequences([{ id: "a", sequence: 10 }, { id: "b", sequence: 20 }]).size).toBe(0);
  });

  it("moves one rule into the gap", () => {
    const plan = planGroupSequences([{ id: "c", sequence: 30 }, { id: "a", sequence: 10 }, { id: "b", sequence: 20 }]);
    expect([...plan.keys()]).toEqual(["c"]);
    expect(plan.get("c")!).toBeLessThan(10);
    expect(plan.get("c")!).toBeGreaterThanOrEqual(1);
  });

  it("places new rules between neighbours", () => {
    const plan = planGroupSequences([
      { id: "a", sequence: 100 },
      { id: "n1", sequence: null },
      { id: "n2", sequence: null },
      { id: "b", sequence: 200 },
    ]);
    expect(plan.size).toBe(2);
    const x = plan.get("n1")!;
    const y = plan.get("n2")!;
    expect(100 < x && x < y && y < 200).toBe(true);
  });

  it("appends after the last rule", () => {
    expect(planGroupSequences([{ id: "a", sequence: 100 }, { id: "n", sequence: null }]).get("n")).toBe(200);
  });

  it("renumbers when there's no room", () => {
    const plan = planGroupSequences([{ id: "a", sequence: 1 }, { id: "n", sequence: null }, { id: "b", sequence: 2 }]);
    expect(plan.get("a")).toBe(100);
    expect(plan.get("n")).toBe(200);
    expect(plan.get("b")).toBe(300);
  });

  it("always produces strictly increasing numbers", () => {
    const items = [5, 3, null, 3, 9, null, 1].map((s, i) => ({ id: `r${i}`, sequence: s }));
    const plan = planGroupSequences(items);
    const final = items.map((i) => plan.get(i.id) ?? i.sequence!);
    for (let i = 1; i < final.length; i++) expect(final[i]!).toBeGreaterThan(final[i - 1]!);
  });
});

describe("planOrdering", () => {
  const base = () =>
    createWorkingCopy(
      snapshot([
        rule("f1", { prioGroup: "200000", interfaces: [], sequence: 10 }),
        rule("a", { sequence: 100 }),
        rule("b", { sequence: 200 }),
        rule("c", { sequence: 300 }),
      ]),
    );

  it("plans nothing without order changes", () => {
    const wc = updateRule(base(), "a", { log: true });
    expect(planOrdering(wc.baseline.rules, wc.current.rules).size).toBe(0);
  });

  it("plans only the moved rule", () => {
    const wc = moveRule(base(), "c", "a");
    const plan = planOrdering(wc.baseline.rules, wc.current.rules);
    expect([...plan.keys()]).toEqual(["c"]);
    expect(plan.get("c")!).toBeLessThan(100);
  });

  it("gives new rules a sequence in their group", () => {
    const { wc, id } = addRule(base(), { afterId: "a" });
    expect(planOrdering(wc.baseline.rules, wc.current.rules).get(id)).toBe(150);
  });

  it("moves a rule to another group when its interfaces change", () => {
    const wc = updateRule(base(), "f1", { interfaces: ["lan"] });
    expect(wc.current.rules.map((r) => r.id)).toEqual(["a", "b", "c", "f1"]);
    expect(planOrdering(wc.baseline.rules, wc.current.rules).get("f1")).toBe(400);
  });
});
