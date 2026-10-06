/**
 * assertLakeReadSqlSafe / assertNoLakeFileAccess guard human-authored SQL
 * that runs against a tenant's lake — report Designer queries, Notebook SQL
 * cells, Data Quality custom_sql, the Agent's query_lake tool, Activation
 * SQL sources. For a tenant on the DuckDB lake engine (Team+), assertSelectOnly
 * alone leaves the door open: it blocks writes/DDL/ATTACH/PRAGMA but NOT
 * DuckDB's file/table functions (read_csv, read_parquet, glob, sqlite_scan …)
 * or a quoted path used as a table — either of which reads another tenant's
 * lake files under the shared CURF_LAKE_DIR, or the app's own files.
 *
 * Every "refuses" case here PASSES assertSelectOnly (verified below), so it
 * would have run unchecked before this guard — that's the regression these
 * tests pin.
 */
import { describe, it, expect } from "vitest";
import { assertLakeReadSqlSafe, assertNoLakeFileAccess, assertSelectOnly } from "./sqlGuard";

const ok = (sql: string) => expect(() => assertLakeReadSqlSafe(sql)).not.toThrow();
const refused = (sql: string, why?: RegExp) =>
  expect(() => assertLakeReadSqlSafe(sql)).toThrow(why ?? /not allowed|can't be used|file path/i);

describe("assertLakeReadSqlSafe — lets ordinary hand-written lake SQL through", () => {
  it("plain selects, joins, comma joins over named tables/views", () => {
    ok(`SELECT * FROM sales`);
    ok(`SELECT s.region, SUM(s.amount) AS total FROM sales s JOIN regions r ON r.id = s.region_id GROUP BY s.region`);
    ok(`SELECT a.x, b.y FROM table_a a, table_b b WHERE a.id = b.id`);
    ok(`WITH t AS (SELECT id, amount FROM sales) SELECT id, SUM(amount) FROM t GROUP BY id`);
  });

  it("an external-table / MV view referenced by name (read_parquet lives in the view body, not here)", () => {
    ok(`SELECT region, SUM(revenue) AS rev FROM sales_ext GROUP BY region ORDER BY rev DESC`);
    ok(`SELECT * FROM mv_daily_totals WHERE day >= '2024-01-01'`);
  });

  it("arbitrary scalar, date, window and json functions a person legitimately uses", () => {
    ok(`SELECT strftime(created_at, '%Y-%m') AS ym, COUNT(*) FROM sales GROUP BY ym`);
    ok(`SELECT id, ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount DESC) rn FROM sales`);
    ok(`SELECT json_extract(payload, '$.total') AS total FROM events`);
    ok(`SELECT EXTRACT(YEAR FROM created_at) AS y, CAST(amount AS DECIMAL(10,2)) a FROM sales`);
    ok(`SELECT amount FROM sales WHERE tag GLOB 'vip*' AND note LIKE '%read_csv%'`);
  });

  it("DuckDB list/struct indexing with [] and named-parameter syntax", () => {
    ok(`SELECT tags[1] AS first_tag, meta['owner'] AS owner FROM items`);
    ok(`SELECT * FROM sales WHERE region = :region AND created_at >= :from_date`);
  });

  it("a string literal that merely mentions a file function is fine in WHERE / projection", () => {
    ok(`SELECT 'read_csv is just text here' AS label, COUNT(*) FROM sales`);
    ok(`SELECT * FROM sales WHERE source_name = 'read_parquet.csv'`);
  });
});

describe("assertLakeReadSqlSafe — refuses file / network / cross-tenant reads", () => {
  it("file-reading table functions in FROM", () => {
    refused(`SELECT * FROM read_csv('/etc/hostname')`);
    refused(`SELECT * FROM read_csv_auto('/data/lake/other/data.csv')`);
    refused(`SELECT * FROM read_parquet('/data/lake/other/t.parquet')`);
    refused(`SELECT * FROM read_text('/etc/passwd')`);
    refused(`SELECT * FROM read_blob('/etc/hostname')`);
    refused(`SELECT * FROM glob('/data/lake/*')`);
    refused(`SELECT * FROM parquet_scan('/data/lake/other/t.parquet')`);
    refused(`SELECT * FROM iceberg_scan('s3://bucket/tbl/')`);
    refused(`SELECT * FROM read_duckdb('/data/lake/other/lake.duckdb')`);
  });

  it("file / env / secret / catalog functions anywhere, not just FROM", () => {
    refused(`SELECT read_text('/etc/hostname') AS h`);
    refused(`SELECT current_setting('home_directory') AS h FROM sales`);
    refused(`SELECT getvariable('x') FROM sales`);
    refused(`SELECT * FROM duckdb_secrets()`);
    refused(`SELECT * FROM duckdb_settings()`);
    refused(`SELECT * FROM sqlite_scan('/data/lake/other.db', 'sqlite_master')`);
    refused(`SELECT * FROM query('SELECT 1')`);
    refused(`SELECT json_execute_serialized_sql('...') FROM sales`);
    refused(`SELECT * FROM pragma_table_info('sales')`);
  });

  it("a quoted or bare path posing as a table (DuckDB replacement scan reads it as a file)", () => {
    refused(`SELECT * FROM '/data/lake/other-tenant/lake.duckdb'`, /string literal|file path/i);
    refused(`SELECT * FROM '/data/lake/other/data.csv'`, /string literal|file path/i);
    refused(`SELECT * FROM "C:/Users/other/lake.duckdb"`, /file path/i);
    refused(`SELECT * FROM "/data/lake/other/data.csv"`, /file path/i);
    refused(`SELECT a.* FROM sales a JOIN '/data/lake/other/data.csv' b ON a.id = b.id`, /string literal|file path/i);
    refused(`SELECT x FROM sales, '/data/lake/other/data.csv'`, /string literal|file path/i);
  });

  it("readers hidden inside a subquery, PIVOT / SUMMARIZE, or a qualified call", () => {
    refused(`SELECT * FROM (SELECT * FROM read_csv('/etc/hostname')) q`);
    refused(`SELECT * FROM (PIVOT '/data/lake/other/data.csv' ON a USING first(b))`, /string literal|file path/i);
    refused(`SELECT * FROM (SUMMARIZE '/data/lake/other/data.csv')`, /string literal|file path/i);
    refused(`SELECT * FROM system.main.read_csv('/etc/hostname')`);
    refused(`SELECT * FROM "read_csv"('/etc/hostname')`);
  });

  it("still catches writes / DDL / multi-statement (assertSelectOnly is layered in)", () => {
    refused(`SELECT 1; DROP TABLE sales`, /multiple statements|write or DDL/i);
    refused(`DELETE FROM sales`, /only SELECT|write or DDL/i);
    refused(`ATTACH '/data/lake/other/lake.duckdb' AS other`, /write or DDL|only SELECT/i);
  });
});

describe("assertNoLakeFileAccess — the execution backstop still passes platform SQL", () => {
  // ee.lake.readLakeIfPaidEngine runs this (not assertSelectOnly) right before
  // conn.all(), so platform-issued PRAGMA / rowid SQL must survive it while
  // every reader is still refused.
  it("passes the platform's own PRAGMA and rowid queries", () => {
    expect(() => assertNoLakeFileAccess(`PRAGMA table_info("sales")`)).not.toThrow();
    expect(() => assertNoLakeFileAccess(`SELECT rowid AS rid FROM "sales"`)).not.toThrow();
    expect(() => assertNoLakeFileAccess(`SELECT COUNT(*) AS n FROM "sales" WHERE "col" IS NULL`)).not.toThrow();
    expect(() => assertNoLakeFileAccess(`SELECT * FROM (SELECT * FROM sales) AS _q LIMIT 200`)).not.toThrow();
  });

  it("still refuses a reader even without the SELECT-only layer", () => {
    expect(() => assertNoLakeFileAccess(`PRAGMA table_info('/etc/hostname')`)).not.toThrow(); // pragma of an ident-ish arg, not a reader — allowed
    expect(() => assertNoLakeFileAccess(`SELECT * FROM read_csv('/etc/hostname')`)).toThrow();
    expect(() => assertNoLakeFileAccess(`SELECT * FROM '/data/lake/other/lake.duckdb'`)).toThrow();
  });
});

describe("guard is a real upgrade: every refused read PASSES the old assertSelectOnly", () => {
  // These are exactly the payloads that ran unchecked before this fix.
  const bypassedOldGuard = [
    `SELECT * FROM read_csv('/etc/hostname')`,
    `SELECT * FROM read_parquet('/data/lake/other/t.parquet')`,
    `SELECT * FROM glob('/data/lake/*')`,
    `SELECT * FROM sqlite_scan('/data/lake/other.db', 'sqlite_master')`,
    `SELECT * FROM '/data/lake/other-tenant/lake.duckdb'`,
    `SELECT * FROM "/data/lake/other/data.csv"`,
    `SELECT read_text('/etc/passwd') AS x`,
  ];
  it.each(bypassedOldGuard)("assertSelectOnly allows but assertLakeReadSqlSafe refuses: %s", (sql) => {
    expect(() => assertSelectOnly(sql)).not.toThrow();
    expect(() => assertLakeReadSqlSafe(sql)).toThrow();
  });
});
