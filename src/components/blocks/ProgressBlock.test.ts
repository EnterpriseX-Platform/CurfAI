/**
 * Regression test for the "every row shows 100%" bug: list-mode progress
 * bars (a ranked leaderboard like "Deposits by branch") were clamping each
 * row's raw valueField straight to 0-100 instead of normalizing against the
 * row set's own max, so any value over 100 (money, counts — the common
 * case) drew a full bar regardless of its actual size.
 */
import { describe, it, expect } from "vitest";
import { computeListPct } from "./ProgressBlock";

describe("computeListPct", () => {
  it("normalizes ranked money values against the row set's max instead of clamping to 100", () => {
    const rows = [
      { branch_name: "Northgate", deposits: 327042857 },
      { branch_name: "Central", deposits: 297646667 },
      { branch_name: "Riverside", deposits: 241206667 },
    ];
    const pcts = computeListPct(rows, "deposits");
    expect(pcts[0]).toBe(100); // top row is always full
    expect(pcts[1]).toBeCloseTo((297646667 / 327042857) * 100, 5);
    expect(pcts[2]).toBeCloseTo((241206667 / 327042857) * 100, 5);
    // The old bug: every one of these would have been exactly 100.
    expect(pcts[1]).toBeLessThan(100);
    expect(pcts[2]).toBeLessThan(100);
  });

  it("still works for a genuinely 0-100 valueField", () => {
    const rows = [{ x: 80 }, { x: 40 }, { x: 20 }];
    const pcts = computeListPct(rows, "x");
    expect(pcts).toEqual([100, 50, 25]);
  });

  it("returns 0 for every row when valueField is missing", () => {
    expect(computeListPct([{ a: 1 }, { a: 2 }], undefined)).toEqual([0, 0]);
  });

  it("returns 0 for every row when all values are non-numeric or zero", () => {
    expect(computeListPct([{ x: "n/a" }, { x: 0 }], "x")).toEqual([0, 0]);
  });

  it("ignores non-numeric rows when computing the max, and gives them 0", () => {
    const rows = [{ x: 50 }, { x: "n/a" }, { x: 25 }];
    expect(computeListPct(rows, "x")).toEqual([100, 0, 50]);
  });
});
