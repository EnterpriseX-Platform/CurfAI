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
import { runQueryStrict } from "@/lib/reporting/runQueryStrict";
import { SYSTEM_RUN } from "@/lib/reporting/runner";
import { createOrReplaceTable } from "@/lib/lake/tables";
import { governDerivedColumns, governDerivedTableAcl, loadDerivationSources } from "@/lib/lake/sourceGovernance";
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
  //
  // ReportSchema.parse() enforces the read-only-SELECT guard on `sql` (see
  // schema.ts) — it can reject just as validly as a query or a write can
  // fail, but .parse() throws synchronously instead of returning a result,
  // and unlike the stages below this used to run outside any try/catch:
  // an edited MV whose SQL picked up a second statement (a stray `;`, a
  // pasted DDL/DML line) crashed the route with an uncaught ZodError and
  // an empty 500 instead of a normal "this MV failed to refresh, here's
  // why" result. Found live via an adversarial-SQL edge-case pass.
  const queryId = "mv_q_" + mv.id.slice(-8);
  let synth: ReturnType<typeof ReportSchema.parse>;
  try {
    synth = ReportSchema.parse({
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

  let rows: any[] = [];
  try {
    // Strict: a query that failed must fail the refresh. runReport() would hand
    // back [] for it, and the swap below would replace the last good table with
    // nothing and mark the view healthy.
    rows = await runQueryStrict({ report: synth, params: {}, tenantId: mv.tenantId, viewer: SYSTEM_RUN }, queryId);
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
  let mvColumns: Awaited<ReturnType<typeof createOrReplaceTable>>["columns"] = [];
  try {
    mvColumns = (await createOrReplaceTable({
      tenantId: mv.tenantId,
      tableName: mvTableName(mv.name),
      rows,
      sourceKind: "manual",
      sourceConfig: { kind: "materialized_view", mvId: mv.id, name: mv.name },
      // Rows come straight from the report runner — force typed DDL so a
      // downstream MV/pipeline reading this table can compare/aggregate it
      // without its own CAST. See createOrReplaceTable's forceTypedColumns
      // doc comment.
      forceTypedColumns: true,
    })).columns;
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
  // A refresh rebuilds the table's columns from the query result, which has no
  // redaction tags; anything an admin tagged on this mv_* table since the
  // last refresh would otherwise be wiped every time the schedule fires.
  // Also inherits the tags of the tables mv.sql reads, so
  // `SELECT email FROM customers` doesn't come out as a table whose email
  // column every viewer can read raw — including on the very first refresh,
  // not just later ones. governDerivedColumns throws on a lookup failure
  // rather than returning untagged columns (redaction failing open), so this
  // is caught the same way the write above is: report the failure, write
  // nothing, rather than let it escape uncaught and skip the write's own
  // error reporting.
  let mvColumnsWithGovernance: typeof mvColumns;
  // Table-level ACL inheritance (sourceGovernance.ts's own header, "TABLE-LEVEL
  // ACL INHERITANCE" section): an MV over an owner_only/role-restricted source
  // shouldn't be tenant-wide just because it's a fresh row with no ACL of its
  // own. null when there's nothing to inherit, or the row already has its own
  // restriction — omitted from the upsert `data` below either way, never
  // written as an explicit "clear it" null/[].
  let tableAcl: { ownerUserId: string | null; visibleToRolesJson: string } | null;
  try {
    const sources = await loadDerivationSources(mv.tenantId, mv.sql);
    mvColumnsWithGovernance = await governDerivedColumns({
      tenantId: mv.tenantId,
      tableName: mvTableName(mv.name),
      sql: mv.sql,
      columns: mvColumns,
    });
    tableAcl = await governDerivedTableAcl({ tenantId: mv.tenantId, tableName: mvTableName(mv.name), sources });
  } catch (e: any) {
    const error = `Governance lookup failed: ${e?.message ?? e}`.slice(0, 500);
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
  await prisma.lakeTable.upsert({
    where: { tenantId_name: { tenantId: mv.tenantId, name: mvTableName(mv.name) } },
    update: {
      sourceKind: "manual",
      sourceConfigJson: JSON.stringify({ kind: "materialized_view", mvId: mv.id, name: mv.name }),
      schemaJson: JSON.stringify(mvColumnsWithGovernance),
      rowCount: rows.length,
      sizeBytes,
      updatedAt: new Date(),
      ...tableAcl,
    },
    create: {
      tenantId: mv.tenantId,
      name: mvTableName(mv.name),
      sourceKind: "manual",
      sourceConfigJson: JSON.stringify({ kind: "materialized_view", mvId: mv.id, name: mv.name }),
      schemaJson: JSON.stringify(mvColumnsWithGovernance),
      rowCount: rows.length,
      sizeBytes,
      createdById: mv.createdById,
      ...tableAcl,
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
