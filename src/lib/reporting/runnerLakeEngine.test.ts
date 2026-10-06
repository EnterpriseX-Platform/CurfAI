/**
 * Regression coverage for the report runner's lake read path picking the
 * right engine.
 *
 * Before this fix, both "lake" branches in runner.ts (runReportWithProof
 * and runSingleQuery) called runOnSqlite() against tenantLakePath() — the
 * tenant's .db file — unconditionally, regardless of Tenant.lakeEngine.
 * A tenant on the DuckDB engine would have every write land in their
 * .duckdb file while every report kept reading the stale (or empty) .db
 * file: a real, silent data divergence, not a cosmetic gap. That's why
 * ENGINE_READ_PATH_UNIFIED in the lake-engine admin route blocks new
 * sqlite→duckdb migrations — see E1_ENGINE_UNIFICATION_PLAN.md, Phase A.
 *
 * This exercises the real runner + the real ee registry (src/ee/index.ts,
 * not mocked) so the test fails if the ee wiring regresses, not just if
 * the engine adapters' own logic changes. Only lib/lake/engine itself is
 * mocked, standing in for the real SQLite/DuckDB adapters.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LAKE_DB_PATH = path.join(os.tmpdir(), `curf-lake-engine-test-${Date.now()}.db`);

beforeAll(() => {
  const db = new Database(LAKE_DB_PATH);
  db.exec(`CREATE TABLE widgets (id TEXT, source TEXT)`);
  db.prepare(`INSERT INTO widgets (id, source) VALUES (?, ?)`).run("1", "sqlite-file");
  db.close();
});
afterAll(() => { try { fs.unlinkSync(LAKE_DB_PATH); } catch { /* best-effort */ } });

vi.mock("@/lib/lake/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lake/storage")>();
  return { ...actual, tenantLakePath: () => LAKE_DB_PATH };
});

let engineId: "sqlite" | "duckdb" = "sqlite";
const duckdbRows = [{ id: "1", source: "duckdb-file" }];
const duckdbConnClose = vi.fn(async () => {});
const openLakeForEngine = vi.fn(async () => ({
  engine: "duckdb" as const,
  all: vi.fn(async () => duckdbRows),
  exec: vi.fn(async () => {}),
  run: vi.fn(async () => ({ changes: 0 })),
  close: duckdbConnClose,
}));
const resolveEngineId = vi.fn(async () => engineId);

vi.mock("@/lib/lake/engine", () => ({ resolveEngineId, openLakeForEngine }));

const DS_ROW = {
  id: "ds1", tenantId: "t-engine", kind: "lake", connection: "lake://t-engine",
  name: "Widgets", ownerUserId: null as string | null, visibleToRolesJson: "[]",
};

vi.mock("@/lib/db", () => ({
  prisma: {
    dataSource: { findFirst: vi.fn(async ({ where }: any) => (where.id === "ds1" && where.tenantId === DS_ROW.tenantId ? DS_ROW : null)) },
    lakeTable: { findMany: vi.fn(async () => []) },
    membership: { findUnique: vi.fn(async () => null) },
  },
}));

import { runReportWithProof, runSingleQuery, SYSTEM_RUN } from "./runner";
import { ReportSchema } from "./schema";

function buildReport(sql: string) {
  return ReportSchema.parse({
    version: 1,
    name: "Lake engine routing test report",
    parameters: [],
    dataSources: [{ id: "q1", name: "Widgets", dataSourceId: "ds1", sql }],
    pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [] }],
  });
}

describe("runner lake reads — engine routing", () => {
  it("runReportWithProof reads the tenant's SQLite file when on the default engine", async () => {
    engineId = "sqlite";
    const report = buildReport("SELECT id, source FROM widgets -- sqlite-default");
    const { dataset } = await runReportWithProof({ report, params: {}, tenantId: "t-engine", viewer: SYSTEM_RUN });
    expect(dataset.q1).toEqual([{ id: "1", source: "sqlite-file" }]);
    expect(openLakeForEngine).not.toHaveBeenCalled();
  });

  it("runReportWithProof reads through the paid engine when the tenant is on DuckDB", async () => {
    engineId = "duckdb";
    const report = buildReport("SELECT id, source FROM widgets -- duckdb-engine");
    const { dataset } = await runReportWithProof({ report, params: {}, tenantId: "t-engine", viewer: SYSTEM_RUN });
    expect(dataset.q1).toEqual(duckdbRows);
    expect(openLakeForEngine).toHaveBeenCalledWith("t-engine");
    expect(duckdbConnClose).toHaveBeenCalled();
  });

  it("runSingleQuery (the dashboard-prefetch path) also routes to DuckDB for a DuckDB tenant", async () => {
    engineId = "duckdb";
    const report = buildReport("SELECT id, source FROM widgets -- duckdb-single-query");
    const rows = await runSingleQuery(report.dataSources[0], {}, SYSTEM_RUN, "t-engine");
    expect(rows).toEqual(duckdbRows);
  });
});
