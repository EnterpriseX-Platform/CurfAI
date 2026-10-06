/**
 * Reconcile the LakeTable catalog against what's physically on disk.
 *
 * A whole-file swap (restoreBackup()'s restore, mergeBranch()'s merge) can
 * silently diverge the catalog from the file it's supposed to describe:
 *
 *   - A table existed when the swapped-in file was captured, but was
 *     deleted from the live tenant since — the swap brings the physical
 *     table back, but the LakeTable row stays deleted, so the table is
 *     orphaned: present in the engine, invisible everywhere the app reads
 *     from the catalog (the /tables UI, GET /api/lake/tables/[name],
 *     "Used in" report links, ACL checks).
 *   - A table was created after the file being swapped in was captured —
 *     its LakeTable row survives the swap, but the physical table the
 *     swapped-in file describes doesn't have it, so queries/reports
 *     against it now fail or silently return nothing while the catalog
 *     still claims it exists.
 *
 * Call this right after the physical swap lands (and after the engine's
 * live connection has been reopened against the new file), before
 * returning control to the caller.
 */
import { prisma } from "@/lib/db";
import { ee } from "@/ee";
import type { LakeFileReader, LakeReadConnection } from "@/lib/ee/types";
import { openLake, toSafeTableName } from "./storage";
import { qIdent, inferColumns } from "./tables";
import { bustLakeCacheForTenant } from "./bust";

export type ReconcileResult = {
  /** Physical tables that got a freshly-inferred LakeTable row. */
  restoredTables: string[];
  /** LakeTable rows removed because their physical table is gone. */
  droppedTables: string[];
};

const SAMPLE_SIZE = 500;

async function readOrphanMeta(
  conn: LakeReadConnection,
  physicalName: string,
): Promise<{ sourceKind: string; sourceConfig: Record<string, unknown> }> {
  try {
    const rows = await conn.all<{ source_kind: string; source_config_json: string | null }>(
      `SELECT source_kind, source_config_json FROM __lake_meta WHERE table_name = ?`,
      [physicalName],
    );
    const meta = rows[0];
    if (!meta) return { sourceKind: "manual", sourceConfig: {} };
    let sourceConfig: Record<string, unknown> = {};
    if (meta.source_config_json) {
      try { sourceConfig = JSON.parse(meta.source_config_json); } catch { /* ignore malformed blob */ }
    }
    return { sourceKind: meta.source_kind ?? "manual", sourceConfig };
  } catch {
    // __lake_meta absent (pre-bootstrap file) — defaults are fine.
    return { sourceKind: "manual", sourceConfig: {} };
  }
}

/**
 * The tenant's live lake file: a paid engine's (DuckDB) through ee.lake, or
 * the default per-tenant SQLite file. The SQLite connection is openLake()'s
 * cached handle, so closing it is left to the cache.
 */
async function liveLakeReader(tenantId: string): Promise<LakeFileReader> {
  const paid = await ee.lake?.liveLakeReaderIfPaidEngine(tenantId);
  if (paid) return paid;
  const conn: LakeReadConnection = {
    all: async <T,>(sql: string, params: unknown[] = []) => openLake(tenantId).prepare(sql).all(...params) as T[],
    close: async () => {},
  };
  return {
    listTables: async () => (openLake(tenantId).prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__lake_%'",
    ).all() as Array<{ name: string }>).map((r) => r.name),
    open: async () => conn,
  };
}

export async function reconcileLakeCatalog(tenantId: string): Promise<ReconcileResult> {
  const lake = await liveLakeReader(tenantId);

  const [physicalTables, catalogRows, mvRows] = await Promise.all([
    lake.listTables().catch(() => [] as string[]),
    prisma.lakeTable.findMany({ where: { tenantId } }),
    prisma.materializedView.findMany({ where: { tenantId }, select: { name: true } }),
  ]);

  // Materialized-view output tables live under their own catalog
  // (MaterializedView, not LakeTable) — never treat them as orphaned
  // LakeTable rows just because there's no LakeTable entry for them.
  const mvPhysicalNames = new Set(mvRows.map((mv) => "mv_" + toSafeTableName(mv.name)));
  const catalogBySafeName = new Map(catalogRows.map((row) => [toSafeTableName(row.name), row]));
  const physicalSet = new Set(physicalTables);

  const restoredTables: string[] = [];
  const droppedTables: string[] = [];

  const orphans = physicalTables.filter(
    (name) => !mvPhysicalNames.has(name) && !catalogBySafeName.has(name),
  );
  if (orphans.length > 0) {
    const conn = await lake.open();
    try {
      for (const physicalName of orphans) {
        const [sample, countRows, meta] = await Promise.all([
          conn.all<Record<string, unknown>>(`SELECT * FROM ${qIdent(physicalName)} LIMIT ${SAMPLE_SIZE}`),
          conn.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${qIdent(physicalName)}`),
          readOrphanMeta(conn, physicalName),
        ]);
        const rowCount = Number(countRows?.[0]?.n ?? 0);
        const columns = inferColumns(sample);
        await prisma.lakeTable.create({
          data: {
            tenantId,
            name: physicalName,
            sourceKind: meta.sourceKind,
            sourceConfigJson: JSON.stringify(meta.sourceConfig),
            schemaJson: JSON.stringify(columns),
            rowCount,
            sizeBytes: 0,
          },
        });
        restoredTables.push(physicalName);
      }
    } finally {
      await conn.close();
    }
  }

  for (const row of catalogRows) {
    if (!physicalSet.has(toSafeTableName(row.name))) {
      await prisma.lakeTable.delete({ where: { id: row.id } }).catch(() => null);
      droppedTables.push(row.name);
    }
  }

  if (restoredTables.length > 0 || droppedTables.length > 0) {
    await bustLakeCacheForTenant(tenantId);
  }

  return { restoredTables, droppedTables };
}
