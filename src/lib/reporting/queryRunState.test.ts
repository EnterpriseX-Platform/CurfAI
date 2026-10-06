import { describe, it, expect } from "vitest";
import { queryErrors, runOutcome } from "./queryRunState";

const prov = (m: Record<string, object>) => m as any;

describe("queryErrors — what a public API caller needs to tell a failure from an empty result", () => {
  it("is {} when every query ran, including ones that returned no rows", () => {
    expect(queryErrors(prov({ a: { rowCount: 0 }, b: {} }))).toEqual({});
    expect(queryErrors(undefined)).toEqual({});
  });

  it("names every query that failed or was hidden, with its reason", () => {
    expect(queryErrors(prov({
      ok: {},
      bad: { executionError: "Binder Error: no such column" },
      hidden: { accessDeniedNote: "Hidden by visibility" },
    }))).toEqual({ bad: "Binder Error: no such column", hidden: "Hidden by visibility" });
  });
});

describe("runOutcome — how a run's snapshot is recorded", () => {
  it("is completed when every query ran (this is the only status baselines read)", () => {
    expect(runOutcome(prov({ a: {}, b: {} }))).toEqual({ status: "completed" });
    expect(runOutcome(undefined)).toEqual({ status: "completed" });
    expect(runOutcome(prov({}))).toEqual({ status: "completed" });
  });

  it("is failed, with a count and the first reason, when a query didn't run", () => {
    const o = runOutcome(prov({ a: {}, b: { executionError: "boom" }, c: { executionError: "second" } }));
    expect(o.status).toBe("failed");
    expect(o.error).toBe("2 of 3 queries didn't run: boom");
  });

  it("is restricted, not failed, when the only gap is a source hidden from this viewer", () => {
    const o = runOutcome(prov({ a: {}, b: { accessDeniedNote: "hidden" } }));
    expect(o).toEqual({ status: "restricted", error: "1 of 2 queries were hidden from this viewer" });
  });

  it("is restricted when queries were withheld because only blocks hidden from this viewer used them", () => {
    // They never ran, so they have no provenance entry to find a note on.
    expect(runOutcome(prov({ a: {} }), 1)).toEqual({ status: "restricted", error: "1 of 2 queries were hidden from this viewer" });
    expect(runOutcome(prov({ a: {}, b: { accessDeniedNote: "hidden" } }), 1).error).toBe("2 of 3 queries were hidden from this viewer");
  });

  it("a real failure outranks a restriction", () => {
    expect(runOutcome(prov({ a: { accessDeniedNote: "hidden" }, b: { executionError: "boom" } })).status).toBe("failed");
  });

  it("keeps the stored error short", () => {
    expect(runOutcome(prov({ a: { executionError: "x".repeat(2000) } })).error!.length).toBeLessThanOrEqual(500);
  });
});
