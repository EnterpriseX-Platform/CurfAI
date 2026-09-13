import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, tenantWhere } from "@/lib/auth";

/**
 * GET /api/roles
 * Returns the list of custom role slugs for populating the designer's
 * "Visible to roles" multi-select. Requires auth but not admin.
 */
export async function GET(req: NextRequest) {
  const u = await requireUser(req);
  if (!u) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rows = await prisma.role.findMany({
    // Role is tenant-scoped (@@unique([tenantId, slug])); without this filter
    // the designer's role picker leaked every tenant's role slugs + labels.
    where: { ...tenantWhere(u) },
    select: { slug: true, label: true },
    orderBy: { slug: "asc" },
  });
  return NextResponse.json({ items: rows });
}
