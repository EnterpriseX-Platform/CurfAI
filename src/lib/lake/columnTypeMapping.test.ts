/**
 * E1b Phase A (E1B_TYPED_COLUMNS_SCOPING_PLAN.md) — regression coverage
 * for sqlTypeForLakeColumn (the SQLite half of the label → physical DDL
 * type mapping). See engine/duckdbTypeMapping.test.ts for the DuckDB
 * half — split into two files because this one lives in a
 * Community-shipped location and duckdbTypeForLakeColumn lives in
 * lib/lake/engine/, which is excluded from Community entirely; a single
 * test file importing both would cross that boundary.
 *
 * Not wired into any write path yet (that's Phase B), but exercised
 * here against a real SQLite file with the exact value shapes Phase B
 * would eventually bind — proving the chosen DDL types actually work for
 * their intended purpose before anything depends on them, not just that
 * the mapping function returns a plausible-looking string.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { sqlTypeForLakeColumn, type LakeColumn } from "./tables";

describe("sqlTypeForLakeColumn — mapping", () => {
  it("maps every LakeColumn type to its SQLite DDL type", () => {
    const cases: Array<[LakeColumn["type"], string]> = [
      ["text", "TEXT"], ["number", "REAL"], ["boolean", "INTEGER"],
      ["date", "TEXT"], ["unknown", "TEXT"],
    ];
    for (const [type, expected] of cases) expect(sqlTypeForLakeColumn(type)).toBe(expected);
  });
});

const openSqliteFiles: string[] = [];
afterEach(() => {
  while (openSqliteFiles.length > 0) {
    const p = openSqliteFiles.pop()!;
    try { fs.unlinkSync(p); } catch { /* best-effort */ }
  }
});

describe("sqlTypeForLakeColumn — real SQLite execution", () => {
  it("REAL column stores and returns a native number, not a string", () => {
    const p = path.join(os.tmpdir(), `curf-sqltype-test-${Date.now()}.db`);
    openSqliteFiles.push(p);
    const db = new Database(p);
    try {
      db.exec(`CREATE TABLE t (n ${sqlTypeForLakeColumn("number")})`);
      db.prepare(`INSERT INTO t (n) VALUES (?)`).run(1234.56);
      const row = db.prepare(`SELECT n FROM t`).get() as { n: number };
      expect(row.n).toBe(1234.56);
      expect(typeof row.n).toBe("number");
    } finally {
      db.close();
    }
  });

  it("INTEGER column round-trips a 0/1 boolean encoding", () => {
    const p = path.join(os.tmpdir(), `curf-sqltype-test-${Date.now()}.db`);
    openSqliteFiles.push(p);
    const db = new Database(p);
    try {
      db.exec(`CREATE TABLE t (b ${sqlTypeForLakeColumn("boolean")})`);
      db.prepare(`INSERT INTO t (b) VALUES (?), (?)`).run(1, 0);
      const rows = db.prepare(`SELECT b FROM t ORDER BY b`).all() as Array<{ b: number }>;
      expect(rows.map((r) => r.b)).toEqual([0, 1]);
    } finally {
      db.close();
    }
  });

  it("TEXT date column preserves ISO ordering under a lexical sort", () => {
    const p = path.join(os.tmpdir(), `curf-sqltype-test-${Date.now()}.db`);
    openSqliteFiles.push(p);
    const db = new Database(p);
    try {
      db.exec(`CREATE TABLE t (d ${sqlTypeForLakeColumn("date")})`);
      db.prepare(`INSERT INTO t (d) VALUES (?), (?), (?)`).run("2026-09-17", "2026-01-01", "2026-12-31");
      const rows = db.prepare(`SELECT d FROM t ORDER BY d`).all() as Array<{ d: string }>;
      expect(rows.map((r) => r.d)).toEqual(["2026-01-01", "2026-09-17", "2026-12-31"]);
    } finally {
      db.close();
    }
  });
});
