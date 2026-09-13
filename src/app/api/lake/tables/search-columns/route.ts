/**
 * GET /api/lake/tables/search-columns?q=<query>&limit=<n>
 *
 * Tenant-scoped semantic search over the columns of this tenant's
 * lake tables. Backs the "Find by meaning" search bar on /tables —
 * a user typing "phone number" gets columns whose names, types, or
 * sample values look phone-like, even when the literal column name
 * is `customer_contact_x` or `mobile_y`.
 *
 * Why a dedicated endpoint instead of leaning on /api/v1/search/semantic:
 *   - Joins back to LakeTable for the parent table name + per-column
 *     type so the UI can render "transactions · customer_email_x · text"
 *     without a second fetch.
 *   - Decodes the synthetic `${tableId}:${columnName}` refId, which the
 *     /v1 endpoint exposes raw.
 *   - Coalesces hits per table, surfacing the strongest column per
 *     table by default — without that, a search for "email" floods
 *     with three rows from the same table and pushes other relevant
 *     tables off the screen.
 *   - Returns an empty array (200) instead of 503 when CURF_VECTOR_DB
 *     is off — the search bar is a polite enhancement, not a hard
 *     dependency.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { ee } from "@/ee";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Score floor — below this we consider it noise. Same env override as
// the MB inline panel: CURF_SIMILAR_FLOOR=0.05 for mock-embedding demos,
// leave unset (default 0.35) in production with real embeddings.
const SCORE_FLOOR = (() => {
  const raw = Number(process.env.CURF_SIMILAR_FLOOR);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.35;
})();

type Hit = {
  tableId: string;
  tableName: string;
  columnName: string;
  columnType: string | null;
  score: number;
  sample: string | null;
};

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const limitRaw = Number(url.searchParams.get("limit") ?? "10");
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 10;

  // Short-circuit on tiny queries — same UX rule as the MB panel.
  // 4-char floor here (lower than MB's 8) because column-name searches
  // are naturally shorter ("email", "phone", "name", "city").
  if (q.length === 0) return NextResponse.json({ hits: [] });
  if (q.length < 4) return NextResponse.json({ hits: [] });

  // Semantic search needs the paid vector store; without it the box on
  // /tables simply finds nothing (same as CURF_VECTOR_DB off).
  if (process.env.CURF_VECTOR_DB !== "on" || !ee.vectorStore) {
    return NextResponse.json({ hits: [], note: "vector_db_off" });
  }

  try {
    // Pull more than `limit` raw results — we'll coalesce duplicates
    // per-table afterwards and the post-filter could reduce the count.
    const raw = (await ee.vectorStore.searchSimilar({
      tenantId: user.tenantId,
      kind: "schema_col",
      queryText: q,
      limit: Math.min(50, limit * 3),
    })) as Array<{ refId: string; score: number }>;
    const goodHits = raw.filter((h) => h.score >= SCORE_FLOOR);
    if (goodHits.length === 0) return NextResponse.json({ hits: [] });

    // Decode refId → (tableId, columnName). Collect unique tableIds for
    // a single batched join to LakeTable.
    const decoded: Array<{ tableId: string; columnName: string; score: number }> = [];
    const tableIds = new Set<string>();
    for (const h of goodHits) {
      const sep = h.refId.indexOf(":");
      if (sep < 0) continue;
      const tableId = h.refId.slice(0, sep);
      const columnName = h.refId.slice(sep + 1);
      if (!tableId || !columnName) continue;
      decoded.push({ tableId, columnName, score: h.score });
      tableIds.add(tableId);
    }
    if (decoded.length === 0) return NextResponse.json({ hits: [] });

    // Join back. Filter by tenantId again as a defence-in-depth — the
    // vector index is already tenant-scoped, but composition between
    // RLS systems is worth a second check.
    const tables = await prisma.lakeTable.findMany({
      where: { id: { in: Array.from(tableIds) }, tenantId: user.tenantId },
      select: { id: true, name: true, schemaJson: true },
    });
    const tableById = new Map<string, { name: string; cols: Map<string, { type: string; sample: string | null }> }>();
    for (const t of tables ?? []) {
      let parsed: any[] = [];
      try { parsed = JSON.parse(t.schemaJson ?? "[]"); } catch { /* ignore malformed */ }
      const cols = new Map<string, { type: string; sample: string | null }>();
      if (Array.isArray(parsed)) {
        for (const c of parsed) {
          if (c?.name) {
            cols.set(c.name, {
              type: typeof c.type === "string" ? c.type : "unknown",
              sample: c.sample == null ? null : String(c.sample).slice(0, 60),
            });
          }
        }
      }
      tableById.set(t.id, { name: t.name, cols });
    }

    // Build the final hits — drop refs whose table or column went away
    // (drop / rename happened after the embedding was written).
    const hits: Hit[] = [];
    const seenPerTable = new Map<string, number>();   // best score per table
    const SEEN_LIMIT = 2;                              // up to 2 cols per table
    for (const d of decoded) {
      const tbl = tableById.get(d.tableId);
      if (!tbl) continue;
      const col = tbl.cols.get(d.columnName);
      if (!col) continue;
      const seen = seenPerTable.get(d.tableId) ?? 0;
      if (seen >= SEEN_LIMIT) continue;
      seenPerTable.set(d.tableId, seen + 1);
      hits.push({
        tableId: d.tableId,
        tableName: tbl.name,
        columnName: d.columnName,
        columnType: col.type,
        score: Number(d.score.toFixed(3)),
        sample: col.sample,
      });
      if (hits.length >= limit) break;
    }

    return NextResponse.json({ hits });
  } catch (e: any) {
    // Suggestion-style endpoint: a lookup failure must never break the
    // /tables page. Return 200 + empty array with a debug note in logs.
    return NextResponse.json({ hits: [], error: e?.message?.slice(0, 200) ?? "lookup failed" });
  }
}
