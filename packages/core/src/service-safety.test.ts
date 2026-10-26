import { afterEach, describe, expect, it } from "vitest";
import { flattenModel, unflatten } from "./service.ts";

/** Field names come from the browser (service apply) and from firewalls: they must never reach object prototypes. */
describe("prototype pollution", () => {
  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).polluted;
  });

  it("unflatten refuses __proto__, constructor and prototype in a field path", () => {
    for (const path of ["__proto__.polluted", "constructor.prototype.polluted", "a.__proto__.polluted", "prototype"]) {
      expect(() => unflatten({ [path]: "x" }), path).toThrow(/not allowed/);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("flattenModel ignores such keys coming from a firewall", () => {
    const raw = JSON.parse('{"general":{"__proto__":{"polluted":"x"},"enabled":"1"},"constructor":{"prototype":{"polluted":"y"}}}');
    const f = flattenModel(raw);
    expect(f.values).toEqual({ "general.enabled": "1" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("still builds normal nested bodies", () => {
    expect(unflatten({ "general.enabled": "1", "general.port": "53", top: "x" })).toEqual({ general: { enabled: "1", port: "53" }, top: "x" });
  });
});
