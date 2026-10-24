import { describe, expect, it } from "vitest";
import { computeChangeSet, formatChangeSet, ruleStatus } from "./diff.ts";
import { addAlias, addRule, cloneRule, createWorkingCopy, deleteRules, moveRule, undo, updateRule } from "./working-copy.ts";
import { rule, snapshot } from "./test-fixtures.ts";

const base = () =>
  createWorkingCopy(
    snapshot([
      rule("r1", { description: "Allow HTTPS to web servers", protocol: "TCP" }),
      rule("r2", { description: "second" }),
      rule("r3", { description: "third" }),
    ]),
  );

describe("change sets", () => {
  it("is empty without edits", () => {
    expect(computeChangeSet(base()).changes).toEqual([]);
  });

  it("produces the project-book example", () => {
    let wc = base();
    const created = addAlias(wc, {
      name: "WEB_SERVERS",
      type: "network",
      enabled: true,
      entries: ["192.168.1.10", "192.168.1.11"],
      description: "",
      categories: [],
      extra: {},
    });
    wc = updateRule(created.wc, "r1", {
      destination: { negate: false, items: [{ kind: "alias", name: "WEB_SERVERS" }] },
      destinationPort: { kind: "literal", value: "HTTPS" },
    });
    const set = computeChangeSet(wc);
    expect(set.counts).toEqual({ create: 1, modify: 1, delete: 0, reorder: 0 });
    expect(formatChangeSet(set)).toBe(
      [
        "CREATE  Alias: WEB_SERVERS",
        "  Type: network",
        "  Entries:",
        "    + 192.168.1.10",
        "    + 192.168.1.11",
        "",
        "MODIFY  Rule: Allow HTTPS to web servers",
        "  Destination: any -> WEB_SERVERS",
        "  Port:        any -> HTTPS",
        "",
        "APPLY   Firewall configuration",
      ].join("\n"),
    );
  });

  it("treats edit-then-revert as unchanged", () => {
    let wc = updateRule(base(), "r1", { action: "block" });
    wc = updateRule(wc, "r1", { action: "pass" });
    expect(computeChangeSet(wc).changes).toEqual([]);
    expect(ruleStatus(wc, wc.current.rules[0]!)).toBe("unchanged");
  });

  it("reports clones as creates and deletes as deletes", () => {
    let { wc } = cloneRule(base(), "r2");
    wc = deleteRules(wc, ["r3"]);
    const kinds = computeChangeSet(wc).changes.map((c) => `${c.kind}:${c.id}`);
    expect(kinds).toEqual(["create:new:1", "delete:r3"]);
  });

  it("does not report inserting a new rule as a reorder of others", () => {
    const { wc } = addRule(base(), { afterId: "r1" });
    expect(computeChangeSet(wc).counts.reorder).toBe(0);
  });

  it("reports the minimal set of moved rules", () => {
    const wc = moveRule(base(), "r3", "r1");
    const set = computeChangeSet(wc);
    expect(set.changes).toEqual([
      {
        kind: "reorder",
        objectType: "rule",
        id: "r3",
        label: "third",
        fields: [{ field: "position", label: "Position", before: "3", after: "1" }],
      },
    ]);
  });

  it("returns to empty after undo", () => {
    const wc = undo(updateRule(base(), "r2", { log: true }));
    expect(computeChangeSet(wc).changes).toEqual([]);
  });
});
