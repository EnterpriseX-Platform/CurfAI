/**
 * The parts of importing into a standard dataset (standardDatasets.ts)
 * that sit around the row writing done by importJob.ts: whether this
 * workspace can take the import at all, and recording the table in the
 * catalog once the staged rows have been merged in.
 */
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { tenantWhere, type CurfSessionUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { ee } from "@/ee";
import { lakeFileSize, toSafeTableName } from "./storage";
import { bustLakeCacheForTenant } from "./bust";
import { registerCreatedTable } from "./tableRegistration";
import { standardColumns, type StandardDataset } from "./standardDatasets";
import { getTable, type LakeColumn } from "./tables";
import { mergeGovernanceMetadata, parseSchemaJson } from "./schemaGovernance";
import type { ColumnMapping } from "./columnMapping";
import type { DateOrder } from "./valueClean";

type CatalogRow = { id: string; name: string; sourceConfigJson: string | null };

function standardIdOf(row: CatalogRow): string | null {
  try { return JSON.parse(row.sourceConfigJson ?? "{}")?.standardDataset ?? null; } catch { return null; }
}

/**
 * Why this workspace can't import into `ds` right now, or null when it can:
 * a DuckDB-engine workspace (the merge is SQLite-only for now), or a table
 * of the workspace's own already holding the standard table's name (or a
 * name that shares its storage name) — importing would write into it.
 */
export async function standardImportProblem(
  user: CurfSessionUser,
  ds: StandardDataset,
): Promise<{ status: 400 | 409; error: string } | null> {
  if (await ee.lake?.onPaidEngine(user.tenantId)) {
    return { status: 400, error: "Standard sales and stock tables aren't available on the DuckDB lake engine yet." };
  }
  const safe = toSafeTableName(ds.tableName);
  const rows = await prisma.lakeTable.findMany({
    where: tenantWhere(user),
    select: { id: true, name: true, sourceConfigJson: true },
  }) as CatalogRow[];
  const clash = rows.find((r) => toSafeTableName(r.name) === safe && standardIdOf(r) !== ds.id);
  if (clash) {
    return {
      status: 409,
      error: `This workspace already has its own table "${clash.name}". Rename it before importing into the standard ${ds.tableName} table.`,
    };
  }
  return null;
}

/** The mapping last confirmed for this file layout (headerSignature) in this dataset, if any. */
export async function loadSavedMapping(
  user: CurfSessionUser,
  ds: StandardDataset,
  signature: string,
): Promise<{ mapping: ColumnMapping; dateOrders: Record<string, DateOrder>; lastFilename: string | null } | null> {
  const row = await prisma.lakeImportMapping.findFirst({ where: { ...tenantWhere(user), dataset: ds.id, signature } });
  if (!row) return null;
  try {
    return {
      mapping: JSON.parse(row.mappingJson) as ColumnMapping,
      dateOrders: row.dateOrdersJson ? JSON.parse(row.dateOrdersJson) : {},
      lastFilename: row.lastFilename,
    };
  } catch {
    return null;
  }
}

/**
 * Remember a mapping that just imported cleanly, keyed by the file's layout,
 * so next month's export from the same POS maps itself. Best-effort: the
 * import already succeeded, and failing to remember must not undo that.
 */
export async function saveImportMapping(opts: {
  user: CurfSessionUser;
  ds: StandardDataset;
  signature: string;
  mapping: ColumnMapping;
  dateOrders?: Record<string, DateOrder>;
  filename: string;
}): Promise<void> {
  const { user } = opts;
  const data = {
    mappingJson: JSON.stringify(opts.mapping),
    dateOrdersJson: opts.dateOrders ? JSON.stringify(opts.dateOrders) : null,
    lastFilename: opts.filename,
  };
  await prisma.lakeImportMapping.upsert({
    where: { tenantId_dataset_signature: { tenantId: user.tenantId, dataset: opts.ds.id, signature: opts.signature } },
    update: data,
    create: { ...data, tenantId: user.tenantId, dataset: opts.ds.id, signature: opts.signature, createdById: user.viaApiKey ? null : user.id },
  }).catch((e: any) => console.warn("[lake.import] couldn't save the column mapping:", e?.message ?? e));
}

/** Whether the standard table exists yet — the first import creates it (and counts as a new table for the quota). */
export async function standardTableExists(user: CurfSessionUser, ds: StandardDataset): Promise<boolean> {
  const row = await prisma.lakeTable.findFirst({ where: { ...tenantWhere(user), name: ds.tableName }, select: { id: true } });
  return !!row;
}

/**
 * Record the standard table after a merge: its catalog row the first time
 * (registerCreatedTable — data source, search indexing, audit, cache), and
 * afterwards the new row count, size and schema, with an audit event per
 * import so it's clear which file changed the numbers.
 */
export async function recordStandardImport(opts: {
  user: CurfSessionUser;
  req?: NextRequest;
  ds: StandardDataset;
  total: number;
  sourceConfig: Record<string, unknown>;
  audit: Record<string, unknown>;
}) {
  const { user, ds } = opts;
  const columns: LakeColumn[] = standardColumns(ds).map((c) => ({ name: c.name, type: c.type }));
  const existing = await prisma.lakeTable.findFirst({ where: { ...tenantWhere(user), name: ds.tableName } });
  if (!existing) {
    return registerCreatedTable({
      user,
      req: opts.req,
      name: ds.tableName,
      sourceKind: "upload",
      sourceConfig: { ...opts.sourceConfig, standardDataset: ds.id },
      columns,
      rowCount: opts.total,
    });
  }
  // A re-import keeps what can't be read back from the data: each column's
  // sensitivity tags (writing the dataset's bare columns un-masked a tagged
  // column for every viewer), and the formula columns the replace kept.
  const formulaColumns = ((await getTable(user.tenantId, ds.tableName))?.columns ?? []).filter((c) => c.formula);
  const updated = await prisma.lakeTable.update({
    where: { id: existing.id },
    data: {
      rowCount: opts.total,
      sizeBytes: lakeFileSize(user.tenantId),
      schemaJson: JSON.stringify(mergeGovernanceMetadata(parseSchemaJson(existing.schemaJson), [...columns, ...formulaColumns])),
      sourceConfigJson: JSON.stringify({ ...opts.sourceConfig, standardDataset: ds.id }),
    },
  });
  recordAudit({ user, kind: "lake.table.append", target: updated.id, req: opts.req, meta: { name: ds.tableName, ...opts.audit } });
  setImmediate(() => { void bustLakeCacheForTenant(user.tenantId); });
  return updated;
}
