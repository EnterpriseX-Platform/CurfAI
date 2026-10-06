/**
 * Convert an existing table's TEXT columns to typed storage and keep
 * everything around it in step — one place, for the admin's per-table
 * conversion (/api/lake/tables/[name]/typed-conversion) and the bulk pass
 * (scripts/lake/convert-typed.ts) alike:
 *
 *   - the rebuild itself (applyTypedConversion: aborts, changing nothing,
 *     unless it loses exactly the cells the caller confirmed);
 *   - cached query results that read the table (computed on the old types);
 *   - the catalog's schema — types from the resolved DDL, governance
 *     metadata (redaction tags above all) carried over;
 *   - the schema embeddings (a column's type is part of what's embedded);
 *   - the audit trail.
 */
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import type { CurfSessionUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { applyTypedConversion, previewRows, type TypedConversionResult } from "./tables";
import { buildSchemaAfterConversion } from "./schemaGovernance";
import { bustLakeCacheForTenant } from "./bust";
import { ee } from "@/ee";

export async function convertTableColumns(opts: {
  tenantId: string;
  row: { id: string; name: string; schemaJson: string | null };
  columns: string[];
  /** Lossy cells per column the person (or the bulk pass's rule: none) accepted. */
  confirmedLossy: Record<string, number>;
  /** Who asked: an admin in a request, or null for the bulk pass run by an operator. */
  user: CurfSessionUser | null;
  req?: NextRequest;
  /** Recorded on the audit event: this came from the bulk pass. */
  bulk?: boolean;
}): Promise<{ result: TypedConversionResult; schema: unknown[] }> {
  const { tenantId, row } = opts;
  const result = await applyTypedConversion({ tenantId, tableName: row.name, columns: opts.columns, expectedLossy: opts.confirmedLossy });

  // The data on disk has changed for good: cached results computed on the old types are stale.
  setImmediate(() => { void bustLakeCacheForTenant(tenantId, row.name); });

  // Types from the resolved DDL (never re-inferred from a sample — a SQLite
  // boolean is a 0/1 INTEGER a sample would call a number), governance
  // metadata carried over from the catalog as it is now.
  const sampleRows = await previewRows(tenantId, row.name, 100).catch(() => []);
  const schema = buildSchemaAfterConversion(row.schemaJson, result.columns, sampleRows);
  await prisma.lakeTable.update({
    where: { tenantId_name: { tenantId, name: row.name } },
    data: { schemaJson: JSON.stringify(schema), updatedAt: new Date() },
  });

  // Column types are part of what's embedded; the drain's textHash check skips anything unchanged.
  if (result.convertedColumns.length > 0) {
    setImmediate(() => {
      void ee.vectorStore?.enqueueSchemaColEmbedBatch({ tenantId, tableId: row.id, columnNames: result.convertedColumns });
    });
  }

  recordAudit({
    user: opts.user, tenantId, kind: "lake.table.typed_conversion", target: row.id, req: opts.req,
    meta: {
      name: row.name,
      requested: opts.columns,
      converted: result.convertedColumns,
      skipped: result.skippedColumns,
      lossyByColumn: result.lossyByColumn,
      ...(opts.bulk ? { bulk: true } : {}),
    },
  });

  return { result, schema };
}
