/**
 * Regression coverage for backup.ts's engine routing (Phase D of
 * E1_ENGINE_UNIFICATION_PLAN.md). Before this fix, snapshotTenant/
 * restoreBackup always assumed the tenant's live file was at
 * tenantLakePath() (SQLite, always .db) — a DuckDB-engine tenant's real
 * live file lives elsewhere, so the very first existence check would
 * have said "no lake file" for every DuckDB tenant regardless of how
 * much data they actually had.
 *
 * Mocks @/ee to simulate a paid-engine tenant, proving snapshotTenant/
 * restoreBackup call into it instead of silently falling through to
 * SQLite-only assumptions — same pattern as tablesEngineRouting.test.ts
 * for the read/write path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// backup.ts's BACKUP_ROOT is a module-level const computed from
// CURF_LAKE_BACKUP_DIR at import time — set inside vi.hoisted() so it
// lands before the `import "./backup"` below resolves, or backup.ts
// writes its temp/final files into the real project's lake/backups/.
const dirs = vi.hoisted(() => {
  const nodePath = require("node:path");
  const nodeOs = require("node:os");
  const nodeFs = require("node:fs");
  const root = nodePath.join(nodeOs.tmpdir(), `curf-backup-routing-test-${Date.now()}`);
  nodeFs.mkdirSync(root, { recursive: true });
  process.env.CURF_LAKE_BACKUP_DIR = nodePath.join(root, "backups");
  return { root };
});
const LAKE_DIR = dirs.root;

vi.mock("./storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./storage")>();
  return {
    ...actual,
    tenantLakePath: (tenantId: string) => path.join(LAKE_DIR, `${tenantId}.db`),
    closeLake: vi.fn(),
    openLake: vi.fn(),
  };
});

vi.mock("@/lib/db", () => {
  const backupRows: Record<string, any> = {};
  let nextId = 1;
  return {
    prisma: {
      lakeBackup: {
        create: vi.fn(async ({ data }: any) => {
          const id = `backup${nextId++}`;
          backupRows[id] = { id, ...data };
          return backupRows[id];
        }),
        update: vi.fn(async ({ where, data }: any) => { Object.assign(backupRows[where.id], data); return backupRows[where.id]; }),
        delete: vi.fn(async ({ where }: any) => { delete backupRows[where.id]; }),
        findFirst: vi.fn(async ({ where }: any) => backupRows[where.id] ?? null),
      },
      // Not under test here (see catalogReconcile.test.ts) — restoreBackup()
      // reconciles the catalog after every restore, so these need to exist
      // and return empty rather than throw.
      lakeTable: {
        findMany: vi.fn(async () => []),
        create: vi.fn(async ({ data }: any) => ({ id: "lt1", ...data })),
        delete: vi.fn(async () => {}),
      },
      materializedView: {
        findMany: vi.fn(async () => []),
      },
      tenant: {
        findUnique: vi.fn(async () => null),
      },
    },
  };
});

const eeMocks = vi.hoisted(() => {
  const state = { paidExists: true };
  return {
    state,
    paidLiveLakeFile: vi.fn(),
    cloneLakeFileIfPaidEngine: vi.fn(),
    countTablesInFileIfPaidEngine: vi.fn(async () => 3),
    integrityCheckIfPaidEngineFile: vi.fn(async () => null),
    shipSnapshotToDestinations: vi.fn(async () => {}),
    // Records what the live file held on entering and leaving the lock, so a
    // test can tell the swap really happened INSIDE it.
    lockLog: [] as Array<{ phase: "enter" | "exit"; live: string | null }>,
    withLiveLakeFileLock: vi.fn(),
  };
});
vi.mock("@/ee", () => ({
  ee: {
    lake: {
      paidLiveLakeFile: eeMocks.paidLiveLakeFile,
      cloneLakeFileIfPaidEngine: eeMocks.cloneLakeFileIfPaidEngine,
      countTablesInFileIfPaidEngine: eeMocks.countTablesInFileIfPaidEngine,
      integrityCheckIfPaidEngineFile: eeMocks.integrityCheckIfPaidEngineFile,
      shipSnapshotToDestinations: eeMocks.shipSnapshotToDestinations,
      withLiveLakeFileLock: eeMocks.withLiveLakeFileLock,
      // The post-restore catalog reconcile (not under test here) sees an empty file.
      liveLakeReaderIfPaidEngine: async () => ({ listTables: async () => [], open: async () => ({ all: async () => [], close: async () => {} }) }),
    },
  },
}));

import { snapshotTenant, restoreBackup } from "./backup";

beforeEach(() => {
  eeMocks.state.paidExists = true;
  eeMocks.paidLiveLakeFile.mockImplementation(async () => ({
    path: path.join(LAKE_DIR, "paid-tenant.duckdb"),
    exists: eeMocks.state.paidExists,
  }));
  eeMocks.paidLiveLakeFile.mockClear();
  eeMocks.cloneLakeFileIfPaidEngine.mockClear();
  eeMocks.cloneLakeFileIfPaidEngine.mockImplementation(async (_tenantId: string, destPath: string) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, "fake duckdb bytes");
    return { sizeBytes: 18 };
  });
  eeMocks.countTablesInFileIfPaidEngine.mockClear();
  eeMocks.integrityCheckIfPaidEngineFile.mockClear();
  eeMocks.lockLog.length = 0;
  eeMocks.withLiveLakeFileLock.mockReset();
  eeMocks.withLiveLakeFileLock.mockImplementation(async (_tenantId: string, fn: () => Promise<unknown>) => {
    const live = path.join(LAKE_DIR, "paid-tenant.duckdb");
    const read = () => (fs.existsSync(live) ? fs.readFileSync(live, "utf8") : null);
    eeMocks.lockLog.push({ phase: "enter", live: read() });
    try {
      return await fn();
    } finally {
      eeMocks.lockLog.push({ phase: "exit", live: read() });
    }
  });
});
afterEach(() => {
  for (const f of fs.readdirSync(LAKE_DIR)) fs.rmSync(path.join(LAKE_DIR, f), { force: true, recursive: true });
});

describe("snapshotTenant — engine routing", () => {
  it("clones the paid-engine tenant's live file instead of assuming a SQLite path", async () => {
    const result = await snapshotTenant({ tenantId: "paid-tenant", kind: "manual" });
    expect(result.skipped).toBeUndefined();
    expect(eeMocks.cloneLakeFileIfPaidEngine).toHaveBeenCalledWith("paid-tenant", expect.stringContaining(".tmp.db"));
    expect(result.tableCount).toBe(3);
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it("skips cleanly (not a false 'no lake file') when the paid engine's live file doesn't exist yet", async () => {
    eeMocks.state.paidExists = false;
    const result = await snapshotTenant({ tenantId: "paid-tenant", kind: "manual" });
    expect(result.skipped).toBe("no-lake-file");
    expect(eeMocks.cloneLakeFileIfPaidEngine).not.toHaveBeenCalled();
  });
});

describe("restoreBackup — engine routing", () => {
  it("restores onto the paid-engine tenant's live path and integrity-checks via the paid engine", async () => {
    // Seed a "backup" gzip file the restore will read from.
    const backup = await snapshotTenant({ tenantId: "paid-tenant", kind: "manual" });
    const result = await restoreBackup({ tenantId: "paid-tenant", backupId: backup.backupId });
    expect(result.ok).toBe(true);
    expect(eeMocks.integrityCheckIfPaidEngineFile).toHaveBeenCalledWith("paid-tenant", expect.stringContaining(".restore.tmp"));
    // The live file (resolved via paidLiveLakeFile) now holds the restored bytes.
    const livePath = path.join(LAKE_DIR, "paid-tenant.duckdb");
    expect(fs.existsSync(livePath)).toBe(true);
    expect(fs.readFileSync(livePath, "utf8")).toBe("fake duckdb bytes");
  });

  // The swap replaces the live file itself, so it has to hold the file's lock:
  // otherwise an operation in flight keeps working on the unlinked old file
  // (POSIX) or the rename fails under it (Windows), and a DuckDB open landing
  // between the unlink and the rename creates an empty database at the live path.
  it("swaps the live file while holding its lock — and only the swap, not the snapshot/integrity steps", async () => {
    const livePath = path.join(LAKE_DIR, "paid-tenant.duckdb");
    const backup = await snapshotTenant({ tenantId: "paid-tenant", kind: "manual" });
    fs.writeFileSync(livePath, "OLD live contents");

    await restoreBackup({ tenantId: "paid-tenant", backupId: backup.backupId });

    expect(eeMocks.withLiveLakeFileLock).toHaveBeenCalledTimes(1);
    expect(eeMocks.withLiveLakeFileLock).toHaveBeenCalledWith("paid-tenant", expect.any(Function));
    expect(eeMocks.lockLog).toEqual([
      { phase: "enter", live: "OLD live contents" }, // still the old file when the lock is taken
      { phase: "exit", live: "fake duckdb bytes" },  // replaced by the time it is released
    ]);
    // The integrity check needs the staged file, so it ran outside the lock, before it.
    expect(eeMocks.integrityCheckIfPaidEngineFile).toHaveBeenCalledTimes(1);
  });
});
