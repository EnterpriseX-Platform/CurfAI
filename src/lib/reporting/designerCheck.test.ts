import { describe, it, expect } from "vitest";
import { applyCheckFix, checkReport } from "./designerCheck";
import type { Report } from "@/lib/reporting/schema";

// A chart titled "Top 10" whose query returns 50 rows: R1, repaired by limiting the query to 10.
const report = (): Report => ({
  version: 1,
  name: "Top items",
  parameters: [],
  dataSources: [{ id: "q_top", name: "top", dataSourceId: "lake", sql: `SELECT "item" AS "item", SUM("amount") AS "amount" FROM "sales" GROUP BY "item" ORDER BY "amount" DESC` }],
  pages: [{
    id: "p1", size: "A4", orientation: "portrait",
    blocks: [{ id: "c1", type: "chart", x: 0, y: 0, w: 12, h: 8, config: { queryId: "q_top", chartType: "bar", title: "Top 10 items", xField: "item", yFields: ["amount"] } }],
  }],
} as unknown as Report);
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ item: `item ${i}`, amount: 1000 - i }));

describe("checkReport", () => {
  it("flags a Top 10 chart that returns 50 rows, and says it can be fixed", () => {
    const items = checkReport(report(), { q_top: rows(50) });
    const r1 = items.find((i) => i.rule === "R1");
    expect(r1).toMatchObject({ blockId: "c1", fixable: true });
  });

  it("is quiet once the query returns 10 rows", () => {
    expect(checkReport(report(), { q_top: rows(10) }).filter((i) => i.rule === "R1")).toEqual([]);
  });
});

describe("applyCheckFix", () => {
  it("limits the query to N, trims the rows on screen, and leaves the input alone", () => {
    const before = report();
    const data = { q_top: rows(50) };
    const v = checkReport(before, data).find((i) => i.rule === "R1")!.violation;
    const done = applyCheckFix(before, data, v)!;
    expect(done.dataset.q_top).toHaveLength(10);
    expect(done.report.dataSources[0]!.sql).toMatch(/LIMIT 10\s*$/i);
    expect(before.dataSources[0]!.sql).not.toMatch(/LIMIT/i);
    expect(data.q_top).toHaveLength(50);
    expect(done.rerun).toBe(false);
    // After the fix the report no longer breaks the rule.
    expect(checkReport(done.report, done.dataset).filter((i) => i.rule === "R1")).toEqual([]);
  });

  it("returns null for a finding with no repair or a block that is gone", () => {
    const v = { rule: "R1", target: "gone", detail: "x" } as any;
    expect(applyCheckFix(report(), {}, v)).toBeNull();
  });
});
