/**
 * OWASP A08:2025 regression — Object.assign(plainObject, JSON.parse(text))
 * lets a "__proto__" key in `text` hijack the target's own prototype (its
 * [[Set]] semantics reach Object.prototype's real __proto__ accessor,
 * unlike plain JSON.parse or object-spread, neither of which trigger it —
 * see safeJson.ts's header for the verified breakdown). safeJsonParse's
 * reviver must strip that key so Object.assign is safe to use downstream.
 */
import { describe, it, expect } from "vitest";
import { safeJsonParse } from "./safeJson";

describe("safeJsonParse", () => {
  it("parses ordinary JSON exactly like JSON.parse", () => {
    expect(safeJsonParse('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  it("drops a top-level __proto__ key instead of passing it through", () => {
    const parsed: any = safeJsonParse('{"a":1,"__proto__":{"polluted":"yes"}}');
    expect(parsed.a).toBe(1);
    expect(Object.keys(parsed)).not.toContain("__proto__");
  });

  it("Object.assign against a plain object stays a plain object after merging the parsed result", () => {
    const target: Record<string, unknown> = {};
    Object.assign(target, safeJsonParse('{"a":1,"__proto__":{"polluted":"yes"}}'));
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect((target as any).polluted).toBeUndefined();
    expect(target.a).toBe(1);
  });

  it("strips __proto__ at nested levels too, not just the top", () => {
    const parsed: any = safeJsonParse('{"outer":{"__proto__":{"polluted":"yes"},"keep":2}}');
    expect(parsed.outer.keep).toBe(2);
    expect(Object.keys(parsed.outer)).not.toContain("__proto__");
  });
});
