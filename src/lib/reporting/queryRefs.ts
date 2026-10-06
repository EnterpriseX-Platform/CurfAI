/**
 * Which queries a report's parts read. Pure — no server imports — so the
 * runner, visibleReport() and the drill handling share one walker.
 *
 * A block or query reads a query through a field named queryId or ending in
 * QueryId, at any depth: config.queryId, a KPI's sparkQueryId, a map's
 * pinsQueryId, a drilldown's queryId, a join's queryId. Those are the only
 * references (text interpolates params and rows, never a query), and
 * visibleReport.test.ts fails if a field that names a query breaks the
 * pattern.
 */
import type { DataSourceDef } from "./schema";

/** Ids of the queries `from` reads, plus the queries those read, and so on. */
export function neededQueries(queries: DataSourceDef[], from: unknown): Set<string> {
  const byId = new Map(queries.map((q) => [q.id, q]));
  const needed = new Set<string>();
  const pending = queryRefs(from);
  while (pending.length > 0) {
    const q = byId.get(pending.pop()!);
    if (!q || needed.has(q.id)) continue;
    needed.add(q.id);
    pending.push(...queryRefs(q));
  }
  return needed;
}

/** Every string under a key named queryId or ending in QueryId, at any depth. */
export function queryRefs(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) queryRefs(v, out);
  } else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (typeof v === "string" && (key === "queryId" || key.endsWith("QueryId"))) out.push(v);
      else queryRefs(v, out);
    }
  }
  return out;
}
