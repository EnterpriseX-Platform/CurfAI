import { describe, expect, it } from "vitest";
import { EngineQuerySchema } from "./schema";

const ok = (q: unknown) => EngineQuerySchema.safeParse(q).success;
const many = (n: number, make: (i: number) => unknown) => Array.from({ length: n }, (_, i) => make(i));

describe("EngineQuerySchema", () => {
  it("accepts a realistic query", () => {
    expect(ok({
      viewId: "v1", columns: ["id", "name"], groupBy: ["agency"],
      aggregates: [{ fn: "SUM", column: "amount", as: "total" }, { fn: "COUNT" }],
      filters: [
        { column: "created", op: "GE", value: { $param: "from" } },
        { column: "agency", op: "EQ", value: { $param: "agency" }, skipIfEmpty: true },
        { column: "id", op: "IN", values: [1, 2, "three", null] },
      ],
      orderBy: [{ column: "id", descending: true }], limit: 500,
    })).toBe(true);
  });

  it("is bounded: a saved definition cannot make Curf send the engine something enormous", () => {
    expect(ok({ viewId: "v", limit: 200_000 })).toBe(true);
    expect(ok({ viewId: "v", limit: 200_001 })).toBe(false);
    expect(ok({ viewId: "v", columns: many(200, (i) => `c${i}`) })).toBe(true);
    expect(ok({ viewId: "v", columns: many(201, (i) => `c${i}`) })).toBe(false);
    expect(ok({ viewId: "v", filters: many(51, () => ({ column: "a", op: "EQ", value: 1 })) })).toBe(false);
    expect(ok({ viewId: "v", filters: [{ column: "a", op: "IN", values: many(1001, (i) => i) }] })).toBe(false);
    expect(ok({ viewId: "v", groupBy: many(21, (i) => `g${i}`) })).toBe(false);
    expect(ok({ viewId: "v", aggregates: many(21, () => ({ fn: "COUNT" })) })).toBe(false);
    expect(ok({ viewId: "v", orderBy: many(21, (i) => ({ column: `o${i}` })) })).toBe(false);
    expect(ok({ viewId: "v", columns: ["x".repeat(256)] })).toBe(false);
    expect(ok({ viewId: "v", filters: [{ column: "a", op: "EQ", value: "x".repeat(1001) }] })).toBe(false);
  });

  it("lets a draft be saved before a view is chosen, but no longer than a view id can be", () => {
    expect(ok({ viewId: "" })).toBe(true);
    expect(ok({ viewId: "x".repeat(101) })).toBe(false);
  });

  it("refuses what is not a query: no view field, a bad operator, a $param with extra keys, a non-positive limit", () => {
    expect(ok({})).toBe(false);
    expect(ok({ viewId: "v", filters: [{ column: "a", op: "DROP" }] })).toBe(false);
    expect(ok({ viewId: "v", filters: [{ column: "a", op: "EQ", value: { $param: "p", extra: 1 } }] })).toBe(false);
    expect(ok({ viewId: "v", limit: 0 })).toBe(false);
    expect(ok({ viewId: "v", aggregates: [{ fn: "DELETE" }] })).toBe(false);
  });
});
