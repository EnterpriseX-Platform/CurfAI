import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, tenantWhere, requireReportInScope } from "@/lib/auth";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;
  const report = await prisma.report.findFirst({
    where: { id: params.id, ...tenantWhere(user) },
    select: { id: true },
  });
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const rows = await prisma.reportVersion.findMany({
    where: { reportId: params.id },
    orderBy: { version: "desc" },
    include: { createdBy: { select: { name: true, email: true } } },
  });
  return NextResponse.json({
    items: rows.map((v: any) => ({
      id: v.id,
      version: v.version,
      createdAt: v.createdAt,
      createdBy: v.createdBy?.name ?? v.createdBy?.email ?? null,
      note: v.note,
    })),
  });
}
