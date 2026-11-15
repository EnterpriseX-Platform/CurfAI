import { describe, it, expect } from "vitest";
import { headlineFor } from "./storyHeadline";
import type { Block } from "./schema";

const block = (type: string, config: Record<string, unknown>) => ({ id: "b", type, x: 0, y: 0, w: 4, h: 3, config }) as unknown as Block;

describe("headlineFor", () => {
  it("says what a KPI is, from its own rows", () => {
    const h = headlineFor(block("kpi", { queryId: "q", label: "Orders", valueField: "n", format: "number" }), { q: [{ n: 12345 }] });
    expect(h).toEqual({ key: "kpi", vars: { label: "Orders", value: "12.3K" }, rows: 1 });
  });

  it("has nothing to say for a KPI with no label or no value", () => {
    expect(headlineFor(block("kpi", { queryId: "q", valueField: "n" }), { q: [{ n: 1 }] })).toBeNull();
    expect(headlineFor(block("kpi", { queryId: "q", label: "x", valueField: "n" }), { q: [{ n: null }] })).toBeNull();
    expect(headlineFor(block("kpi", { queryId: "q", label: "x", valueField: "n" }), {})).toBeNull();
  });

  it("names what leads a ranking", () => {
    const h = headlineFor(block("chart", { queryId: "q", chartType: "bar", title: "Revenue by branch", xField: "branch", yFields: ["rev"] }),
      { q: [{ branch: "Siam", rev: 100 }, { branch: "Silom", rev: 900 }, { branch: "Ari", rev: 400 }] });
    expect(h).toMatchObject({ key: "top", vars: { title: "Revenue by branch", name: "Silom", value: "900" } });
  });

  it("says where a series went, with the change from its first to its last point", () => {
    const rows = [{ m: "2026-01", v: 100 }, { m: "2026-02", v: 150 }, { m: "2026-03", v: 120 }];
    const h = headlineFor(block("chart", { queryId: "q", chartType: "line", title: "Sales", xField: "m", yFields: ["v"] }), { q: rows });
    expect(h).toMatchObject({ key: "up", vars: { from: "2026-01", to: "2026-03", pct: "20%" } });
    const down = headlineFor(block("chart", { queryId: "q", chartType: "bar", title: "Sales", xField: "m", yFields: ["v"] }), { q: [...rows].reverse() });
    expect(down).toMatchObject({ key: "down", vars: { pct: "17%" } });
  });

  it("does not divide by a zero start, and skips blocks it has no sentence for", () => {
    expect(headlineFor(block("chart", { queryId: "q", chartType: "line", xField: "m", yFields: ["v"] }), { q: [{ m: "2026-01", v: 0 }, { m: "2026-02", v: 5 }] })).toBeNull();
    expect(headlineFor(block("table", { queryId: "q" }), { q: [{ a: 1 }] })).toBeNull();
  });
});
