/**
 * assertComposedSqlSafe guards SQL a model wrote from a tenant's request
 * (Auto-Curf's derived datasets — Issue 10). It has to let a real
 * join-plus-flag through and refuse anything that reads outside the
 * report's own tables: another table, a file, a system catalog.
 */
import { describe, it, expect } from "vitest";
import { assertComposedSqlSafe } from "./sqlGuard";

const TABLES = ["projects", "budget_lines", "liquidity_monthly"];
const ok = (sql: string) => expect(() => assertComposedSqlSafe(sql, TABLES)).not.toThrow();
const refused = (sql: string, why?: RegExp) =>
  expect(() => assertComposedSqlSafe(sql, TABLES)).toThrow(why ?? /SQL validation failed/);

describe("assertComposedSqlSafe — lets real analysis through", () => {
  it("a three-table join with a computed at-risk flag", () => {
    ok(`SELECT p.project_id, p.name, b.allocated, l.cash_balance,
          CASE WHEN l.cash_balance < b.allocated * 0.2 THEN 1 ELSE 0 END AS at_risk
        FROM projects p
        JOIN budget_lines b ON b.project_id = p.project_id
        LEFT JOIN liquidity_monthly l ON l.month = b.month`);
  });

  it("a CTE, aggregates, and an IN subquery over the report's tables", () => {
    ok(`WITH spent AS (SELECT project_id, SUM(amount) AS spent FROM budget_lines GROUP BY project_id)
        SELECT p.name, COALESCE(s.spent, 0) AS spent, ROUND(COALESCE(s.spent, 0) * 100.0 / NULLIF(p.budget, 0), 1) AS pct
        FROM projects p LEFT JOIN spent s ON s.project_id = p.project_id
        WHERE p.project_id IN (SELECT project_id FROM budget_lines)`);
  });

  it("FROM inside EXTRACT, a CAST to DECIMAL(10,2), IS DISTINCT FROM", () => {
    ok(`SELECT EXTRACT(YEAR FROM b.month) AS yr, CAST(b.amount AS DECIMAL(10,2)) AS amt
        FROM budget_lines b WHERE b.status IS DISTINCT FROM 'cancelled'`);
  });

  it("Thai column names, and a string literal that merely mentions a file function", () => {
    ok(`SELECT "ชื่อโครงการ", 'read_csv(''/etc/passwd'') FROM secret' AS note FROM projects`);
  });

  it("a comma join between the report's own tables", () => {
    ok(`SELECT p.name, b.amount FROM projects p, budget_lines b WHERE b.project_id = p.project_id`);
  });
});

describe("assertComposedSqlSafe — refuses reads outside the report's tables", () => {
  it("file-reading table functions", () => {
    refused(`SELECT * FROM read_csv('/etc/passwd')`, /read_csv/);
    refused(`SELECT * FROM projects p, LATERAL read_parquet('/data/lake/other/x.parquet')`);
  });

  it("file- and env-reading scalar functions anywhere in the query", () => {
    refused(`SELECT read_text('/app/.env') AS x FROM projects`, /read_text/);
    refused(`SELECT getenv('DATABASE_URL') AS x FROM projects`, /getenv/);
    refused(`SELECT glob('*') FROM projects`, /glob/);
    refused(`SELECT "read_csv"('x') FROM projects`, /quoted function/);
  });

  it("a quoted path as a table (DuckDB reads it as a file)", () => {
    refused(`SELECT * FROM '/data/lake/other-tenant/lake.duckdb'`);
  });

  it("a table that isn't one of the report's, however it's reached", () => {
    refused(`SELECT * FROM projects, sqlite_master`, /sqlite_master/);
    refused(`SELECT * FROM projects p JOIN payroll x ON x.id = p.id`, /payroll/);
    refused(`SELECT * FROM projects WHERE project_id IN (SELECT id FROM payroll)`, /payroll/);
    refused(`SELECT * FROM "Payroll"`, /payroll/);
    refused(`SELECT * FROM projects -- trailing comment\n , payroll`, /payroll/);
  });

  it("schema-qualified names and parenthesised joins", () => {
    refused(`SELECT * FROM main.projects`, /schema-qualified/);
    refused(`SELECT * FROM (projects JOIN budget_lines ON 1 = 1)`, /parenthesised/);
  });

  it("recursive CTEs, writes, and stacked statements", () => {
    refused(`WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT * FROM r`, /recursive/);
    refused(`DELETE FROM projects`);
    refused(`SELECT * FROM projects; SELECT * FROM payroll`);
  });

  it("malformed input", () => {
    refused(`SELECT 'unterminated FROM projects`, /unterminated/);
    refused(`SELECT * FROM projects WHERE (a = 1`, /unbalanced/);
  });
});
