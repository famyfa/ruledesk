import { describe, expect, it } from "vitest";
import { rebase } from "./rebase.ts";
import { lockoutWarnings } from "./risk.ts";
import { addAlias, addRule, createWorkingCopy, deleteRules, moveRule, updateRule } from "./working-copy.ts";
import { alias, rule, snapshot } from "./test-fixtures.ts";

describe("rebase", () => {
  const base = snapshot([rule("a", { description: "A" }), rule("b", { description: "B" }), rule("c", { description: "C" })], [alias("x", "NETS")]);

  it("replays field edits on top of the fresh version", () => {
    const wc = updateRule(createWorkingCopy(base), "a", { log: true });
    const fresh = snapshot(
      [rule("a", { description: "A (edited elsewhere)" }), rule("b", { description: "B" }), rule("c", { description: "C" })],
      [alias("x", "NETS")],
    );
    const r = rebase(wc, fresh);
    const a = r.wc.current.rules.find((x) => x.id === "a")!;
    expect(a.log).toBe(true);
    expect(a.description).toBe("A (edited elsewhere)");
    expect(r.notes).toEqual([]);
    expect(r.wc.baseline).toBe(fresh);
  });

  it("keeps local creations near their anchor and reports dropped edits", () => {
    const added = addRule(createWorkingCopy(base), { afterId: "b", patch: { description: "NEW" } });
    let wc = updateRule(added.wc, "c", { log: true });
    wc = addAlias(wc, { name: "WEB", type: "host", enabled: true, entries: ["1.1.1.1"], description: "", categories: [], extra: {} }).wc;
    const fresh = snapshot([rule("a"), rule("b")], [alias("x", "NETS"), alias("y", "WEB")]);
    const r = rebase(wc, fresh);
    expect(r.wc.current.rules.map((x) => x.id)).toEqual(["a", "b", added.id]);
    expect(r.notes.join(" ")).toMatch(/rule "C" was dropped/);
    expect(r.notes.join(" ")).toMatch(/New alias WEB was not kept/);
  });

  it("turns a create that already landed (earlier partial apply) into an update, not a duplicate", () => {
    const added = addRule(createWorkingCopy(base), { afterId: "b", patch: { description: "NEW", log: true } });
    const uuid = added.id.slice(4);
    const fresh = snapshot([rule("a"), rule("b"), rule(uuid, { description: "NEW" }), rule("c")], [alias("x", "NETS")]);
    const r = rebase(added.wc, fresh);
    expect(r.wc.current.rules.map((x) => x.id)).toEqual(["a", "b", uuid, "c"]);
    expect(r.wc.current.rules[2]!.log).toBe(true);
  });

  it("keeps local deletes and reports moves", () => {
    let wc = deleteRules(createWorkingCopy(base), ["a"]);
    wc = moveRule(wc, "c", "b");
    const r = rebase(wc, base);
    expect(r.wc.current.rules.map((x) => x.id)).toEqual(["b", "c"]);
    expect(r.notes.join(" ")).toMatch(/moves were not carried over/);
  });
});

describe("lockout warnings", () => {
  const mgmt = rule("m", {
    description: "Admin GUI",
    protocol: "TCP",
    destination: { negate: false, items: [{ kind: "self" }] },
    destinationPort: { kind: "literal", value: "443" },
  });
  const other = rule("o", {
    description: "Web",
    protocol: "TCP",
    destination: { negate: false, items: [{ kind: "literal", value: "10.0.0.5" }] },
    destinationPort: { kind: "literal", value: "443" },
  });
  const wc0 = () => createWorkingCopy(snapshot([mgmt, other]));

  it("is quiet for unrelated changes", () => {
    expect(lockoutWarnings(updateRule(wc0(), "o", { log: true }))).toEqual([]);
  });

  it("warns when a management allow rule is disabled or deleted", () => {
    expect(lockoutWarnings(updateRule(wc0(), "m", { enabled: false }))).toHaveLength(1);
    expect(lockoutWarnings(deleteRules(wc0(), ["m"]))[0]!.message).toMatch(/Deletes a rule/);
  });

  it("warns about new block rules that hit the firewall", () => {
    const { wc } = addRule(wc0(), { afterId: "m", patch: { action: "block", description: "block all" } });
    expect(lockoutWarnings(wc).map((w) => w.label)).toContain("block all");
  });
});
