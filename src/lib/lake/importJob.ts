/**
 * Import a staged upload (lib/lake/uploadStaging.ts) into a Curf Tables
 * table, in the background, a batch at a time.
 *
 * The direct upload route holds every row in memory and writes them in one
 * transaction — right for a small file, impossible for a million rows on a
 * 1 Gi pod, and far longer than a request should stay open. Here rows
 * stream off disk (openUploadRows), and every BATCH_ROWS of them go through
 * the same writers everything else uses: createOrReplaceTable for the first
 * batch (the user's confirmed column types and date orders), appendRows for
 * the rest, pinned to those same columns. Both engines (SQLite, DuckDB) are
 * handled inside those writers.
 *
 * Progress goes to an AiJob row (kind "lake_import") that the dialog polls
 * through GET /api/ai-jobs/[id]: rows imported so far against the count the
 * file declared up front. The catalog row is written only after the last
 * batch, so a table is never visible half-imported. A failure drops the
 * partial physical table and keeps the staged file, so "Try again" doesn't
 * need the upload repeated.
 */
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import type { CurfSessionUser } from "@/lib/auth";
import { appendRows, createOrReplaceTable, dropTable, mergeStagedIntoTable, type LakeColumn } from "./tables";
import { openUploadRows } from "./parseFile";
import { repairRow, type TextRepair } from "./textRepair";
import { deleteStagedUpload, getStagedUpload } from "./uploadStaging";
import { formatBytes, getQuotaForTenant } from "./quota";
import { lakeFileSize, toSafeTableName } from "./storage";
import { registerCreatedTable } from "./tableRegistration";
import { STANDARD_DATASETS, standardColumns, type StandardDatasetId } from "./standardDatasets";
import { headerSignature, makeRowMapper, mappingProblems, type ColumnMapping } from "./columnMapping";
import { recordStandardImport, saveImportMapping } from "./standardImport";
import { refreshRetailMetrics } from "./retailMetrics";
import { keepRetailReportsCurrent } from "@/lib/templates/retail/setup";
import type { DateOrder } from "./valueClean";

export const LAKE_IMPORT_JOB_KIND = "lake_import";
/** A running import that hasn't written progress for this long has died (see GET /api/ai-jobs/[id]). */
export const LAKE_IMPORT_STALE_MS = 3 * 60 * 1000;

const BATCH_ROWS = 5_000;
const PROGRESS_EVERY_MS = 1_500;

// Two imports into the same physical table at once would interleave their
// rows. This app runs as one replica, so an in-process claim is enough; the
// catalog check can't catch it because neither import has a catalog row
// until it finishes.
const inFlight = new Set<string>();

/** Claim `name` for an import; false when one is already running into it. */
export function claimImportTarget(tenantId: string, name: string): boolean {
  const key = `${tenantId}:${toSafeTableName(name)}`;
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
}

export function releaseImportTarget(tenantId: string, name: string): void {
  inFlight.delete(`${tenantId}:${toSafeTableName(name)}`);
}

export async function runLakeImportJob(args: {
  jobId: string;
  user: CurfSessionUser;
  req?: NextRequest;
  uploadId: string;
  /** The table the rows end up in — a new table's name, or a standard dataset's table. */
  name: string;
  sheet?: string;
  columnTypeOverrides?: Record<string, LakeColumn["type"]>;
  columnDateOrders?: Record<string, "mdy" | "dmy">;
  textRepair: TextRepair | null;
  /**
   * Import into a standard dataset instead of a new table: each row is
   * mapped onto the dataset's columns, written to a staging table, and
   * merged into the dataset's table at the end (mergeStagedIntoTable),
   * replacing the period the file covers.
   */
  standard?: { dataset: StandardDatasetId; mapping: ColumnMapping; dateOrders?: Record<string, DateOrder> };
}): Promise<void> {
  const { user, name, jobId } = args;
  const tenantId = user.tenantId;
  const ds = args.standard ? STANDARD_DATASETS[args.standard.dataset] : null;
  // Standard imports write to a staging table first; nothing reaches the
  // real table until the merge at the end.
  const writeName = ds ? `import_${jobId}` : name;
  let created = false;
  const progress = (data: { stage: string; progressPct: number }) =>
    prisma.aiJob.update({ where: { id: jobId }, data }).catch(() => null);

  try {
    const { upload, dataPath } = await getStagedUpload(tenantId, user.id, args.uploadId);
    const source = await openUploadRows(dataPath, upload.filename, { sheet: args.sheet });
    const expected = await source.expectedRows();
    const quota = await getQuotaForTenant(tenantId);
    const sourceConfig = {
      filename: upload.filename,
      originalSize: upload.size,
      ...(source.sheet ? { sheet: source.sheet } : {}),
      ...(args.textRepair ? { textRepair: args.textRepair } : {}),
    };

    const mapRow = ds && args.standard
      ? makeRowMapper(ds, args.standard.mapping, { dateOrders: args.standard.dateOrders, sourceFile: upload.filename })
      : null;
    const standardTypes = ds
      ? Object.fromEntries(standardColumns(ds).map((c) => [c.name, c.type])) as Record<string, LakeColumn["type"]>
      : undefined;
    const skipped: Record<string, number> = {};
    let checkedHeaders = false;
    let headers: string[] = [];

    let columns: LakeColumn[] = [];
    let imported = 0;
    let batch: Array<Record<string, unknown>> = [];
    let lastProgress = Date.now();

    const flush = async () => {
      if (!created) {
        const result = await createOrReplaceTable({
          tenantId,
          tableName: writeName,
          rows: batch,
          sourceKind: "upload",
          sourceConfig,
          columnTypeOverrides: standardTypes ?? args.columnTypeOverrides,
          columnDateOrders: ds ? undefined : args.columnDateOrders,
        });
        columns = result.columns;
        created = true;
      } else {
        await appendRows({ tenantId, tableName: writeName, rows: batch, columns });
      }
      imported += batch.length;
      batch = [];

      // The upload was quota-checked by its file size, but a compressed
      // workbook can grow several times over once it is rows. Stop at the
      // cap rather than past it.
      const used = lakeFileSize(tenantId);
      if (quota.maxBytes != null && used > quota.maxBytes) {
        throw new Error(
          `Lake storage cap reached after ${imported.toLocaleString("en-US")} rows ` +
          `(${formatBytes(used)}/${formatBytes(quota.maxBytes)} on ${quota.tier}). Nothing was saved — free up space or upgrade, then try again.`,
        );
      }
      if (Date.now() - lastProgress >= PROGRESS_EVERY_MS) {
        lastProgress = Date.now();
        await progress({
          stage: expected
            ? `Imported ${imported.toLocaleString("en-US")} of about ${expected.toLocaleString("en-US")} rows`
            : `Imported ${imported.toLocaleString("en-US")} rows`,
          // Measured, not a timer: rows written over rows the file declared.
          // Capped below 100 until the catalog row exists.
          progressPct: expected ? Math.min(95, Math.max(1, Math.floor((imported / expected) * 95))) : 50,
        });
      }
    };

    for await (const raw of source.rows) {
      const row = args.textRepair ? repairRow(raw, args.textRepair) : raw;
      if (mapRow && ds && args.standard) {
        // The mapping was checked against the preview; check it once more
        // against the file's real headers before a single row is written.
        if (!checkedHeaders) {
          headers = Object.keys(row);
          const problems = mappingProblems(ds, args.standard.mapping, headers);
          if (problems.length > 0) throw new Error(problems.join(" "));
          checkedHeaders = true;
        }
        const mapped = mapRow(row);
        if ("skipped" in mapped) { skipped[mapped.skipped] = (skipped[mapped.skipped] ?? 0) + 1; continue; }
        batch.push(mapped.row);
      } else {
        batch.push(row);
      }
      if (batch.length >= BATCH_ROWS) await flush();
    }

    if (ds) {
      const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
      if (batch.length === 0 && !created) {
        throw new Error(skippedTotal > 0
          ? `None of the ${skippedTotal.toLocaleString("en-US")} rows could be imported — each was missing ${Object.keys(skipped).join(" / ")}. Check the column mapping.`
          : "The file has no rows to import.");
      }
      if (batch.length > 0) await flush();

      await progress({ stage: "Replacing the period this file covers…", progressPct: 96 });
      const merged = await mergeStagedIntoTable({
        tenantId,
        stagingName: writeName,
        targetName: ds.tableName,
        columns: standardColumns(ds).map((c) => ({ name: c.name, type: c.type })),
        replace: ds.replace,
        sourceConfig,
      });
      created = false; // The staging table is gone — dropped inside the merge.
      const table = await recordStandardImport({
        user, req: args.req, ds, total: merged.total,
        sourceConfig: { ...sourceConfig, mapping: args.standard!.mapping },
        audit: { file: upload.filename, inserted: merged.inserted, replaced: merged.replaced, skipped: skippedTotal },
      });
      // Next month's export from the same POS maps itself.
      await saveImportMapping({
        user, ds, signature: headerSignature(headers), mapping: args.standard!.mapping,
        dateOrders: args.standard!.dateOrders, filename: upload.filename,
      });
      // Stock status, daily sales and the forecast follow the new rows. The
      // import itself already succeeded — a failure here is reported with
      // it, not turned into a failed import.
      await progress({ stage: "Updating stock and sales figures…", progressPct: 98 });
      let metrics: { tables: Array<{ name: string; rowCount: number }> } | { error: string };
      try {
        metrics = await refreshRetailMetrics(user, args.req);
        // A branch seen for the first time joins the retail reports' branch picker;
        // reports made by an earlier pack get what it adds now.
        await keepRetailReportsCurrent(user);
      } catch (e: any) {
        metrics = { error: String(e?.message ?? e).slice(0, 300) };
        console.warn(`[lake.import] ${jobId} retail figures not updated: ${metrics.error}`);
      }
      await prisma.aiJob.update({
        where: { id: jobId },
        data: {
          status: "done",
          stage: `Imported ${merged.inserted.toLocaleString("en-US")} rows`,
          progressPct: 100,
          resultJson: JSON.stringify({
            table: { id: table.id, name: table.name, rowCount: merged.total, sizeBytes: table.sizeBytes },
            // A chain's stock file can span hundreds of branches; the job
            // row keeps the first few periods and the count, not all of them.
            standard: {
              dataset: ds.id, inserted: merged.inserted, replaced: merged.replaced, skipped,
              branches: merged.periods.length, periods: merged.periods.slice(0, 20), metrics,
            },
          }),
        },
      });
      await deleteStagedUpload(tenantId, args.uploadId).catch(() => null);
      return;
    }

    // An empty file still becomes a table (a placeholder column, like the
    // direct upload), so the flush runs at least once.
    if (batch.length > 0 || !created) await flush();

    await progress({ stage: "Saving the table…", progressPct: 97 });
    const table = await registerCreatedTable({
      user,
      req: args.req,
      name,
      sourceKind: "upload",
      sourceConfig,
      columns,
      rowCount: imported,
    });

    await prisma.aiJob.update({
      where: { id: jobId },
      data: {
        status: "done",
        stage: `Imported ${imported.toLocaleString("en-US")} rows`,
        progressPct: 100,
        resultJson: JSON.stringify({
          table: { id: table.id, name: table.name, rowCount: table.rowCount, sizeBytes: table.sizeBytes, schema: columns },
        }),
      },
    });
    await deleteStagedUpload(tenantId, args.uploadId).catch(() => null);
  } catch (e: any) {
    const message = String(e?.message ?? e).slice(0, 500);
    console.warn(`[lake.import] ${jobId} failed: ${message}`);
    // A new table is dropped whole; a standard import only ever wrote its
    // staging table, so the real table is exactly as it was.
    if (created) await dropTable(tenantId, writeName).catch(() => null);
    await prisma.aiJob.update({
      where: { id: jobId },
      data: { status: "failed", stage: "Import failed", errorJson: JSON.stringify({ error: message }) },
    }).catch(() => null);
  } finally {
    releaseImportTarget(tenantId, name);
  }
}
