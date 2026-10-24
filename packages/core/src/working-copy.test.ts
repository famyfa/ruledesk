import { describe, expect, it } from "vitest";
import {
  addAlias,
  addRule,
  canRedo,
  canUndo,
  cloneRule,
  createWorkingCopy,
  deleteAlias,
  deleteRules,
  findAliasReferences,
  moveRule,
  nudgeRule,
  redo,
  undo,
  updateAlias,
  updateRule,
  updateRules,
  WorkingCopyError,
} from "./working-copy.ts";
import { alias, rule, snapshot } from "./test-fixtures.ts";

const base = () =>
  createWorkingCopy(
    snapshot(
      [
        rule("r1", { description: "first" }),
        rule("r2", { description: "second", destination: { negate: false, items: [{ kind: "alias", name: "SRV" }] } }),
        rule("r3", { description: "third" }),
        rule("f1", { description: "floating", prioGroup: "200000", interfaces: [] }),
        rule("L1", { description: "legacy", origin: "legacy" }),
      ],
      [alias("a1", "SRV")],
    ),
  );

describe("working copy edits", () => {
  it("updates a rule without touching the baseline", () => {
    const wc = updateRule(base(), "r1", { action: "block" });
    expect(wc.current.rules[0]?.action).toBe("block");
    expect(wc.baseline.rules[0]?.action).toBe("pass");
  });

  it("refuses to edit read-only legacy rules", () => {
    expect(() => updateRule(base(), "L1", { action: "block" })).toThrow(WorkingCopyError);
  });

  it("bulk-updates several rules", () => {
    const wc = updateRules(base(), ["r1", "r3"], { log: true });
    expect(wc.current.rules.filter((r) => r.log).map((r) => r.id)).toEqual(["r1", "r3"]);
  });

  it("rejects a bulk edit that includes a legacy rule", () => {
    expect(() => updateRules(base(), ["r1", "L1"], { log: true })).toThrow(WorkingCopyError);
  });

  it("adds a new rule after an anchor with a local id", () => {
    const { wc, id } = addRule(base(), { afterId: "r1" });
    expect(id).toBe("new:1");
    expect(wc.current.rules.map((r) => r.id).slice(0, 3)).toEqual(["r1", "new:1", "r2"]);
    expect(wc.current.rules[1]?.prioGroup).toBe("400000.lan");
  });

  it("clones a rule directly below the original with a new identity", () => {
    const { wc, id } = cloneRule(base(), "r2");
    const ids = wc.current.rules.map((r) => r.id);
    expect(ids.indexOf(id)).toBe(ids.indexOf("r2") + 1);
    const clone = wc.current.rules.find((r) => r.id === id)!;
    expect(clone.description).toBe("second");
    expect(clone.destination).toEqual(wc.current.rules.find((r) => r.id === "r2")!.destination);
    expect(clone.destination).not.toBe(wc.current.rules.find((r) => r.id === "r2")!.destination);
  });

  it("deletes rules", () => {
    const wc = deleteRules(base(), ["r1"]);
    expect(wc.current.rules.map((r) => r.id)).not.toContain("r1");
  });
});

describe("ordering", () => {
  it("moves a rule before another in the same group", () => {
    const wc = moveRule(base(), "r3", "r1");
    expect(wc.current.rules.map((r) => r.id).slice(0, 3)).toEqual(["r3", "r1", "r2"]);
  });

  it("refuses cross-group moves", () => {
    expect(() => moveRule(base(), "f1", "r1")).toThrow(/same group/);
  });

  it("moves to the end of its group with null", () => {
    const wc = moveRule(base(), "r1", null);
    expect(wc.current.rules.map((r) => r.id)).toEqual(["r2", "r3", "r1", "f1", "L1"]);
  });

  it("nudges up and down with the keyboard", () => {
    let wc = nudgeRule(base(), "r2", -1);
    expect(wc.current.rules.map((r) => r.id).slice(0, 3)).toEqual(["r2", "r1", "r3"]);
    wc = nudgeRule(wc, "r2", 1);
    expect(wc.current.rules.map((r) => r.id).slice(0, 3)).toEqual(["r1", "r2", "r3"]);
    expect(nudgeRule(wc, "r1", -1)).toBe(wc); // already first
  });
});

describe("undo / redo", () => {
  it("walks back and forth through history", () => {
    let wc = base();
    expect(canUndo(wc)).toBe(false);
    wc = updateRule(wc, "r1", { action: "block" });
    wc = updateRule(wc, "r1", { action: "reject" });
    expect(wc.current.rules[0]?.action).toBe("reject");
    wc = undo(wc);
    expect(wc.current.rules[0]?.action).toBe("block");
    wc = undo(wc);
    expect(wc.current.rules[0]?.action).toBe("pass");
    expect(canUndo(wc)).toBe(false);
    wc = redo(wc);
    expect(wc.current.rules[0]?.action).toBe("block");
    expect(canRedo(wc)).toBe(true);
  });

  it("clears redo after a new edit", () => {
    let wc = updateRule(base(), "r1", { action: "block" });
    wc = undo(wc);
    wc = updateRule(wc, "r1", { log: true });
    expect(canRedo(wc)).toBe(false);
  });

  it("undoes alias creation together with nothing else", () => {
    const { wc } = addAlias(base(), { name: "NEW", type: "host", enabled: true, entries: ["1.1.1.1"], description: "", categories: [], extra: {} });
    expect(undo(wc).current.aliases.map((a) => a.name)).toEqual(["SRV"]);
  });
});

describe("aliases", () => {
  it("adds an alias that is immediately visible", () => {
    const { wc, id } = addAlias(base(), { name: "WEB_SERVERS", type: "host", enabled: true, entries: ["192.168.1.10"], description: "", categories: [], extra: {} });
    expect(id).toMatch(/^new:/);
    expect(wc.current.aliases.map((a) => a.name)).toContain("WEB_SERVERS");
  });

  it("rejects duplicate names", () => {
    expect(() => addAlias(base(), { ...alias("x", "SRV"), id: undefined } as never)).toThrow(/already exists/);
  });

  it("propagates renames to rule references", () => {
    const wc = updateAlias(base(), "a1", { name: "SERVERS" });
    const r2 = wc.current.rules.find((r) => r.id === "r2")!;
    expect(r2.destination.items).toEqual([{ kind: "alias", name: "SERVERS" }]);
    // untouched rules keep identity (no false "modified")
    expect(wc.current.rules[0]).toBe(wc.baseline.rules[0]);
  });

  it("finds references", () => {
    const refs = findAliasReferences(base().current, "SRV");
    expect(refs.rules).toEqual([{ ruleId: "r2", ruleLabel: "second", fields: ["destination"] }]);
  });

  it("refuses to delete referenced aliases without acknowledgement", () => {
    expect(() => deleteAlias(base(), "a1")).toThrow(/used by 1 rule/);
    const wc = deleteAlias(base(), "a1", { acknowledgeReferences: true });
    expect(wc.current.aliases).toHaveLength(0);
    // The rule still points at the (now missing) alias; it did not become "any".
    expect(wc.current.rules.find((r) => r.id === "r2")!.destination.items).toHaveLength(1);
  });
});
