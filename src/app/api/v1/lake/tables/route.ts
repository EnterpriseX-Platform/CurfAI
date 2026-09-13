/**
 * GET /api/v1/lake/tables — list lake tables in this tenant (catalog view).
 *
 * Adapter over the internal /api/lake/tables handler: same RBAC (owner-only /
 * role-allowlist / tenant-wide visibility), same Prisma query, same ACL
 * function (`canRead`) — this route just maps the response down to the
 * smaller public-safe shape (no sourceConfig, ownerUserId, visibleToRoles,
 * quota, or usage). Doesn't return cell data — use /lake/tables/[name]/rows
 * for that.
 */
import { NextRequest, NextResponse } from "next/server";
import { GET as internalGET } from "@/app/api/lake/tables/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const internalRes = await internalGET(req);
  if (internalRes.status !== 200) return internalRes;

  const body = await internalRes.json();
  const items: any[] = Array.isArray(body.items) ? body.items : [];

  return NextResponse.json({
    data: items.map((t) => ({
      id: t.id,
      name: t.name,
      sourceKind: t.sourceKind,
      schema: t.schema ?? [],
      rowCount: t.rowCount,
      sizeBytes: t.sizeBytes,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
  });
}
