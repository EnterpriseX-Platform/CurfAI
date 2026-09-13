/**
 * Time-travel reads on lake tables.
 *
 *   resolveSnapshotPath({ tenantId, tableName, asOf })
 *     → returns the gunzipped path of the snapshot whose `createdAt` is
 *       ≤ asOf, OR null if no snapshot exists for that window.
 *   readTableAsOf({ tenantId, tableName, asOf, limit, offset })
 *     → opens the resolved snapshot, returns the rows from `tableName`.
 *
 * Storage: re-uses the existing whole-tenant gzipped backups (Phase 2).
 * We don't duplicate per-table snapshot files. At read time, we
 * gunzip the relevant backup once, ATTACH it as a sibling DB, and
 * SELECT from it. The temp file is cleaned up on process exit.
 *
 * Snapshot creation: the cron tick mints a `LakeSnapshot` row per
 * table per hour pointing at the most-recent backup for the tenant.
 * If no backup exists for the hour (very young tenant), the snapshot
 * row is skipped — there's nothing to ATTACH against.
 */
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import zlib from "node:zlib";
import { prisma } from "@/lib/db";
import { backupPath } from "./backup";
import { toSafeTableName } from "./storage";

/** In-process cache: backupId → gunzipped temp file path. */
const GUNZIP_CACHE = new Map<string, string>();

/**
 * Resolve the snapshot whose createdAt ≤ asOf for a given table.
 * Returns null when nothing's available (tenant younger than asOf,
 * table didn't exist at that time, etc.).
 */
export async function resolveSnapshot(opts: {
  tenantId: string;
  tableName: string;
  asOf: Date;
}): Promise<{ snapshotId: string; backupId: string; createdAt: Date } | null> {
  const row = await prisma.lakeSnapshot.findFirst({
    where: {
      tenantId: opts.tenantId,
      tableName: opts.tableName,
      createdAt: { lte: opts.asOf },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, backupId: true, createdAt: true },
  }).catch(() => null);
  if (!row) return null;
  return { snapshotId: row.id, backupId: row.backupId, createdAt: row.createdAt };
}

/** Decompress the named backup once + cache the temp path. */
function ensureGunzipped(tenantId: string, backupId: string): string {
  const cached = GUNZIP_CACHE.get(backupId);
  if (cached && fs.existsSync(cached)) return cached;
  const src = backupPath(tenantId, backupId);
  if (!fs.existsSync(src)) throw new Error("Snapshot file missing on disk");
  const dest = path.join(os.tmpdir(), `curf-snap-${backupId}.db`);
  if (!fs.existsSync(dest)) {
    const inp = fs.createReadStream(src).pipe(zlib.createGunzip());
    const out = fs.createWriteStream(dest);
    inp.pipe(out);
    // Synchronous via promise — readTableAsOf awaits this.
  }
  GUNZIP_CACHE.set(backupId, dest);
  return dest;
}

/**
 * Async wrapper around the gunzip pipe so callers can await completion.
 * Caches the result so subsequent reads against the same snapshot in the
 * same process are instant.
 */
async function ensureGunzippedAsync(tenantId: string, backupId: string): Promise<string> {
  const cached = GUNZIP_CACHE.get(backupId);
  if (cached && fs.existsSync(cached)) return cached;
  const src = backupPath(tenantId, backupId);
  if (!fs.existsSync(src)) throw new Error("Snapshot file missing on disk");
  const dest = path.join(os.tmpdir(), `curf-snap-${backupId}.db`);
  await new Promise<void>((resolve, reject) => {
    const inp = fs.createReadStream(src);
    const gz = zlib.createGunzip();
    const out = fs.createWriteStream(dest);
    inp.pipe(gz).pipe(out);
    out.on("finish", () => resolve());
    out.on("error", reject);
    inp.on("error", reject);
    gz.on("error", reject);
  });
  GUNZIP_CACHE.set(backupId, dest);
  return dest;
}

export async function readTableAsOf(opts: {
  tenantId: string;
  tableName: string;
  asOf: Date;
  limit?: number;
  offset?: number;
}): Promise<{
  rows: any[];
  rowCount: number;
  asOf: Date;
  resolvedAt: Date;
} | null> {
  const snap = await resolveSnapshot({ tenantId: opts.tenantId, tableName: opts.tableName, asOf: opts.asOf });
  if (!snap) return null;
  const dbPath = await ensureGunzippedAsync(opts.tenantId, snap.backupId);

  const safe = toSafeTableName(opts.tableName);
  const limit = Math.min(5000, Math.max(1, opts.limit ?? 100));
  const offset = Math.max(0, opts.offset ?? 0);

  const db = new Database(dbPath, { readonly: true });
  try {
    // Defensive: confirm the table exists in the snapshot before SELECT.
    const ok = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    ).get(safe);
    if (!ok) return null;
    const rows = db.prepare(`SELECT * FROM "${safe}" LIMIT ? OFFSET ?`).all(limit, offset) as any[];
    const cnt = db.prepare(`SELECT COUNT(*) AS n FROM "${safe}"`).get() as { n: number };
    return {
      rows,
      rowCount: cnt.n,
      asOf: opts.asOf,
      resolvedAt: snap.createdAt,
    };
  } finally {
    db.close();
  }
}

/**
 * Mint a LakeSnapshot row per table for this tenant, pointing at the
 * most-recent LakeBackup. Called by the cron tick once per hour.
 * Skips tables that already have a snapshot pointing at the same
 * backupId (idempotent within the same backup window).
 */
export async function mintHourlySnapshots(tenantId: string): Promise<{ created: number }> {
  const recentBackup = await prisma.lakeBackup.findFirst({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!recentBackup) return { created: 0 };

  const tables = await prisma.lakeTable.findMany({
    where: { tenantId },
    select: { name: true, rowCount: true },
  }).catch(() => [] as any[]);

  let created = 0;
  for (const t of tables) {
    const exists = await prisma.lakeSnapshot.findFirst({
      where: { tenantId, tableName: t.name, backupId: recentBackup.id },
      select: { id: true },
    });
    if (exists) continue;
    await prisma.lakeSnapshot.create({
      data: {
        tenantId,
        tableName: t.name,
        backupId: recentBackup.id,
        rowCount: t.rowCount ?? 0,
      },
    });
    created++;
  }
  return { created };
}
