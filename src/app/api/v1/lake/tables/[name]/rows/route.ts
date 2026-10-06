/**
 * GET /api/v1/lake/tables/[name]/rows — fetch rows from a lake table.
 *
 *   ?limit=<n>   default 100, max 5000
 *   ?offset=<n>  default 0
 *
 * Honours column-level redaction — fields tagged sensitivity=pii/secret
 * are masked before they leave the building unless the caller's role is
 * in the column's `unredactedForRoles` allowlist.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { previewRows } from "@/lib/lake/tables";
import { applyRedaction, redactSamples } from "@/lib/lake/redaction";
import { lakeTableFor } from "@/lib/lake/tableAccess";
import { parseSchemaJson } from "@/lib/lake/schemaGovernance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: { name: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));

  // The same door as the internal table routes: the lake ACL (a table the key
  // can't read is not found), and no report-scoped keys.
  const access = await lakeTableFor(user, params.name, "read");
  if (access instanceof NextResponse) return access;
  const { row: tableRow, viewer } = access;

  const schema = parseSchemaJson(tableRow.schemaJson);

  const rows = await previewRows(user.tenantId, tableRow.name, limit, offset);
  applyRedaction(rows, schema, viewer);

  return NextResponse.json({
    data: rows,
    rowCount: tableRow.rowCount,
    // Samples are values from the table: masked like the rows.
    schema: redactSamples(schema, viewer),
    limit,
    offset,
  });
}
