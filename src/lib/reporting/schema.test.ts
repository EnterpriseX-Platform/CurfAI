/**
 * ReportSchema should reject a write/DDL SQL data source at *save* time, not
 * just at execution time (sqlGuard.assertSelectOnly, enforced by the
 * runner). Before this test, a report could be saved with e.g. a
 * `DROP TABLE` sitting in its definition — the runner would refuse to
 * *run* it, but nothing stopped it from being persisted in the first place.
 */
import { describe, it, expect } from "vitest";
import { ReportSchema, emptyReport } from "./schema";

function withDataSourceSql(sql: string) {
  const report = emptyReport();
  report.dataSources.push({ id: "q1", name: "probe", dataSourceId: "ds1", sql });
  return report;
}

describe("ReportSchema — rejects write/DDL SQL at save time", () => {
  it("accepts a plain read-only SELECT", () => {
    const result = ReportSchema.safeParse(withDataSourceSql("SELECT * FROM revenue_monthly LIMIT 5"));
    expect(result.success).toBe(true);
  });

  it("accepts a data source with no sql set at all (e.g. a REST source)", () => {
    const report = emptyReport();
    report.dataSources.push({ id: "q1", name: "rest probe", dataSourceId: "ds1" });
    expect(ReportSchema.safeParse(report).success).toBe(true);
  });

  it.each([
    'DROP TABLE "revenue_monthly"',
    "DELETE FROM users",
    "SELECT * FROM t INTO OUTFILE '/var/www/html/shell.php'",
    "SELECT * INTO new_table FROM t",
    "SELECT 1; DROP TABLE users",
  ])("rejects a report whose data source sql is %s", (sql) => {
    const result = ReportSchema.safeParse(withDataSourceSql(sql));
    expect(result.success).toBe(false);
  });
});
