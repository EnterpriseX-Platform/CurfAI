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
import { prisma } from "@/lib/db";
import { requireUser, getUserRoles } from "@/lib/auth";
import { canSeeDataSource } from "@/lib/datasourceAcl";
import { previewRows } from "@/lib/lake/tables";
import { applyRedaction } from "@/lib/lake/redaction";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: { name: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));

  const tableRow = await prisma.lakeTable.findFirst({
    where: { tenantId: user.tenantId, name: params.name },
  }).catch(() => null);
  if (!tableRow) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const userRoles = await getUserRoles();
  const isAdmin = user.role === "admin";
  if (!canSeeDataSource(tableRow, { id: user.id, isAdmin, roles: userRoles })) {
    // Same status code as not-found so existence is concealed.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let schema: any[] = [];
  try { schema = JSON.parse(tableRow.schemaJson) ?? []; } catch { /* keep empty */ }

  const rows = previewRows(user.tenantId, params.name, limit, offset);
  applyRedaction(rows, schema, { id: user.id, role: user.role, roleSlugs: userRoles });

  return NextResponse.json({
    data: rows,
    rowCount: tableRow.rowCount,
    schema,
    limit,
    offset,
  });
}
