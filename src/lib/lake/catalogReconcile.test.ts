/**
 * Regression coverage for the backup/branch restore catalog-drift bug:
 * a whole-file swap can bring back a table the catalog thinks is deleted
 * (orphan) or leave a catalog row for a table the swapped-in file doesn't
 * have (dangling). See catalogReconcile.ts's header for the full story.
 *
 * Runs against a REAL SQLite file via better-sqlite3 (not a mocked engine)
 * per this repo's "verify against a live file" bar — only the Prisma
 * catalog is mocked, matching sourceGovernance.test.ts's in-memory-catalog
 * pattern.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// storage.ts's LAKE_DIR is a module-level const read from CURF_LAKE_DIR
// at import time — set it inside vi.hoisted() so it lands before
// catalogReconcile.ts (which imports storage.ts) resolves.
const dirs = vi.hoisted(() => {
  const nodePath = require("node:path");
  const nodeOs = require("node:os");
  const nodeFs = require("node:fs");
  const root = nodePath.join(nodeOs.tmpdir(), `curf-catalog-reconcile-test-${Date.now()}`);
  nodeFs.mkdirSync(root, { recursive: true });
  process.env.CURF_LAKE_DIR = root;
  return { root };
});
const LAKE_DIR = dirs.root;

const h = vi.hoisted(() => ({
  /** LakeTable catalog rows, keyed by id. */
  lakeTables: new Map<string, any>(),
  materializedViews: [] as any[],
  nextId: 1,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    lakeTable: {
      findMany: vi.fn(async ({ where }: any) =>
        [...h.lakeTables.values()].filter((r) => r.tenantId === where.tenantId)),
      create: vi.fn(async ({ data }: any) => {
        const id = `lt${h.nextId++}`;
        const row = { id, sourceConfigJson: null, sizeBytes: 0, rowCount: 0, ...data };
        h.lakeTables.set(id, row);
        return row;
      }),
      delete: vi.fn(async ({ where }: any) => {
        h.lakeTables.delete(where.id);
      }),
    },
    materializedView: {
      findMany: vi.fn(async ({ where }: any) =>
        h.materializedViews.filter((r) => r.tenantId === where.tenantId)),
    },
    // resolveEngineId() looks this up; a rejected/undefined column falls
    // back to "sqlite" either way, but keep it explicit and non-throwing.
    tenant: {
      findUnique: vi.fn(async () => ({ lakeEngine: "sqlite" })),
    },
    // bustLakeCacheForTenant's own lookup — irrelevant here, just quiet.
    dataSource: {
      findMany: vi.fn(async () => []),
    },
  },
}));

import { reconcileLakeCatalog } from "./catalogReconcile";
import { closeLake } from "./storage";

const TENANT = "tenant-1";
function liveDbPath() {
  return path.join(LAKE_DIR, `${TENANT}.db`);
}

beforeEach(() => {
  h.lakeTables.clear();
  h.materializedViews.length = 0;
  h.nextId = 1;
});
afterEach(() => {
  // As restoreBackup()'s swap does: drop openLake()'s cached handle first.
  closeLake(TENANT);
  for (const f of fs.readdirSync(LAKE_DIR)) fs.rmSync(path.join(LAKE_DIR, f), { force: true, recursive: true });
});

function seedRow(overrides: Partial<any> = {}) {
  const id = `lt${h.nextId++}`;
  const row = { id, tenantId: TENANT, name: "campaign_performance", sourceKind: "manual", schemaJson: "[]", rowCount: 0, sizeBytes: 0, ...overrides };
  h.lakeTables.set(id, row);
  return row;
}

describe("reconcileLakeCatalog", () => {
  it("re-creates a LakeTable row for a table that's physically present but has no catalog row (restore brought a deleted table back)", async () => {
    const db = new Database(liveDbPath());
    db.exec(`CREATE TABLE __lake_meta (table_name TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_config_json TEXT, row_count INTEGER NOT NULL DEFAULT 0)`);
    db.exec(`CREATE TABLE campaign_performance (id TEXT, spend TEXT, clicks TEXT)`);
    db.prepare(`INSERT INTO campaign_performance VALUES (?, ?, ?)`).run("1", "100.50", "42");
    db.prepare(`INSERT INTO campaign_performance VALUES (?, ?, ?)`).run("2", "200.75", "83");
    db.prepare(`INSERT INTO __lake_meta (table_name, source_kind, source_config_json, row_count) VALUES (?, ?, ?, ?)`)
      .run("campaign_performance", "upload", JSON.stringify({ filename: "camp.csv" }), 2);
    db.close();

    expect(await reconcileLakeCatalog(TENANT)).toEqual({
      restoredTables: ["campaign_performance"],
      droppedTables: [],
    });

    const rows = [...h.lakeTables.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: TENANT,
      name: "campaign_performance",
      sourceKind: "upload",
      rowCount: 2,
    });
    expect(JSON.parse(rows[0].sourceConfigJson)).toEqual({ filename: "camp.csv" });
    const columns = JSON.parse(rows[0].schemaJson);
    expect(columns.map((c: any) => c.name).sort()).toEqual(["clicks", "id", "spend"]);
  });

  it("removes a LakeTable row whose physical table no longer exists after restoring an older snapshot", async () => {
    seedRow({ name: "gone_table" });
    const db = new Database(liveDbPath());
    db.exec(`CREATE TABLE __lake_meta (table_name TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_config_json TEXT, row_count INTEGER NOT NULL DEFAULT 0)`);
    db.close();

    expect(await reconcileLakeCatalog(TENANT)).toEqual({
      restoredTables: [],
      droppedTables: ["gone_table"],
    });
    expect(h.lakeTables.size).toBe(0);
  });

  it("leaves the catalog untouched when it already matches the physical file", async () => {
    seedRow({ name: "stable_table" });
    const db = new Database(liveDbPath());
    db.exec(`CREATE TABLE __lake_meta (table_name TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_config_json TEXT, row_count INTEGER NOT NULL DEFAULT 0)`);
    db.exec(`CREATE TABLE stable_table (id TEXT)`);
    db.close();

    expect(await reconcileLakeCatalog(TENANT)).toEqual({ restoredTables: [], droppedTables: [] });
    expect(h.lakeTables.size).toBe(1);
  });

  it("never treats a materialized view's output table as an orphan LakeTable", async () => {
    h.materializedViews.push({ tenantId: TENANT, name: "Daily Rollup" });
    const db = new Database(liveDbPath());
    db.exec(`CREATE TABLE __lake_meta (table_name TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_config_json TEXT, row_count INTEGER NOT NULL DEFAULT 0)`);
    db.exec(`CREATE TABLE mv_daily_rollup (id TEXT)`);
    db.close();

    expect(await reconcileLakeCatalog(TENANT)).toEqual({ restoredTables: [], droppedTables: [] });
    expect(h.lakeTables.size).toBe(0);
  });

  it("handles both directions in a single restore", async () => {
    seedRow({ name: "gone_table" });
    const db = new Database(liveDbPath());
    db.exec(`CREATE TABLE __lake_meta (table_name TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_config_json TEXT, row_count INTEGER NOT NULL DEFAULT 0)`);
    db.exec(`CREATE TABLE resurrected (id TEXT)`);
    db.close();

    const result = await reconcileLakeCatalog(TENANT);
    expect(result.droppedTables).toEqual(["gone_table"]);
    expect(result.restoredTables).toEqual(["resurrected"]);
    const rows = [...h.lakeTables.values()];
    expect(rows.map((r) => r.name)).toEqual(["resurrected"]);
  });
});
