/**
 * Materialized view refresh — run the SQL, replace the cached lake table.
 *
 * Reuses the existing report runner so we don't have a parallel SQL
 * execution path. Synthesises a one-block report with the MV's SQL,
 * pulls the result rows out of the dataset, then writes them to the
 * lake under the "mv_<safeName>" namespace.
 *
 * Idempotent + atomic: every refresh fully replaces the cached table.
 * No partial-update mode — keeps the consumer-side semantics simple
 * ("the table you read at time T contains rows from the most recent
 * full refresh ≤ T").
 */
import { prisma } from "@/lib/db";
import { ReportSchema } from "@/lib/reporting/schema";
import { runReport } from "@/lib/reporting/runner";
import { createOrReplaceTable } from "@/lib/lake/tables";
import { lakeFileSize, toSafeTableName } from "@/lib/lake/storage";
import { emitWebhook } from "@/lib/webhooks";
import { bustLakeCacheForTenant } from "@/lib/lake/bust";

// MV-named lake tables get an "mv_" prefix so the catalog list can show
// them as a separate group (and so a regular CSV upload can't collide
// with one).
export function mvTableName(name: string): string {
  // Normalise via toSafeTableName first (lowercase, alnum/underscore),
  // then prefix. Matches what addColumn and createOrReplaceTable expect.
  return "mv_" + toSafeTableName(name);
}

export type MaterializeResult = {
  rowCount: number;
  durationMs: number;
  status: "ok" | "failed";
  error?: string;
};

export async function refreshMaterializedView(mvId: string): Promise<MaterializeResult> {
  const startedAt = Date.now();
  const mv = await prisma.materializedView.findUnique({ where: { id: mvId } });
  if (!mv) throw new Error(`MaterializedView ${mvId} not found`);

  // Synthesise a single-query report shape so we can reuse the runner.
  // The runner expects a Report with parameters + dataSources + pages —
  // we pass an empty pages array and pull dataset[queryId] below.
  const queryId = "mv_q_" + mv.id.slice(-8);
  const synth = ReportSchema.parse({
    version: 1,
    name: mv.name,
    parameters: [],
    dataSources: [
      {
        id: queryId,
        name: mv.name,
        dataSourceId: mv.dataSourceId,
        sql: mv.sql,
      },
    ],
    pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [] }],
  });

  let rows: any[] = [];
  try {
    const dataset = await runReport({ report: synth, params: {} });
    rows = dataset[queryId] ?? [];
  } catch (e: any) {
    const error = (e?.message ?? String(e)).slice(0, 500);
    await prisma.materializedView.update({
      where: { id: mv.id },
      data: { lastRunAt: new Date(), lastStatus: "failed", lastError: error, lastDurationMs: Date.now() - startedAt },
    });
    void emitWebhook({
      tenantId: mv.tenantId,
      event: "lake.mv.failed",
      data: { mvId: mv.id, mvName: mv.name, error, durationMs: Date.now() - startedAt },
    });
    return { rowCount: 0, durationMs: Date.now() - startedAt, status: "failed", error };
  }

  // Write to the lake under "mv_<safeName>". Always replace — no append.
  let mvColumns: ReturnType<typeof createOrReplaceTable>["columns"] = [];
  try {
    mvColumns = createOrReplaceTable({
      tenantId: mv.tenantId,
      tableName: mvTableName(mv.name),
      rows,
      sourceKind: "manual",
      sourceConfig: { kind: "materialized_view", mvId: mv.id, name: mv.name },
    }).columns;
  } catch (e: any) {
    const error = `Lake write failed: ${e?.message ?? e}`.slice(0, 500);
    await prisma.materializedView.update({
      where: { id: mv.id },
      data: { lastRunAt: new Date(), lastStatus: "failed", lastError: error, lastDurationMs: Date.now() - startedAt },
    });
    void emitWebhook({
      tenantId: mv.tenantId,
      event: "lake.mv.failed",
      data: { mvId: mv.id, mvName: mv.name, error, durationMs: Date.now() - startedAt },
    });
    return { rowCount: 0, durationMs: Date.now() - startedAt, status: "failed", error };
  }

  // Refresh the catalog row + the LakeTable mirror so /tables sees the
  // updated row count. Same pattern as restPull.ts — upsert because the
  // first refresh might be when the mv_* lake table comes into existence.
  const sizeBytes = lakeFileSize(mv.tenantId);
  await prisma.lakeTable.upsert({
    where: { tenantId_name: { tenantId: mv.tenantId, name: mvTableName(mv.name) } },
    update: {
      sourceKind: "manual",
      sourceConfigJson: JSON.stringify({ kind: "materialized_view", mvId: mv.id, name: mv.name }),
      schemaJson: JSON.stringify(mvColumns),
      rowCount: rows.length,
      sizeBytes,
      updatedAt: new Date(),
    },
    create: {
      tenantId: mv.tenantId,
      name: mvTableName(mv.name),
      sourceKind: "manual",
      sourceConfigJson: JSON.stringify({ kind: "materialized_view", mvId: mv.id, name: mv.name }),
      schemaJson: JSON.stringify(mvColumns),
      rowCount: rows.length,
      sizeBytes,
      createdById: mv.createdById,
    },
  }).catch(() => null);

  await prisma.materializedView.update({
    where: { id: mv.id },
    data: {
      lastRunAt: new Date(),
      lastStatus: "ok",
      lastRowCount: rows.length,
      lastDurationMs: Date.now() - startedAt,
      lastError: null,
    },
  });
  // The MV swap replaces the cached lake table the runner reads from. Any
  // in-process query result that was holding the prior MV rows is stale —
  // drop them so the next view picks up the fresh refresh.
  setImmediate(() => { void bustLakeCacheForTenant(mv.tenantId); });
  return { rowCount: rows.length, durationMs: Date.now() - startedAt, status: "ok" };
}

// Re-export for the API + UI layers — keeps "what's the on-disk name
// of this MV?" in one place.
export { toSafeTableName as safeNameForMv };
