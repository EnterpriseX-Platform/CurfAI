/**
 * Two export defects found by live testing:
 *
 *   OI-03  Every renderer read the report's on-screen preview query, which
 *          the generator caps at 500 rows. A 722-row table exported as 500
 *          rows with nothing to say it had been truncated.
 *   OI-04  The CSV renderer ran values through the display formatter, so
 *          3500 was written as "3,500" — a string to most spreadsheet
 *          importers, and a column of them sums to nothing.
 */
import { describe, it, expect } from "vitest";
import { liftPreviewLimit, EXPORT_ROW_CAP } from "./runner";
import { uncappedTableTitle } from "./format";
import type { DataSourceDef } from "./schema";

const ds = (over: Partial<DataSourceDef>): DataSourceDef => ({
  id: "q1", name: "t", dataSourceId: "lake", ...over,
} as DataSourceDef);

describe("liftPreviewLimit — only the generator's cap is lifted", () => {
  it("replaces a generator display cap with the export ceiling", () => {
    const out = liftPreviewLimit(ds({ sql: 'SELECT * FROM "orders" LIMIT 500', previewLimit: 500 }));
    expect(out.sql).toBe(`SELECT * FROM "orders" LIMIT ${EXPORT_ROW_CAP}`);
  });

  it("leaves a hand-written LIMIT completely alone", () => {
    const sql = 'SELECT * FROM "orders" LIMIT 10';
    // no previewLimit marker => the author meant it
    expect(liftPreviewLimit(ds({ sql })).sql).toBe(sql);
  });

  it("still bounds the export — never unbounded", () => {
    const out = liftPreviewLimit(ds({ sql: 'SELECT * FROM "t" LIMIT 500', previewLimit: 500 }));
    expect(out.sql).toMatch(/LIMIT \d+$/);
    expect(EXPORT_ROW_CAP).toBeGreaterThan(500);
  });

  it("handles a trailing OFFSET and semicolon", () => {
    const out = liftPreviewLimit(ds({ sql: 'SELECT * FROM "t" LIMIT 500 OFFSET 20;', previewLimit: 500 }));
    expect(out.sql).toBe(`SELECT * FROM "t" LIMIT ${EXPORT_ROW_CAP}`);
  });

  it("does not touch a LIMIT nested inside a subquery", () => {
    const sql = 'SELECT * FROM (SELECT * FROM "t" LIMIT 500) x ORDER BY a';
    expect(liftPreviewLimit(ds({ sql, previewLimit: 500 })).sql).toBe(sql);
  });

  it("returns non-SQL queries untouched", () => {
    const rest = ds({ path: "/v1/items", previewLimit: 500 });
    expect(liftPreviewLimit(rest)).toBe(rest);
  });
});

describe("uncappedTableTitle — the heading must match the file", () => {
  it("rewrites the generator's capped heading once the cap is lifted", () => {
    expect(uncappedTableTitle("Rows · first 500 of 722", 722)).toBe("Rows · all 722");
  });

  it("leaves an author's own title untouched", () => {
    expect(uncappedTableTitle("Open invoices", 900)).toBe("Open invoices");
    expect(uncappedTableTitle("All rows", 120)).toBe("All rows");
  });

  it("passes through an absent title", () => {
    expect(uncappedTableTitle(undefined, 10)).toBeUndefined();
  });
});
