/**
 * Per-tenant lake mutation hook for the query result cache.
 *
 * Each lake mutation (CSV reupload, row append, table delete, MV refresh)
 * invalidates query results that read from this tenant's lake DataSource.
 * The cache keys on `dataSourceId`, so we look up the tenant's lake source
 * row(s) once and call bustForDataSource for each.
 *
 * In practice a tenant has a single DataSource of kind="lake" pointing at
 * the per-tenant SQLite/DuckDB file. Branches and time-travel reads still
 * route through the same source row, so a single bust covers them all.
 *
 * Fire-and-forget callers are fine — bust failure isn't worth aborting a
 * mutation. The 30-second TTL is the safety net.
 */
import { prisma } from "@/lib/db";
import { bustForDataSource } from "@/lib/reporting/queryCache";
import { broadcastToTenant } from "@/lib/realtime/bus";

export async function bustLakeCacheForTenant(tenantId: string, tableName?: string): Promise<void> {
  try {
    const sources = await prisma.dataSource.findMany({
      where: { tenantId, kind: "lake" },
      select: { id: true },
    });
    for (const s of sources) {
      bustForDataSource(tenantId, s.id);
      // Push a realtime event so any subscribed dashboard / report
      // viewer can re-fetch the affected blocks. Fire-and-forget; the
      // bus is in-process and never throws on its own — even if it
      // did, the cache TTL backstops the staleness.
      broadcastToTenant(tenantId, {
        kind: "lake.bust",
        dataSourceId: s.id,
        tableName: tableName ?? null,
        ts: Date.now(),
      });
    }
  } catch {
    // Cache invalidation should never block a write path. The TTL will
    // catch us within 30 seconds even if the lookup fails.
  }
}
