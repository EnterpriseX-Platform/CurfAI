import { describe, it, expect } from "vitest";
import { checkDashboard, type ReportHealth } from "./check";

const ok: ReportHealth = { name: "Sales", verdict: "pass", flags: 0 };
const reports = { a: ok, b: { name: "Churn", verdict: "fail", flags: 2 }, c: { name: "Costs", verdict: "pass", flags: 3 } };

describe("checkDashboard", () => {
  it("is quiet for healthy reports", () => {
    expect(checkDashboard({ reportIds: ["a"], reports, layout: "carousel" })).toEqual([]);
  });

  it("names a report the check failed, and one with flags it kept, but not both for the same report", () => {
    const f = checkDashboard({ reportIds: ["b", "c"], reports, layout: "carousel" });
    expect(f).toEqual([{ kind: "failed", reportId: "b", name: "Churn" }, { kind: "flagged", reportId: "c", name: "Costs", n: 3 }]);
  });

  it("says a report that is gone, and one listed twice", () => {
    const f = checkDashboard({ reportIds: ["a", "gone", "a"], reports, layout: "carousel" });
    expect(f).toEqual([{ kind: "missing", reportId: "gone" }, { kind: "duplicate", reportId: "a", name: "Sales" }]);
  });

  it("warns about a custom layout with more than nine reports on one screen, not a carousel", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `r${i}`);
    const many = Object.fromEntries(ids.map((id) => [id, ok]));
    expect(checkDashboard({ reportIds: ids, reports: many, layout: "custom" })).toEqual([{ kind: "crowded", n: 10 }]);
    expect(checkDashboard({ reportIds: ids, reports: many, layout: "carousel" })).toEqual([]);
  });

  it("counts cards, not reports, when several cards are blocks of the same report", () => {
    expect(checkDashboard({ reportIds: ["r1"], cardCount: 10, reports: { r1: ok }, layout: "custom" })).toEqual([{ kind: "crowded", n: 10 }]);
    expect(checkDashboard({ reportIds: ["r1"], cardCount: 3, reports: { r1: ok }, layout: "custom" })).toEqual([]);
  });
});
