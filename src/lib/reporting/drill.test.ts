import { describe, expect, it } from "vitest";
import { blockDrill, drillOnlyQueryIds } from "./drill";

const params = [{ name: "branch", label: "Branch", type: "select" as const, required: false }];
const q = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, dataSourceId: "ds", sql: "SELECT 1", ...extra });

describe("blockDrill", () => {
  it("re-scopes the report when the block names one of its parameters, and opens rows otherwise", () => {
    expect(blockDrill({ parameters: params }, { type: "chart", config: { drillParam: "branch", drilldown: { queryId: "d" } } }))
      .toEqual({ kind: "filter", param: "branch" });
    expect(blockDrill({ parameters: params }, { type: "table", config: { drillParam: "nope", drilldown: { queryId: "d", filterParam: "x" } } }))
      .toEqual({ kind: "rows", drilldown: { queryId: "d", filterParam: "x" } });
    // A KPI has no value to filter by: rows only.
    expect(blockDrill({ parameters: params }, { type: "kpi", config: { drillParam: "branch", drilldown: { queryId: "d" } } }))
      .toEqual({ kind: "rows", drilldown: { queryId: "d" } });
    expect(blockDrill({ parameters: params }, { type: "text", config: { drilldown: { queryId: "d" } } })).toBeNull();
    expect(blockDrill({ parameters: params }, { type: "chart", config: {} })).toBeNull();
  });
});

describe("drillOnlyQueryIds", () => {
  const block = (id: string, config: Record<string, unknown>) => ({ id, type: "chart", x: 0, y: 0, w: 6, h: 4, config });

  it("is the drill targets nothing else reads — those run on the click, not on load", () => {
    const report = {
      dataSources: [q("sales"), q("lines"), q("shared"), q("joined"), q("viaJoin", { joins: [{ queryId: "joined" }] })],
      pages: [{ blocks: [
        block("a", { queryId: "sales", drilldown: { queryId: "lines", filterParam: "branch" } }),
        // Read by a block of its own as well: it runs.
        block("b", { queryId: "shared" }),
        block("c", { queryId: "viaJoin", drilldown: { queryId: "shared" } }),
        // Read through another query's join: it runs.
        block("d", { queryId: "sales", drilldown: { queryId: "joined" } }),
      ] }],
    };
    expect([...drillOnlyQueryIds(report as any)]).toEqual(["lines"]);
  });

  it("is empty for a report without drills, or without pages", () => {
    expect(drillOnlyQueryIds({ dataSources: [q("a")], pages: [{ blocks: [block("a", { queryId: "a" })] }] } as any).size).toBe(0);
    expect(drillOnlyQueryIds({ dataSources: [q("a")] } as any).size).toBe(0);
  });
});
