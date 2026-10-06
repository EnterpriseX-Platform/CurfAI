import { describe, expect, it } from "vitest";
import { chartAxes, extractTable, slotChart, stripTables, withoutAiCaption } from "./dashboardSlots";

const block = (id: string, type: string, y: number, x = 0, config: Record<string, unknown> = {}) =>
  ({ id, type, x, y, w: 6, h: 4, config }) as any;
const report = (...blocks: any[]) => ({ name: "R", pages: [{ id: "p1", blocks }] }) as any;
const t = (k: string) => ({ "dashboardViewer.xAxisLabel": "X: {field}", "dashboardViewer.yAxisLabel": "Y: {fields}" } as Record<string, string>)[k] ?? k;

describe("dashboardSlots — what a dashboard card shows from its report", () => {
  it("shows the report's first visual block in reading order, over the rows it was given", () => {
    const def = report(block("t1", "table", 0), block("c2", "chart", 4, 6), block("c1", "chart", 4, 0), block("k", "kpi", 0, 6));
    const rows = { q: [{ a: 1 }] };
    expect(slotChart(def, rows)).toEqual({ block: expect.objectContaining({ id: "c1" }), dataset: rows, auto: false });
    expect(extractTable(def)?.id).toBe("t1");
  });

  it("draws a chart from the first query when the report has no visual block", () => {
    const chart = slotChart(report(block("t1", "table", 0)), { sales: [{ region: "North", amount: 5 }, { region: "South", amount: 7 }] })!;
    expect(chart.auto).toBe(true);
    expect(chart.block.config).toMatchObject({ chartType: "bar", xField: "region", yFields: ["amount"] });
    expect(chart.dataset).toEqual({ sales: [{ region: "North", amount: 5 }, { region: "South", amount: 7 }] });
    expect(slotChart(report(), {})).toBeNull();
  });

  it("names a chart's axes for the caption, and nothing for any other block", () => {
    expect(chartAxes(block("c", "chart", 0, 0, { xField: "month", yFields: ["sales", "cost"] }), t)).toEqual({ x: "X: month", y: "Y: sales, cost" });
    expect(chartAxes(block("k", "kpi", 0), t)).toEqual({ x: "", y: "" });
  });

  it("turns the AI caption off on a copy, leaving the report's block alone", () => {
    const original = block("c", "chart", 0, 0, { showAiCaption: true, xField: "m" });
    const copy = withoutAiCaption(original);
    expect(copy.config).toMatchObject({ showAiCaption: false, xField: "m" });
    expect(original.config.showAiCaption).toBe(true);
  });

  it("closes the gap a removed table leaves, keeping a block beside it in its row", () => {
    const def = report(block("k", "kpi", 0), block("t", "table", 4), block("side", "chart", 4, 6), block("c", "chart", 8));
    const blocks = stripTables(def).pages[0].blocks;
    expect(blocks.map((b: any) => [b.id, b.y])).toEqual([["k", 0], ["side", 4], ["c", 8]]);
    const alone = stripTables(report(block("k", "kpi", 0), block("t", "table", 4), block("c", "chart", 8))).pages[0].blocks;
    expect(alone.map((b: any) => [b.id, b.y])).toEqual([["k", 0], ["c", 4]]);
  });
});
