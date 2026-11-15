/**
 * GET /api/data-sources/:id/impact — what stops working if this connection is
 * deleted: the reports whose definition names it. Admin only, like the
 * delete itself. A report names its source by id, so the id as text is a
 * sound match (a cuid does not occur by accident).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin, tenantWhere, reportWhere } from "@/lib/auth";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const source = await prisma.dataSource.findFirst({ where: { id: params.id, ...tenantWhere(user) }, select: { id: true } });
  if (!source) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const reports = await prisma.report.findMany({
    where: { ...reportWhere(user), definition: { contains: source.id } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 20,
  });
  return NextResponse.json({ reports });
}
