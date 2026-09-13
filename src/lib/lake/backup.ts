/**
 * Lake backups — snapshot, restore, retention sweep.
 *
 * Snapshots are gzipped copies of the per-tenant lake SQLite file. We
 * use SQLite's native `VACUUM INTO` to produce a clean, defragmented
 * file even while the live DB has open WAL transactions — that's safer
 * than a raw fs.copyFileSync of the .db (which could capture a partial
 * write) and produces a smaller file (no free pages).
 *
 * Layout:
 *   lake/backups/<tenantId>/<backupId>.db.gz
 *
 * Why gzipped: SQLite files are highly compressible (sparse pages, lots
 * of repeated bytes). 50-70% size reduction on typical lake content,
 * which both saves disk and speeds restore-by-network later when we
 * push backups to S3 in Phase 3.
 *
 * Restore strategy: write to a temp .db.restore.<id> file, validate
 * (open + simple SELECT against __lake_meta), then atomically rename
 * over the live file. The cached connection in storage.ts gets closed
 * first so the file handle releases. Live readers get a fresh open on
 * their next request.
 */
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import zlib from "node:zlib";
import { prisma } from "@/lib/db";
import { tenantLakePath, closeLake, openLake, lakeFileSize, toSafeTableName } from "./storage";
import { createOrReplaceTable, type LakeTableMeta } from "./tables";
import { bustLakeCacheForTenant } from "./bust";
import { ee } from "@/ee";

const BACKUP_ROOT = process.env.CURF_LAKE_BACKUP_DIR
  ? process.env.CURF_LAKE_BACKUP_DIR
  : path.join(process.cwd(), "lake", "backups");

function tenantBackupDir(tenantId: string): string {
  const safe = tenantId.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(BACKUP_ROOT, safe);
}

function backupFilePath(tenantId: string, backupId: string): string {
  return path.join(tenantBackupDir(tenantId), backupId + ".db.gz");
}

/**
 * Per-tier retention windows in days. Manual snapshots get a 365-day
 * floor regardless of tier — they're typically grabbed before a risky
 * change ("snapshot before I drop this column"), and aging one of those
 * out automatically would lose the safety net.
 */
const RETENTION_DAYS: Record<string, number> = {
  community: 30,
  growth: 90,
  business: 365,
};

export type SnapshotResult = {
  backupId: string;
  sizeBytes: number;
  tableCount: number;
  skipped?: "too-recent" | "no-lake-file";
};

/**
 * Take a snapshot of the tenant's lake. Auto-snapshots skip if the most
 * recent backup is < 23h old (we want roughly daily, not whatever the
 * cron drift produces). Manual snapshots always go through.
 */
export async function snapshotTenant(opts: {
  tenantId: string;
  kind: "auto" | "manual";
  createdById?: string | null;
  restoredFromId?: string | null;
}): Promise<SnapshotResult> {
  // No lake file yet → nothing to back up. Catalog returns "skipped"
  // so the cron tick can short-circuit cleanly without throwing.
  const livePath = tenantLakePath(opts.tenantId);
  if (!fs.existsSync(livePath)) {
    return { backupId: "", sizeBytes: 0, tableCount: 0, skipped: "no-lake-file" };
  }

  if (opts.kind === "auto") {
    const recent = await prisma.lakeBackup.findFirst({
      where: { tenantId: opts.tenantId, kind: "auto" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (recent) {
      const ageMs = Date.now() - new Date(recent.createdAt).getTime();
      if (ageMs < 23 * 60 * 60 * 1000) {
        return { backupId: "", sizeBytes: 0, tableCount: 0, skipped: "too-recent" };
      }
    }
  }

  // Mint the row first so the file path is stable. Roll back if the
  // physical write fails.
  const row = await prisma.lakeBackup.create({
    data: {
      tenantId: opts.tenantId,
      sizeBytes: 0,
      tableCountAtSnapshot: 0,
      kind: opts.kind,
      restoredFromId: opts.restoredFromId ?? null,
      createdById: opts.createdById ?? null,
    },
  });

  try {
    fs.mkdirSync(tenantBackupDir(opts.tenantId), { recursive: true });
    // VACUUM INTO produces a clean copy that's safe to read even with
    // active WAL transactions on the source. We then gzip + delete the
    // intermediate .db so we end up with one .db.gz on disk.
    const tmpDbPath = backupFilePath(opts.tenantId, row.id) + ".tmp.db";
    const finalPath = backupFilePath(opts.tenantId, row.id);
    const live = openLake(opts.tenantId);
    live.exec(`VACUUM INTO '${tmpDbPath.replace(/'/g, "''")}'`);
    // Count tables for the UI. __lake_meta lives in the tenant DB; if a
    // brand-new tenant snapshotted before any tables, the row count is 0.
    let tableCount = 0;
    try {
      const cnt = live.prepare("SELECT COUNT(*) as n FROM __lake_meta").get() as { n: number };
      tableCount = cnt.n;
    } catch { /* __lake_meta might not exist in pre-bootstrap DBs */ }

    // Gzip the temp DB → final .db.gz. Stream-based so a 1GB DB doesn't
    // blow up RAM. Strong compression (level 9) — the cost is one-time;
    // restores stream the gunzip back the other way.
    await new Promise<void>((resolve, reject) => {
      const inp = fs.createReadStream(tmpDbPath);
      const gzip = zlib.createGzip({ level: 9 });
      const out = fs.createWriteStream(finalPath);
      inp.pipe(gzip).pipe(out);
      out.on("finish", () => resolve());
      out.on("error", reject);
      inp.on("error", reject);
    });
    fs.unlinkSync(tmpDbPath);

    const sizeBytes = fs.statSync(finalPath).size;
    await prisma.lakeBackup.update({
      where: { id: row.id },
      data: { sizeBytes, tableCountAtSnapshot: tableCount },
    });

    // Off-site shipping. Fire-and-forget so a slow / flapping destination
    // can't delay the snapshot itself; the local file is always the
    // source of truth. Each shipment becomes a BackupShipment row that
    // the admin UI surfaces.
    // Off-site destinations are a Business feature (src/ee); Community keeps
    // the local snapshot only.
    setImmediate(() => {
      ee.lake?.shipSnapshotToDestinations({
        tenantId: opts.tenantId,
        backupId: row.id,
        kind: opts.kind,
      }).catch(() => { /* logged via BackupShipment row */ });
    });

    return { backupId: row.id, sizeBytes, tableCount };
  } catch (e) {
    // Roll back catalog row so the user doesn't see a "phantom" backup.
    await prisma.lakeBackup.delete({ where: { id: row.id } }).catch(() => null);
    throw e;
  }
}

/**
 * Restore a backup atomically. Closes the live connection, swaps the
 * file, and triggers a fresh open on the next read.
 *
 * Side-effect: writes a new "manual" snapshot named with restoredFromId
 * BEFORE the swap, so the user can roll back the restore itself if it
 * was the wrong one. Belt-and-suspenders for a destructive op.
 */
export async function restoreBackup(opts: {
  tenantId: string;
  backupId: string;
  createdById?: string | null;
}): Promise<{ ok: true; preRestoreBackupId: string }> {
  const row = await prisma.lakeBackup.findFirst({
    where: { id: opts.backupId, tenantId: opts.tenantId },
  });
  if (!row) throw new Error("Backup not found");
  const filePath = backupFilePath(opts.tenantId, row.id);
  if (!fs.existsSync(filePath)) throw new Error("Backup file missing on disk");

  // Pre-restore safety snapshot. Tagged so the audit tab makes sense.
  const safety = await snapshotTenant({
    tenantId: opts.tenantId,
    kind: "manual",
    createdById: opts.createdById,
    restoredFromId: opts.backupId,
  });

  // Stage the restore: gunzip into a .db.restore file, validate, then
  // atomic rename over the live lake.
  const livePath = tenantLakePath(opts.tenantId);
  const stagePath = livePath + ".restore.tmp";
  await new Promise<void>((resolve, reject) => {
    const inp = fs.createReadStream(filePath);
    const gunz = zlib.createGunzip();
    const out = fs.createWriteStream(stagePath);
    inp.pipe(gunz).pipe(out);
    out.on("finish", () => resolve());
    out.on("error", reject);
    inp.on("error", reject);
  });

  // Validate by opening + checking integrity. Throws if corrupt.
  const probe = new Database(stagePath, { readonly: true });
  try {
    const r = probe.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (r.integrity_check !== "ok") throw new Error(`Integrity check failed: ${r.integrity_check}`);
  } finally {
    probe.close();
  }

  // Drop the live cached connection so the rename succeeds on Windows
  // (otherwise EBUSY). Then atomic rename — fs.renameSync is atomic on
  // the same filesystem on POSIX + Windows.
  closeLake(opts.tenantId);
  // On Windows you can't rename onto an existing file in some configs;
  // unlink first if needed.
  try { fs.unlinkSync(livePath); } catch { /* not present, fine */ }
  fs.renameSync(stagePath, livePath);

  return { ok: true, preRestoreBackupId: safety.backupId };
}

/**
 * Restore a single table out of a whole-tenant snapshot, leaving every
 * other live table untouched — unlike restoreBackup()'s whole-file swap.
 * Used by Master Builder artifact restore (POST
 * /api/master-builder/artifacts/[artifactId]/restore) to bring back a
 * table a Rebuild or Delete-build teardown dropped.
 *
 * Follows timeTravel.ts's readTableAsOf() gunzip-and-query pattern —
 * unpaginated here, since this is a full restore, not a browse — but
 * unlike that read-only helper, this writes: it takes its own fresh
 * safety snapshot first (mirroring restoreBackup()'s own belt-and-
 * suspenders precedent), then createOrReplaceTable()s just the one table.
 */
export async function restoreTableFromBackup(opts: {
  tenantId: string;
  backupId: string;
  tableName: string;
  createdById?: string | null;
}): Promise<{ ok: true; tableId: string; rowCount: number; preRestoreBackupId: string }> {
  const backupRow = await prisma.lakeBackup.findFirst({
    where: { id: opts.backupId, tenantId: opts.tenantId },
  });
  if (!backupRow) throw new Error("Backup not found");
  const filePath = backupFilePath(opts.tenantId, backupRow.id);
  if (!fs.existsSync(filePath)) throw new Error("Backup file missing on disk");

  // Pre-restore safety snapshot — belt-and-suspenders even for a
  // single-table restore, same reasoning as restoreBackup().
  const safety = await snapshotTenant({
    tenantId: opts.tenantId, kind: "manual",
    createdById: opts.createdById, restoredFromId: opts.backupId,
  });

  // Gunzip to a private temp file (not the shared timeTravel.ts cache —
  // this one gets deleted right after, since a restore is a one-shot
  // write, not a snapshot browsers will re-query).
  const stagePath = path.join(os.tmpdir(), `curf-restore-${opts.backupId}-${Date.now()}.db`);
  await new Promise<void>((resolve, reject) => {
    const inp = fs.createReadStream(filePath);
    const gunz = zlib.createGunzip();
    const out = fs.createWriteStream(stagePath);
    inp.pipe(gunz).pipe(out);
    out.on("finish", () => resolve());
    out.on("error", reject);
    inp.on("error", reject);
  });

  const safeName = toSafeTableName(opts.tableName);
  let rows: any[];
  let sourceKind: LakeTableMeta["sourceKind"] = "manual";
  let sourceConfig: Record<string, unknown> = {};
  try {
    const snap = new Database(stagePath, { readonly: true });
    try {
      const exists = snap.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(safeName);
      if (!exists) throw new Error(`Table "${opts.tableName}" was not present in this snapshot`);
      rows = snap.prepare(`SELECT * FROM "${safeName}"`).all() as any[];
      try {
        const meta = snap.prepare(
          `SELECT source_kind, source_config_json FROM __lake_meta WHERE table_name = ?`,
        ).get(safeName) as { source_kind: string; source_config_json: string | null } | undefined;
        if (meta) {
          sourceKind = (meta.source_kind as LakeTableMeta["sourceKind"]) ?? "manual";
          if (meta.source_config_json) { try { sourceConfig = JSON.parse(meta.source_config_json); } catch { /* ignore */ } }
        }
      } catch { /* __lake_meta absent in a pre-bootstrap snapshot — defaults above are fine */ }
    } finally {
      snap.close();
    }
  } finally {
    fs.unlink(stagePath, () => { /* best-effort cleanup */ });
  }

  const result = createOrReplaceTable({
    tenantId: opts.tenantId, tableName: opts.tableName, rows,
    sourceKind, sourceConfig,
  });

  const sizeBytes = lakeFileSize(opts.tenantId);
  const existing = await prisma.lakeTable.findFirst({
    where: { tenantId: opts.tenantId, name: opts.tableName },
  });
  let tableId: string;
  if (existing) {
    await prisma.lakeTable.update({
      where: { id: existing.id },
      data: { schemaJson: JSON.stringify(result.columns), rowCount: result.rowCount, sizeBytes },
    });
    tableId = existing.id;
  } else {
    const created = await prisma.lakeTable.create({
      data: {
        tenantId: opts.tenantId, name: opts.tableName, sourceKind,
        sourceConfigJson: JSON.stringify(sourceConfig),
        schemaJson: JSON.stringify(result.columns),
        rowCount: result.rowCount, sizeBytes,
        createdById: opts.createdById ?? null,
      },
    });
    tableId = created.id;
  }

  await bustLakeCacheForTenant(opts.tenantId, opts.tableName);

  return { ok: true, tableId, rowCount: result.rowCount, preRestoreBackupId: safety.backupId };
}

/**
 * Delete snapshots older than the tier's retention window. Manual
 * snapshots get a 365-day floor regardless of tier.
 */
export async function sweepOldBackups(tenantId: string): Promise<{ deleted: number }> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { tier: true } });
  const tier = (tenant?.tier ?? "community") as keyof typeof RETENTION_DAYS;
  const days = RETENTION_DAYS[tier] ?? RETENTION_DAYS.community;
  const cutoff = new Date(Date.now() - days * 86400_000);
  const manualCutoff = new Date(Date.now() - 365 * 86400_000);

  const candidates = await prisma.lakeBackup.findMany({
    where: {
      tenantId,
      OR: [
        { kind: "auto", createdAt: { lt: cutoff } },
        { kind: "manual", createdAt: { lt: manualCutoff } },
      ],
    },
  });
  let deleted = 0;
  for (const b of candidates) {
    const f = backupFilePath(tenantId, b.id);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* best effort */ }
    await prisma.lakeBackup.delete({ where: { id: b.id } }).catch(() => null);
    deleted++;
  }
  return { deleted };
}

/** Helper for the admin UI — backup file path resolver. */
export function backupPath(tenantId: string, backupId: string): string {
  return backupFilePath(tenantId, backupId);
}
