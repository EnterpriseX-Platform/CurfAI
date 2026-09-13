/**
 * Scheduled lake pull → Curf Tables. Two source kinds today:
 *
 *   - "rest" — reuses the existing REST runner (lib/reporting/runner.ts
 *              runOnRest) to fetch + flatten the response.
 *   - "sftp" — downloads pull.dataSource's configured remotePath over SFTP
 *              (lib/connections/sftp.ts) and parses it with the same
 *              CSV/XLSX/JSON logic the manual upload path uses
 *              (lib/lake/parseFile.ts).
 *
 * Both land rows into the named lake table using the strategy picked at
 * create-time ("replace" = drop+recreate, "append" = add to what's there),
 * via the shared finishPullSuccess() tail below.
 *
 * Failures are logged + persisted on the LakePull row (lastStatus +
 * lastError) so the admin UI can surface broken pulls without poking
 * through dev logs.
 */
import type { DataSourceDef } from "@/lib/reporting/schema";
import { prisma } from "@/lib/db";
import { runReport } from "@/lib/reporting/runner";
import { ReportSchema } from "@/lib/reporting/schema";
import { createOrReplaceTable, appendRows } from "@/lib/lake/tables";
import { bustLakeCacheForTenant } from "@/lib/lake/bust";
import { lakeFileSize } from "@/lib/lake/storage";
import { ee } from "@/ee";
import { parseUpload } from "@/lib/lake/parseFile";

export type RestPullRequest = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: string;
  jsonPath?: string;
  headers?: Record<string, string>;
};

/**
 * Run a single LakePull. Returns the row count appended (or replaced),
 * and updates the LakePull row with status. Throws on unrecoverable
 * errors so the cron handler can log them; recoverable errors (REST
 * 4xx / SFTP connect failure / parse failures) are caught + persisted as
 * lastStatus="failed".
 */
export async function runLakePull(pullId: string): Promise<{ rowsWritten: number; status: "ok" | "failed" | "skipped" }> {
  const pull = await prisma.lakePull.findUnique({ where: { id: pullId } });
  if (!pull) throw new Error(`LakePull ${pullId} not found`);

  const dsRow = await prisma.dataSource.findFirst({
    where: { id: pull.dataSourceId, tenantId: pull.tenantId },
  });
  if (!dsRow) {
    await markFailed(pullId, "Source connection not found");
    return { rowsWritten: 0, status: "failed" };
  }

  if (dsRow.kind === "sftp") {
    let rows: any[];
    try {
      // SFTP is a paid connector (Growth); its fetch lives in src/ee/connectors.
      if (!ee.connectors?.sftp) throw new Error("SFTP pulls are not available in this edition");
      rows = await ee.connectors.sftp.fetchRows(dsRow.connection);
    } catch (e: any) {
      await markFailed(pullId, `SFTP pull failed: ${e?.message ?? e}`);
      return { rowsWritten: 0, status: "failed" };
    }
    return finishPullSuccess(pull, rows, "sftp_pull", { pullId: pull.id, dataSourceId: dsRow.id });
  }

  if (dsRow.kind !== "rest") {
    await markFailed(pullId, `Unsupported source kind: ${dsRow.kind}`);
    return { rowsWritten: 0, status: "failed" };
  }

  let req: RestPullRequest;
  try { req = JSON.parse(pull.requestJson); }
  catch { await markFailed(pullId, "requestJson malformed"); return { rowsWritten: 0, status: "failed" }; }

  // Synthesise a one-block report definition so we can reuse the runner.
  // The runner expects a Report shape with parameters + dataSources +
  // pages. We pass an empty pages array and rely on the runner returning
  // dataset[<queryId>] for our single query.
  const queryId = "ad_hoc_" + pull.id.slice(-8);
  const synthReport = ReportSchema.parse({
    version: 1,
    name: pull.name,
    parameters: [],
    dataSources: [
      {
        id: queryId,
        name: pull.tableName,
        dataSourceId: dsRow.id,
        method: req.method,
        path: req.path,
        body: req.body,
        jsonPath: req.jsonPath,
        headers: req.headers,
      } as DataSourceDef,
    ],
    pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [] }],
  });

  let rows: any[] = [];
  try {
    const dataset = await runReport({ report: synthReport, params: {} });
    rows = dataset[queryId] ?? [];
  } catch (e: any) {
    await markFailed(pullId, `Pull failed: ${e?.message ?? e}`);
    return { rowsWritten: 0, status: "failed" };
  }

  return finishPullSuccess(pull, rows, "rest_pull", {
    pullId: pull.id, dataSourceId: dsRow.id, path: req.path, method: req.method,
  });
}


/**
 * Shared tail for every pull kind: write rows per strategy, refresh the
 * LakeTable catalog row, mark the LakePull row successful, bust the lake
 * query cache. Pulled out so REST and SFTP don't each carry their own copy
 * of this bookkeeping.
 */
async function finishPullSuccess(
  pull: { id: string; tenantId: string; tableName: string; strategy: string; name: string; createdById: string | null },
  rows: any[],
  sourceKind: "rest_pull" | "sftp_pull",
  sourceConfig: Record<string, unknown>,
): Promise<{ rowsWritten: number; status: "ok" | "failed" | "skipped" }> {
  if (rows.length === 0 && pull.strategy === "append") {
    // Nothing to do this tick; don't recreate the table.
    await prisma.lakePull.update({
      where: { id: pull.id },
      data: { lastRunAt: new Date(), lastStatus: "skipped", lastRowsAppended: 0, lastError: null },
    });
    return { rowsWritten: 0, status: "skipped" };
  }

  try {
    if (pull.strategy === "replace") {
      createOrReplaceTable({
        tenantId: pull.tenantId,
        tableName: pull.tableName,
        rows,
        sourceKind,
        sourceConfig,
      });
    } else {
      // append — auto-creates the table on first run via appendRows fallthrough.
      appendRows({ tenantId: pull.tenantId, tableName: pull.tableName, rows });
    }
  } catch (e: any) {
    await markFailed(pull.id, `Lake write failed: ${e?.message ?? e}`);
    return { rowsWritten: 0, status: "failed" };
  }

  // Refresh / create the catalog row so the Tables UI picks the new size.
  const sizeBytes = lakeFileSize(pull.tenantId);
  await prisma.lakeTable.upsert({
    where: { tenantId_name: { tenantId: pull.tenantId, name: pull.tableName } },
    update: {
      sourceKind,
      sourceConfigJson: JSON.stringify({ pullId: pull.id, name: pull.name }),
      rowCount: pull.strategy === "replace" ? rows.length : { increment: rows.length } as any,
      sizeBytes,
      updatedAt: new Date(),
    },
    create: {
      tenantId: pull.tenantId,
      name: pull.tableName,
      sourceKind,
      sourceConfigJson: JSON.stringify({ pullId: pull.id, name: pull.name }),
      schemaJson: "[]",
      rowCount: rows.length,
      sizeBytes,
      createdById: pull.createdById,
    },
  }).catch(async () => {
    // Increment object isn't valid for create; if upsert update path got
    // a non-number rowCount, force a manual count refresh.
    await prisma.lakeTable.updateMany({
      where: { tenantId: pull.tenantId, name: pull.tableName },
      data: { rowCount: rows.length, sizeBytes, updatedAt: new Date() },
    });
  });

  await prisma.lakePull.update({
    where: { id: pull.id },
    data: {
      lastRunAt: new Date(),
      lastStatus: "ok",
      lastRowsAppended: rows.length,
      lastError: null,
    },
  });
  // Pull just landed new rows in the lake — invalidate cached query results.
  setImmediate(() => { void bustLakeCacheForTenant(pull.tenantId); });
  return { rowsWritten: rows.length, status: "ok" };
}

async function markFailed(pullId: string, msg: string): Promise<void> {
  await prisma.lakePull.update({
    where: { id: pullId },
    data: { lastRunAt: new Date(), lastStatus: "failed", lastError: msg.slice(0, 500) },
  });
}
