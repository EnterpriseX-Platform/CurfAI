/**
 * Regression coverage for createOrReplaceTable/dropTable's engine routing
 * (Phase B of E1_ENGINE_UNIFICATION_PLAN.md). Before this fix, both
 * functions always wrote to the tenant's SQLite file via openLake(),
 * regardless of Tenant.lakeEngine — so a DuckDB-engine tenant's writes
 * went to the wrong file while CDC/external tables wrote the .duckdb one.
 *
 * Exercises the real ee registry (src/ee/index.ts, not mocked) so this
 * fails if the ee wiring regresses, not just if the underlying engine
 * adapters' own logic changes. Only lib/lake/engine + duckdbWrite are
 * mocked, standing in for the real SQLite/DuckDB adapters — same pattern
 * as runnerLakeEngine.test.ts for the read path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LAKE_DB_PATH = path.join(os.tmpdir(), `curf-tables-engine-routing-${Date.now()}.db`);
afterEach(() => { try { fs.unlinkSync(LAKE_DB_PATH); } catch { /* best-effort */ } });
let openLakeCalls = 0;
beforeEach(() => { vi.clearAllMocks(); openLakeCalls = 0; });

vi.mock("./storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./storage")>();
  return { ...actual, openLake: (tenantId: string) => {
    openLakeCalls++;
    const db = new Database(LAKE_DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS __lake_meta (
        table_name TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_config_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        row_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    return db;
  } };
});

let engineId: "sqlite" | "duckdb" = "sqlite";
const resolveEngineId = vi.fn(async () => engineId);
const duckDbConn = { engine: "duckdb" as const, exec: vi.fn(), all: vi.fn(), run: vi.fn(), close: vi.fn(async () => {}) };
const openLakeForEngine = vi.fn(async () => duckDbConn);
vi.mock("@/lib/lake/engine", () => ({ resolveEngineId, openLakeForEngine }));

const createOrReplaceTableDuckDb = vi.fn(async () => ({ columns: [{ name: "a", type: "text" as const }], rowCount: 1, safeName: "t" }));
const dropTableDuckDb = vi.fn(async () => {});
let mockExistingCols: string[] = [];
const tableColumnsDuckDb = vi.fn(async () => mockExistingCols);
const appendRowsDuckDb = vi.fn(async () => ({ added: 1, newColumns: [] as string[] }));
const upsertLakeRowsByKeyDuckDb = vi.fn(async () => ({ upserted: 1, newColumns: [] as string[] }));
const retypeColumnDuckDb = vi.fn(async () => ({ updated: 1, unchanged: 0 }));
const addColumnDuckDb = vi.fn(async () => {});
const renameColumnDuckDb = vi.fn(async () => {});
const dropColumnDuckDb = vi.fn(async () => {});
const previewTypedConversionDuckDb = vi.fn(async () => ({
  tableName: "t", totalRows: 1, eligibleColumns: [] as any[], skippedColumns: [] as any[],
}));
const applyTypedConversionDuckDb = vi.fn(async () => ({
  convertedColumns: [] as string[], skippedColumns: [] as string[], lossyCells: 0, lossyByColumn: {} as Record<string, number>, columns: [] as any[],
}));
vi.mock("@/lib/lake/engine/duckdbWrite", () => ({
  createOrReplaceTableDuckDb, dropTableDuckDb, tableColumnsDuckDb, appendRowsDuckDb, upsertLakeRowsByKeyDuckDb,
  retypeColumnDuckDb, previewTypedConversionDuckDb, applyTypedConversionDuckDb,
  addColumnDuckDb, renameColumnDuckDb, dropColumnDuckDb,
}));

// E1b Phase D3 — the real guard queries Prisma (LakeBranch); mocked so this
// file never depends on a live database. Default is a passthrough; the
// D3 tests below make it reject to prove the conversion never runs.
const withTypedConversionGuard = vi.fn(async (_tenantId: string, fn: () => Promise<unknown>) => fn());
vi.mock("@/lib/lake/typedConversionGuard", () => ({ withTypedConversionGuard }));

import {
  createOrReplaceTable, dropTable, appendRows, upsertLakeRowsByKey,
  retypeColumn, previewTypedConversion, applyTypedConversion,
  addColumn, renameColumn, dropColumn,
} from "./tables";

describe("createOrReplaceTable — engine routing", () => {
  it("writes to the tenant's SQLite file when on the default engine", async () => {
    engineId = "sqlite";
    const result = await createOrReplaceTable({ tenantId: "t1", tableName: "widgets", rows: [{ a: "1" }], sourceKind: "upload" });
    expect(result.safeName).toBe("widgets");
    expect(openLakeForEngine).not.toHaveBeenCalled();
    expect(createOrReplaceTableDuckDb).not.toHaveBeenCalled();
    const db = new Database(LAKE_DB_PATH, { readonly: true });
    const row = db.prepare(`SELECT * FROM "widgets"`).get() as any;
    db.close();
    expect(row.a).toBe("1");
  });

  it("routes through the paid engine when the tenant is on DuckDB", async () => {
    engineId = "duckdb";
    const result = await createOrReplaceTable({ tenantId: "t2", tableName: "widgets", rows: [{ a: "1" }], sourceKind: "upload" });
    expect(result.safeName).toBe("t"); // from the mocked createOrReplaceTableDuckDb
    expect(createOrReplaceTableDuckDb).toHaveBeenCalledWith(
      duckDbConn,
      expect.objectContaining({ tableName: "widgets", sourceKind: "upload" }),
    );
    expect(duckDbConn.close).toHaveBeenCalled();
  });
});

describe("dropTable — engine routing", () => {
  it("drops from the tenant's SQLite file when on the default engine", async () => {
    engineId = "sqlite";
    await createOrReplaceTable({ tenantId: "t1", tableName: "gone", rows: [{ a: "1" }], sourceKind: "upload" });
    await dropTable("t1", "gone");
    expect(dropTableDuckDb).not.toHaveBeenCalled();
    const db = new Database(LAKE_DB_PATH, { readonly: true });
    expect(() => db.prepare(`SELECT * FROM "gone"`).get()).toThrow();
    db.close();
  });

  it("routes through the paid engine when the tenant is on DuckDB", async () => {
    engineId = "duckdb";
    await dropTable("t2", "widgets");
    expect(dropTableDuckDb).toHaveBeenCalledWith(duckDbConn, "widgets");
  });
});

describe("appendRows — engine routing", () => {
  it("appends to the tenant's SQLite file when on the default engine", async () => {
    engineId = "sqlite";
    await createOrReplaceTable({ tenantId: "t1", tableName: "log", rows: [{ a: "1" }], sourceKind: "upload" });
    const result = await appendRows({ tenantId: "t1", tableName: "log", rows: [{ a: "2" }] });
    expect(result.added).toBe(1);
    expect(appendRowsDuckDb).not.toHaveBeenCalled();
    const db = new Database(LAKE_DB_PATH, { readonly: true });
    const rows = db.prepare(`SELECT a FROM "log" ORDER BY a`).all() as any[];
    db.close();
    expect(rows.map((r) => r.a)).toEqual(["1", "2"]);
  });

  it("routes to the paid engine's append path when the table already exists there", async () => {
    engineId = "duckdb";
    mockExistingCols = ["a"]; // table already exists on the DuckDB side
    const result = await appendRows({ tenantId: "t2", tableName: "log", rows: [{ a: "2" }] });
    expect(result.added).toBe(1);
    expect(appendRowsDuckDb).toHaveBeenCalledWith(duckDbConn, { tableName: "log", rows: [{ a: "2" }], existingCols: ["a"] });
    expect(createOrReplaceTableDuckDb).not.toHaveBeenCalled();
  });

  it("falls through to the paid engine's create path on a cold start (table doesn't exist yet)", async () => {
    // This is the exact case that exposed the PRAGMA-throws-on-missing-
    // table dialect gap: tableColumnsDuckDb (not raw PRAGMA) must return
    // [] here, not throw, for this branch to be reachable at all.
    engineId = "duckdb";
    mockExistingCols = [];
    const result = await appendRows({ tenantId: "t3", tableName: "brand_new", rows: [{ a: "1" }] });
    expect(result.added).toBe(1); // from the mocked createOrReplaceTableDuckDb's rowCount
    expect(createOrReplaceTableDuckDb).toHaveBeenCalledWith(
      duckDbConn,
      expect.objectContaining({ tableName: "brand_new", sourceKind: "webhook" }),
    );
    expect(appendRowsDuckDb).not.toHaveBeenCalled();
  });
});

describe("upsertLakeRowsByKey — engine routing", () => {
  it("upserts into the tenant's SQLite file when on the default engine", async () => {
    engineId = "sqlite";
    const result = await upsertLakeRowsByKey({ tenantId: "t1", tableName: "customers", keyColumn: "id", rows: [{ id: "1", name: "Alice" }] });
    expect(result.upserted).toBe(1);
    expect(upsertLakeRowsByKeyDuckDb).not.toHaveBeenCalled();
    const db = new Database(LAKE_DB_PATH, { readonly: true });
    const row = db.prepare(`SELECT name FROM "customers"`).get() as any;
    db.close();
    expect(row.name).toBe("Alice");
  });

  it("routes through the paid engine when the tenant is on DuckDB", async () => {
    engineId = "duckdb";
    const result = await upsertLakeRowsByKey({ tenantId: "t2", tableName: "customers", keyColumn: "id", rows: [{ id: "1", name: "Alice" }] });
    expect(result.upserted).toBe(1);
    expect(upsertLakeRowsByKeyDuckDb).toHaveBeenCalledWith(
      duckDbConn,
      expect.objectContaining({ tableName: "customers", keyColumn: "id" }),
    );
  });
});

// E1b Phase D2 (E1B_PHASE_D_SCOPING_PLAN.md) — retypeColumn/
// previewTypedConversion/applyTypedConversion previously had NO engine
// routing at all (always touched the tenant's SQLite file regardless of
// Tenant.lakeEngine); this locks in the fix the same way the blocks above
// do for the functions that already had it.
describe("retypeColumn — engine routing", () => {
  it("retypes on the tenant's SQLite file when on the default engine", async () => {
    engineId = "sqlite";
    // columnTypeOverrides forces "v" to stay raw text at ingest — without
    // it, createOrReplaceTable's own cleaning would already normalize
    // "$100" to "100" before retypeColumn ever sees it, so this run
    // would report 0 updated instead of exercising a real change.
    await createOrReplaceTable({
      tenantId: "t1", tableName: "vals", rows: [{ v: "$100" }], sourceKind: "upload",
      columnTypeOverrides: { v: "text" },
    });
    const result = await retypeColumn({ tenantId: "t1", tableName: "vals", columnName: "v", type: "number" });
    expect(result.updated).toBe(1);
    expect(retypeColumnDuckDb).not.toHaveBeenCalled();
  });

  it("routes through the paid engine when the tenant is on DuckDB", async () => {
    engineId = "duckdb";
    const result = await retypeColumn({ tenantId: "t2", tableName: "vals", columnName: "v", type: "number" });
    expect(result.updated).toBe(1); // from the mocked retypeColumnDuckDb
    expect(retypeColumnDuckDb).toHaveBeenCalledWith(
      duckDbConn,
      expect.objectContaining({ tableName: "vals", columnName: "v", type: "number" }),
    );
  });
});

describe("previewTypedConversion — engine routing", () => {
  it("previews the tenant's SQLite file when on the default engine", async () => {
    engineId = "sqlite";
    await createOrReplaceTable({ tenantId: "t1", tableName: "vals2", rows: [{ v: "1" }], sourceKind: "upload" });
    const result = await previewTypedConversion({ tenantId: "t1", tableName: "vals2" });
    expect(result.tableName).toBe("vals2");
    expect(previewTypedConversionDuckDb).not.toHaveBeenCalled();
  });

  it("routes through the paid engine when the tenant is on DuckDB", async () => {
    engineId = "duckdb";
    const result = await previewTypedConversion({ tenantId: "t2", tableName: "vals2" });
    expect(result.tableName).toBe("t"); // from the mocked previewTypedConversionDuckDb
    expect(previewTypedConversionDuckDb).toHaveBeenCalledWith(duckDbConn, "vals2");
  });
});

describe("applyTypedConversion — engine routing", () => {
  const ORIGINAL_FLAG = process.env.CURF_LAKE_TYPED_COLUMNS;
  beforeEach(() => { process.env.CURF_LAKE_TYPED_COLUMNS = "true"; });
  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.CURF_LAKE_TYPED_COLUMNS;
    else process.env.CURF_LAKE_TYPED_COLUMNS = ORIGINAL_FLAG;
  });

  it("converts on the tenant's SQLite file when on the default engine", async () => {
    engineId = "sqlite";
    await createOrReplaceTable({ tenantId: "t1", tableName: "vals3", rows: [{ v: "1" }], sourceKind: "upload" });
    await applyTypedConversion({ tenantId: "t1", tableName: "vals3" });
    expect(applyTypedConversionDuckDb).not.toHaveBeenCalled();
  });

  it("routes through the paid engine when the tenant is on DuckDB", async () => {
    engineId = "duckdb";
    const result = await applyTypedConversion({ tenantId: "t2", tableName: "vals3", columns: ["v"] });
    expect(result.lossyCells).toBe(0); // from the mocked applyTypedConversionDuckDb
    expect(applyTypedConversionDuckDb).toHaveBeenCalledWith(duckDbConn, "vals3", ["v"], undefined);
  });

  it("passes the admin's confirmed lossy counts through to the paid engine, so the drift check can run there", async () => {
    engineId = "duckdb";
    await applyTypedConversion({ tenantId: "t2", tableName: "vals3", columns: ["v"], expectedLossy: { v: 3 } });
    expect(applyTypedConversionDuckDb).toHaveBeenCalledWith(duckDbConn, "vals3", ["v"], { v: 3 });
  });

  // E1b Phase D3 (E1B_PHASE_D_SCOPING_PLAN.md) — the branch/conversion
  // guard is enforced on the primitive itself, for both engines, not left
  // to whichever route calls it.
  it("runs the conversion inside the guard, keyed by tenant (SQLite)", async () => {
    engineId = "sqlite";
    await createOrReplaceTable({ tenantId: "t1", tableName: "vals4", rows: [{ v: "1" }], sourceKind: "upload" });
    await applyTypedConversion({ tenantId: "t1", tableName: "vals4" });
    expect(withTypedConversionGuard).toHaveBeenCalledTimes(1);
    expect(withTypedConversionGuard).toHaveBeenCalledWith("t1", expect.any(Function));
  });

  it("a guard refusal stops a SQLite conversion before it touches the table", async () => {
    engineId = "sqlite";
    // Seed as a LEGACY table (flag off) — with it on, Phase B would type the
    // column at creation and there'd be nothing left for a conversion to do.
    // Several clean numeric rows so the column would otherwise be eligible.
    delete process.env.CURF_LAKE_TYPED_COLUMNS;
    await createOrReplaceTable({
      tenantId: "t1", tableName: "vals5", sourceKind: "upload",
      rows: [{ v: "1" }, { v: "2" }, { v: "3" }],
    });
    process.env.CURF_LAKE_TYPED_COLUMNS = "true";
    withTypedConversionGuard.mockRejectedValueOnce(new Error("blocked by guard"));

    await expect(applyTypedConversion({ tenantId: "t1", tableName: "vals5" })).rejects.toThrow(/blocked by guard/);

    const db = new Database(LAKE_DB_PATH, { readonly: true });
    const ddl = db.prepare(`PRAGMA table_info("vals5")`).all() as Array<{ name: string; type: string }>;
    db.close();
    for (const col of ddl) expect(col.type).toBe("TEXT"); // untouched
  });

  it("a guard refusal stops a DuckDB conversion before the engine is even opened", async () => {
    engineId = "duckdb";
    withTypedConversionGuard.mockRejectedValueOnce(new Error("blocked by guard"));

    await expect(applyTypedConversion({ tenantId: "t2", tableName: "vals3" })).rejects.toThrow(/blocked by guard/);

    expect(applyTypedConversionDuckDb).not.toHaveBeenCalled();
    expect(openLakeForEngine).not.toHaveBeenCalled();
  });

  it("does not consult the guard when the flag is off — the flag check comes first", async () => {
    engineId = "sqlite";
    delete process.env.CURF_LAKE_TYPED_COLUMNS;
    await expect(applyTypedConversion({ tenantId: "t1", tableName: "vals4" })).rejects.toThrow(/not enabled/);
    expect(withTypedConversionGuard).not.toHaveBeenCalled();
  });
});

describe("previewTypedConversion — is read-only, so it is NOT guarded", () => {
  it("never consults the branch guard", async () => {
    engineId = "sqlite";
    await createOrReplaceTable({ tenantId: "t1", tableName: "vals6", rows: [{ v: "1" }], sourceKind: "upload" });
    await previewTypedConversion({ tenantId: "t1", tableName: "vals6" });
    expect(withTypedConversionGuard).not.toHaveBeenCalled();
  });
});

// The schema-editor route called addColumn/renameColumn/dropColumn directly
// with no engine check (and the DuckDB adapters for rename/drop didn't exist),
// so on a DuckDB tenant they opened — and could create — the stale SQLite
// file instead of altering the real table. Routed inside the functions, like
// retypeColumn, so no caller can forget.
describe("addColumn / renameColumn / dropColumn — engine routing", () => {
  it("alters the tenant's SQLite file when on the default engine, never touching the paid engine", async () => {
    engineId = "sqlite";
    await createOrReplaceTable({ tenantId: "t1", tableName: "cols", rows: [{ a: "1", b: "2" }], sourceKind: "upload" });
    await addColumn({ tenantId: "t1", tableName: "cols", columnName: "c" });
    await renameColumn({ tenantId: "t1", tableName: "cols", oldName: "a", newName: "alpha" });
    await dropColumn({ tenantId: "t1", tableName: "cols", columnName: "b" });
    const db = new Database(LAKE_DB_PATH, { readonly: true });
    const names = (db.prepare(`PRAGMA table_info("cols")`).all() as any[]).map((c) => c.name);
    db.close();
    expect(names).toEqual(["alpha", "c"]);
    expect(openLakeForEngine).not.toHaveBeenCalled();
    expect(openLakeCalls).toBeGreaterThan(0);
    expect(addColumnDuckDb).not.toHaveBeenCalled();
    expect(renameColumnDuckDb).not.toHaveBeenCalled();
    expect(dropColumnDuckDb).not.toHaveBeenCalled();
  });

  it("routes all three through the paid engine when the tenant is on DuckDB — and never opens the SQLite file", async () => {
    engineId = "duckdb";
    await addColumn({ tenantId: "t2", tableName: "cols", columnName: "c", defaultValue: "x" });
    await renameColumn({ tenantId: "t2", tableName: "cols", oldName: "a", newName: "alpha" });
    await dropColumn({ tenantId: "t2", tableName: "cols", columnName: "b" });
    expect(addColumnDuckDb).toHaveBeenCalledWith(duckDbConn, { tableName: "cols", columnName: "c", defaultValue: "x" });
    expect(renameColumnDuckDb).toHaveBeenCalledWith(duckDbConn, { tableName: "cols", oldName: "a", newName: "alpha" });
    expect(dropColumnDuckDb).toHaveBeenCalledWith(duckDbConn, { tableName: "cols", columnName: "b" });
    expect(duckDbConn.close).toHaveBeenCalledTimes(3);
    expect(openLakeCalls).toBe(0);
  });

  it("surfaces a paid-engine failure to the caller (it doesn't fall through to SQLite) and still closes the connection", async () => {
    engineId = "duckdb";
    renameColumnDuckDb.mockRejectedValueOnce(new Error("Column \"a\" not found"));
    await expect(renameColumn({ tenantId: "t3", tableName: "cols", oldName: "a", newName: "b" })).rejects.toThrow(/not found/);
    expect(duckDbConn.close).toHaveBeenCalledTimes(1);
    expect(openLakeCalls).toBe(0);
  });
});
