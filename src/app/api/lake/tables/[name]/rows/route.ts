/**
 * GET /api/lake/tables/[name]/rows — a page of rows for the spreadsheet view.
 *
 *   ?sort=<column>&dir=asc|desc   sorted by the column's typed value, blanks last
 *   ?find=<text>                  rows with the text in any column the viewer can see
 *   ?cursor=<next>                the page after the one that returned it
 *   ?limit=<n>                    default 200, at most 500
 *
 * Keyset-paged (lib/lake/rowsPage.ts), so it's as quick deep into a
 * million-row table as at the top. Masked as the table page is: rows and
 * column samples by each column's tags, a formula column by the tags of
 * what it reads; a masked column can't be sorted by and isn't searched.
 * Each row carries its rowid under `rowIdKey`, for the view to key rows by.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { lakeTableFor } from "@/lib/lake/tableAccess";
import { applyRedaction, readsSensitiveData, redactSamples, shouldRedact } from "@/lib/lake/redaction";
import { getTable } from "@/lib/lake/tables";
import { mergeGovernanceMetadata, parseSchemaJson } from "@/lib/lake/schemaGovernance";
import { rowsPage, RowsPageError } from "@/lib/lake/rowsPage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: { name: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await lakeTableFor(user, decodeURIComponent(params.name), "read");
  if (access instanceof NextResponse) return access;
  const { row, viewer } = access;

  const table = await getTable(user.tenantId, row.name);
  if (!table) return NextResponse.json({ error: "Table not found" }, { status: 404 });
  // Types and formulas from the lake, tags from the catalog.
  const schema = mergeGovernanceMetadata(parseSchemaJson(row.schemaJson), table.columns);
  const masked = new Set(schema.filter((c) => shouldRedact(viewer, c)).map((c) => c.name));

  const q = req.nextUrl.searchParams;
  const sortColumn = q.get("sort");
  let page;
  try {
    page = await rowsPage({
      tenantId: user.tenantId,
      tableName: row.name,
      columns: table.columns,
      masked,
      sort: sortColumn ? { column: sortColumn, dir: q.get("dir") === "desc" ? "desc" : "asc" } : undefined,
      find: q.get("find") ?? undefined,
      cursor: q.get("cursor") ?? undefined,
      limit: Number(q.get("limit") ?? 200) || 200,
    });
  } catch (e) {
    if (e instanceof RowsPageError) return NextResponse.json({ error: e.message, key: e.key, params: e.params }, { status: 400 });
    throw e;
  }

  const rows = applyRedaction(page.rows, schema, viewer);
  // Once per view, not per page scrolled.
  const sens = readsSensitiveData(viewer, schema);
  if (sens.any && !q.get("cursor")) {
    recordAudit({ user, kind: "lake.table.read.sensitive", target: row.id, req, meta: { name: row.name, redactedColumns: sens.redactedColumns } });
  }

  return NextResponse.json({
    columns: redactSamples(schema, viewer).map((c) => (masked.has(c.name) ? { ...c, masked: true } : c)),
    rows,
    rowIdKey: page.rowIdKey,
    next: page.next,
    rowCount: table.rowCount,
  });
}
