/**
 * A block's visibleToRoles hid it on screen, but every surface still ran all
 * of report.dataSources and handed the rows over: the data API, the viewer
 * page's RSC payload, share / embed links, dashboards. visibleReport() drops
 * the hidden blocks and the queries only they needed.
 *
 * Dropping a query a visible block reads would break the report, and
 * keeping one only a hidden block reads ships its rows. A block or query
 * reads a query only through a field named queryId or ending in QueryId. The
 * last test here fails if a report field that names a query breaks that
 * pattern, since the rule would then drop a query a visible block needs.
 */
import { describe, it, expect } from "vitest";
import { visibleReport, dropQueriesOnlyUsedBy } from "./visibleReport";
import { ReportSchema } from "./schema";

const q = (id: string, extra: object = {}) => ({ id, name: id, dataSourceId: "ds1", sql: "SELECT 1", ...extra });
const kpi = (id: string, queryId: string, extra: object = {}, config: object = {}): any => ({
  id, type: "kpi", x: 0, y: 0, w: 4, h: 3, ...extra,
  config: { queryId, label: id, valueField: "v", format: "number", ...config },
});
const table = (id: string, queryId: string, extra: object = {}): any => ({
  id, type: "table", x: 0, y: 3, w: 12, h: 4, ...extra,
  config: { queryId, title: id, columns: [], pageSize: 50, stripe: true, showTotals: false, actions: [] },
});
const report = (dataSources: any[], blocks: any[]): any => ({
  version: 1, name: "R", parameters: [], dataSources,
  pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks }],
});
const FIN = { visibleToRoles: ["finance"] };
const viewer = (roles: string[] = []) => ({ isAdmin: false, roles });
const ids = (r: any) => r.dataSources.map((d: any) => d.id);
const blockIds = (r: any) => r.pages.flatMap((p: any) => p.blocks.map((b: any) => b.id));

describe("visibleReport — blocks", () => {
  const r = report([q("q_open"), q("q_salaries")], [kpi("k_open", "q_open"), table("t_fin", "q_salaries", FIN)]);

  it("drops a block gated to a role the viewer lacks, and the query only it used", () => {
    const shown = visibleReport(r, viewer());
    expect(blockIds(shown)).toEqual(["k_open"]);
    expect(ids(shown)).toEqual(["q_open"]);
  });

  it("keeps both for a viewer with the role, and for an admin", () => {
    for (const v of [viewer(["finance"]), { isAdmin: true, roles: [] }]) {
      const shown = visibleReport(r, v);
      expect(blockIds(shown)).toEqual(["k_open", "t_fin"]);
      expect(ids(shown)).toEqual(["q_open", "q_salaries"]);
    }
  });

  it("filters as nobody when there is no viewer (public links, the cron)", () => {
    expect(ids(visibleReport(r, undefined))).toEqual(["q_open"]);
  });

  it("returns the same report object when nothing is hidden", () => {
    const plain = report([q("q_open")], [kpi("k_open", "q_open")]);
    expect(visibleReport(plain, viewer()).dataSources).toBe(plain.dataSources);
  });

  it("doesn't touch the definition it was given", () => {
    visibleReport(r, viewer());
    expect(blockIds(r)).toEqual(["k_open", "t_fin"]);
    expect(ids(r)).toEqual(["q_open", "q_salaries"]);
  });
});

describe("visibleReport — which queries a visible block still needs", () => {
  it("keeps a query a hidden block shares with a visible one", () => {
    const r = report([q("q_total")], [kpi("k_rev", "q_total"), kpi("k_cust", "q_total", FIN)]);
    expect(ids(visibleReport(r, viewer()))).toEqual(["q_total"]);
  });

  it("keeps a query a visible block reads through any field, not just config.queryId", () => {
    // A KPI's sparkline, a map's pins, a chart's drilldown: all name a query.
    const r = report(
      [q("q_value"), q("q_spark"), q("q_pins"), q("q_drill"), q("q_hidden")],
      [
        kpi("k", "q_value", {}, { sparkQueryId: "q_spark" }),
        { id: "m", type: "map", x: 0, y: 0, w: 6, h: 6, config: { queryId: "q_value", regionField: "r", valueField: "v", pinsQueryId: "q_pins", drilldown: { queryId: "q_drill", filterParam: "r" } } },
        table("t_fin", "q_hidden", FIN),
        // The hidden block also names every one of them.
        kpi("k_fin", "q_spark", FIN, { sparkQueryId: "q_pins" }),
        kpi("k_fin2", "q_drill", FIN),
      ],
    );
    expect(ids(visibleReport(r, viewer()))).toEqual(["q_value", "q_spark", "q_pins", "q_drill"]);
  });

  it("keeps a query that a needed query joins, even when only a hidden block reads it directly", () => {
    const r = report(
      [
        q("q_regions", { joins: [{ type: "left", queryId: "q_stores", on: { left: "region", right: "region" }, alias: "m" }] }),
        q("q_stores"),
      ],
      [kpi("k", "q_regions"), table("t_fin", "q_stores", FIN)],
    );
    expect(ids(visibleReport(r, viewer()))).toEqual(["q_regions", "q_stores"]);
  });

  it("drops a query that only a dropped query joined", () => {
    const r = report(
      [
        q("q_open"),
        q("q_salaries", { joins: [{ type: "left", queryId: "q_grades", on: { left: "grade", right: "grade" }, alias: "g" }] }),
        q("q_grades"),
      ],
      [kpi("k", "q_open"), table("t_fin", "q_salaries", FIN)],
    );
    expect(ids(visibleReport(r, viewer()))).toEqual(["q_open"]);
  });

  it("drops a hidden query whose id is a plain word a visible block uses for something else", () => {
    // Real ids in the demo data include "branches", "sites" and "lines".
    // A visible block's column, label or text saying "branches" doesn't read that query.
    const r = report(
      [q("q_open"), q("branches", { sql: "SELECT name, revenue FROM branches" })],
      [
        kpi("k", "q_open", {}, { label: "branches", valueField: "branches" }),
        { id: "txt", type: "text", x: 0, y: 0, w: 12, h: 2, config: { text: "All branches", align: "left", size: "md" } },
        table("t_fin", "branches", FIN),
      ],
    );
    expect(ids(visibleReport(r, viewer()))).toEqual(["q_open"]);
  });

  it("leaves a query no block uses alone: it isn't a hidden block's to take away", () => {
    const r = report([q("q_open"), q("q_orphan"), q("q_salaries")], [kpi("k", "q_open"), table("t_fin", "q_salaries", FIN)]);
    expect(ids(visibleReport(r, viewer()))).toEqual(["q_open", "q_orphan"]);
  });

  it("matches ids as whole tokens, so a visible q10 doesn't keep a hidden q1", () => {
    const r = report([q("q1"), q("q10")], [kpi("k", "q10"), table("t_fin", "q1", FIN)]);
    expect(ids(visibleReport(r, viewer()))).toEqual(["q10"]);
  });

});

describe("dropQueriesOnlyUsedBy — a single-block embed", () => {
  it("keeps only what the one remaining block needs", () => {
    const k = kpi("k", "q_open");
    const t = table("t", "q_other");
    const full = report([q("q_open"), q("q_other")], [k, t]);
    const single = dropQueriesOnlyUsedBy({ ...full, pages: [{ ...full.pages[0], blocks: [k] }] }, [t]);
    expect(ids(single)).toEqual(["q_open"]);
  });
});

describe("the report schema names every query reference queryId or …QueryId", () => {
  // visibleReport() finds the queries a block needs by that key pattern.
  // A new field that names a query some other way (say "sourceQuery") would
  // be missed, and its query dropped for any viewer with a hidden block that
  // also reads it. Rename the field, or teach queryRefs() about it.
  function keysOf(schema: any): string[] {
    const def = schema?._def;
    switch (def?.typeName) {
      case "ZodObject": return Object.entries(schema.shape).flatMap(([k, v]) => [k, ...keysOf(v)]);
      case "ZodOptional": case "ZodNullable": case "ZodDefault": return keysOf(def.innerType);
      case "ZodArray": return keysOf(def.type);
      case "ZodEffects": return keysOf(def.schema);
      case "ZodRecord": return keysOf(def.valueType);
      case "ZodUnion": case "ZodDiscriminatedUnion": return def.options.flatMap((o: any) => keysOf(o));
      default: return [];
    }
  }

  it("has no other field that looks like one", () => {
    const keys = [...new Set(keysOf(ReportSchema))];
    expect(keys).toContain("queryId");
    expect(keys).toContain("sparkQueryId");
    expect(keys).toContain("pinsQueryId");
    expect(keys).toEqual(expect.arrayContaining(["joins", "drilldown"]));
    const odd = keys.filter((k) => /query|dataset/i.test(k) && k !== "queryId" && !k.endsWith("QueryId"));
    expect(odd).toEqual([]);
  });
});
