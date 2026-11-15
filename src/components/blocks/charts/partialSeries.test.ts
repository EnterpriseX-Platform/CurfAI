import { describe, expect, it } from "vitest";
import { partialUniqKey, splitPartialFields } from "./partialSeries";
import { dateLabel, dateTick, type ChartRenderCtx } from "./shared";

const rows = [
  { week: "2026-W37", revenue: 10, orders: 1 },
  { week: "2026-W38", revenue: 12, orders: 2 },
  { week: "2026-W39", revenue: 3, orders: 1 },
];

describe("splitPartialFields", () => {
  it("moves each series' last step onto <field>__partial", () => {
    const out = splitPartialFields(rows, ["revenue"], 2);
    expect(out[0]).toEqual(rows[0]);
    expect(out[1]).toMatchObject({ revenue: 12, revenue__partial: 12 });
    expect(out[2]).toMatchObject({ revenue: undefined, revenue__partial: 3, orders: 1 });
    expect(rows[2]!.revenue).toBe(3); // input untouched
  });
  it("leaves rows alone without a partial index or with one point", () => {
    expect(splitPartialFields(rows, ["revenue"], undefined)).toBe(rows);
    expect(splitPartialFields(rows.slice(0, 1), ["revenue"], 0)).toEqual(rows.slice(0, 1));
  });
  it("collapses the shared point's two tooltip entries", () => {
    expect(partialUniqKey({ dataKey: "revenue__partial" })).toBe(partialUniqKey({ dataKey: "revenue" }));
    expect(partialUniqKey({ dataKey: "orders" })).not.toBe(partialUniqKey({ dataKey: "revenue" }));
  });
});

describe("week axis labels and the incomplete-period tooltip", () => {
  const ctx = {
    data: rows, xField: "week", yFields: ["revenue"], cfg: {}, palette: [], fmt: "number",
    handleClick: () => {}, renderReferenceLines: () => null, renderAnnotations: () => null, renderForecastDecor: () => null,
    dateStyle: { locale: "en" }, partial: { index: 2, note: "Incomplete period" },
  } as ChartRenderCtx;
  it("ticks read the week's start date, the tooltip adds the year and the note", () => {
    expect(dateTick(ctx)("2026-W29")).toBe("20 Jul");
    expect(dateLabel(ctx)("2026-W38")).toBe("21 Sep 2026");
    expect(dateLabel(ctx)("2026-W39")).toBe("28 Sep 2026 · Incomplete period");
    expect(dateTick(ctx)("2026-W39")).toBe("28 Sep");
  });
});
