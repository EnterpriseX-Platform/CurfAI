/**
 * E2 Phase E (E2_JOBS_SCOPING_PLAN.md §5) — snapshotTenant's 23h "too
 * recent" auto-snapshot check was a soft dedupe: two concurrent callers
 * (the cron sweep and a manual "Snapshot now" click, or two overlapping
 * cron ticks) could both pass it before either committed a new LakeBackup
 * row, and both proceed to snapshot. This pins that a lease now closes the
 * race, scoped to Tenant.backupLeasedBy/backupLeasedUntil (see that
 * column's own schema comment for why it's a local pair rather than
 * lib/cron/leases.ts's generic functions).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dirs = vi.hoisted(() => {
  const nodePath = require("node:path");
  const nodeOs = require("node:os");
  const nodeFs = require("node:fs");
  const root = nodePath.join(nodeOs.tmpdir(), `curf-backup-lease-test-${Date.now()}`);
  nodeFs.mkdirSync(root, { recursive: true });
  process.env.CURF_LAKE_BACKUP_DIR = nodePath.join(root, "backups");
  return { root };
});
const LAKE_DIR = dirs.root;

vi.mock("./storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./storage")>();
  return { ...actual, tenantLakePath: (tenantId: string) => path.join(LAKE_DIR, `${tenantId}.db`), closeLake: vi.fn(), openLake: vi.fn() };
});

const state = vi.hoisted(() => ({
  backupRows: {} as Record<string, any>,
  tenantRow: { id: "t1", backupLeasedBy: null as string | null, backupLeasedUntil: null as Date | null },
  nextId: 1,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    lakeBackup: {
      create: vi.fn(async ({ data }: any) => {
        const id = `backup${state.nextId++}`;
        state.backupRows[id] = { id, ...data };
        return state.backupRows[id];
      }),
      update: vi.fn(async ({ where, data }: any) => { Object.assign(state.backupRows[where.id], data); return state.backupRows[where.id]; }),
      delete: vi.fn(async ({ where }: any) => { delete state.backupRows[where.id]; }),
      findFirst: vi.fn(async () => null), // no prior auto backup — "too recent" never fires on its own
    },
    tenant: {
      // Same conditional-UPDATE shape as lib/cron/leases.ts's acquireLeaseOn,
      // against the row's own backupLeasedBy/backupLeasedUntil fields.
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (where.id !== state.tenantRow.id) return { count: 0 };
        if (where.backupLeasedBy != null) {
          // release path: only succeeds if the caller still owns it
          if (state.tenantRow.backupLeasedBy !== where.backupLeasedBy) return { count: 0 };
          Object.assign(state.tenantRow, data);
          return { count: 1 };
        }
        const now = new Date();
        const eligible = state.tenantRow.backupLeasedBy == null || state.tenantRow.backupLeasedUntil == null || state.tenantRow.backupLeasedUntil < now;
        if (!eligible) return { count: 0 };
        Object.assign(state.tenantRow, data);
        return { count: 1 };
      }),
    },
  },
}));

vi.mock("@/ee", () => ({
  ee: {
    lake: {
      paidLiveLakeFile: vi.fn(async () => ({ path: path.join(LAKE_DIR, "t1.duckdb"), exists: true })),
      cloneLakeFileIfPaidEngine: vi.fn(async (_t: string, dest: string) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, "fake bytes");
        return { sizeBytes: 11 };
      }),
      countTablesInFileIfPaidEngine: vi.fn(async () => 1),
      shipSnapshotToDestinations: vi.fn(async () => {}),
    },
  },
}));

import { snapshotTenant } from "./backup";

beforeEach(() => {
  state.backupRows = {};
  state.tenantRow.backupLeasedBy = null;
  state.tenantRow.backupLeasedUntil = null;
});
afterEach(() => {
  for (const f of fs.readdirSync(LAKE_DIR)) fs.rmSync(path.join(LAKE_DIR, f), { force: true, recursive: true });
});

describe("snapshotTenant — auto-snapshot lease (E2 Phase E)", () => {
  it("two concurrent auto snapshots for the same tenant: one runs, one is skipped as too-recent", async () => {
    const [a, b] = await Promise.all([
      snapshotTenant({ tenantId: "t1", kind: "auto" }),
      snapshotTenant({ tenantId: "t1", kind: "auto" }),
    ]);
    const results = [a, b];
    const ran = results.filter((r) => !r.skipped);
    const skipped = results.filter((r) => r.skipped === "too-recent");
    expect(ran).toHaveLength(1);
    expect(skipped).toHaveLength(1);
  });

  it("releases the lease after a successful auto snapshot, so a later call can proceed", async () => {
    const first = await snapshotTenant({ tenantId: "t1", kind: "auto" });
    expect(first.skipped).toBeUndefined();
    expect(state.tenantRow.backupLeasedBy).toBeNull(); // released

    // findFirst still returns null (no real "too recent" backup tracked in
    // this fixture) — proves the SECOND call isn't blocked by a stuck lease.
    const second = await snapshotTenant({ tenantId: "t1", kind: "auto" });
    expect(second.skipped).toBeUndefined();
  });

  it("manual snapshots bypass the lease entirely, even while an auto snapshot holds it", async () => {
    state.tenantRow.backupLeasedBy = "someone-else";
    state.tenantRow.backupLeasedUntil = new Date(Date.now() + 60_000);

    const manual = await snapshotTenant({ tenantId: "t1", kind: "manual" });
    expect(manual.skipped).toBeUndefined();
  });

  it("releases the lease even when the physical snapshot throws", async () => {
    const { ee } = await import("@/ee");
    vi.mocked(ee.lake!.cloneLakeFileIfPaidEngine).mockRejectedValueOnce(new Error("disk full"));

    await expect(snapshotTenant({ tenantId: "t1", kind: "auto" })).rejects.toThrow("disk full");
    expect(state.tenantRow.backupLeasedBy).toBeNull();
  });
});
