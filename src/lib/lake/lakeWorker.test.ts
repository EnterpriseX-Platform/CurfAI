/**
 * lakeWorker — lake reads and big writes on a worker thread, against a real
 * (temporary) lake file: results come back, the row cap and the time limit
 * hold, a failed transaction changes nothing, and the event loop keeps
 * turning while a slow query runs.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "node:fs";

const root = vi.hoisted(() => {
  const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "curf-lakeworker-"));
  process.env.CURF_LAKE_DIR = dir;
  return dir as string;
});

import { runLakeRead, runLakeTransaction } from "./lakeWorker";
import { closeLake, openLake } from "./storage";

const T = "lw1";
afterAll(() => {
  closeLake(T);
  // The reader killed in the time-limit test lets go of the file as its
  // process exits, which on Windows can lag the end of the test: best effort.
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* left in the OS temp dir */ }
  delete process.env.CURF_LAKE_DIR;
});

const read = (sql: string, extra: Partial<Parameters<typeof runLakeRead>[0]> = {}) =>
  runLakeRead({ tenantId: T, sql, params: {}, cap: 1000, capMessage: "too many rows", timeoutMs: 10_000, timeoutMessage: "too slow", ...extra });

// Counting to n in SQL: one step that keeps SQLite busy, no table needed.
const slow = (n: number) => `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${n}) SELECT COUNT(*) AS n FROM c`;

describe("runLakeTransaction", () => {
  it("runs every statement in one transaction and returns each result", async () => {
    const out = await runLakeTransaction(T, [
      { sql: `CREATE TABLE t (a TEXT, b INTEGER)` },
      { sql: `INSERT INTO t VALUES (?, ?), (?, ?)`, params: ["x", 1, "y", 2] },
      { sql: `SELECT SUM(b) AS s FROM t`, mode: "get" },
      { sql: `SELECT a FROM t ORDER BY a`, mode: "all" },
    ]);
    expect(out).toEqual([0, 2, { s: 3 }, [{ a: "x" }, { a: "y" }]]);
    // The main thread's own connection sees the committed table.
    expect(openLake(T).prepare(`SELECT COUNT(*) AS n FROM t`).get()).toEqual({ n: 2 });
  });

  it("rolls the whole list back when one statement fails", async () => {
    await expect(runLakeTransaction(T, [
      { sql: `INSERT INTO t VALUES ('z', 3)` },
      { sql: `SELECT * FROM no_such_table`, mode: "all" },
    ])).rejects.toThrow(/no such table/);
    expect(openLake(T).prepare(`SELECT COUNT(*) AS n FROM t`).get()).toEqual({ n: 2 });
  });
});

describe("runLakeRead", () => {
  it("binds named parameters and returns the rows", async () => {
    expect(await read(`SELECT a, b FROM t WHERE b >= :min ORDER BY b`, { params: { min: 2 } })).toEqual([{ a: "y", b: 2 }]);
  });

  it("refuses more rows than the cap rather than cutting them silently", async () => {
    await expect(read(`SELECT * FROM t`, { cap: 1 })).rejects.toThrow("too many rows");
  });

  it("stops a query at its time limit, keeps the event loop free meanwhile, and carries on with the next", async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);
    const started = Date.now();
    await expect(read(slow(50_000_000), { timeoutMs: 300 })).rejects.toThrow("too slow");
    clearInterval(timer);
    expect(Date.now() - started).toBeLessThan(2_000);
    // On the main thread the interval couldn't have fired at all while SQLite counted.
    expect(ticks).toBeGreaterThan(10);
    expect(await read(`SELECT COUNT(*) AS n FROM t`)).toEqual([{ n: 2 }]);
  });

  it("runs queries side by side, and queues past the pool", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => read(`SELECT ${i} AS i`)));
    expect(results.map((r) => r[0].i)).toEqual([0, 1, 2, 3, 4]);
  });
});
