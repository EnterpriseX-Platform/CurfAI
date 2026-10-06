import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ReportSchema } from "@/lib/reporting/schema";
import { renderCsv } from "@/lib/reporting/renderers/csv";
import { parseParams } from "@/lib/reporting/params";
import { requireUser, requireReportInScope } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { exportViewer } from "@/lib/reporting/exportCaller";
import { contentDisposition } from "@/lib/http/contentDisposition";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;

  const row = await prisma.report.findFirst({ where: { id: params.id, tenantId: user.tenantId } });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const report = ReportSchema.parse(JSON.parse(row.definition));
  const url = new URL(req.url);
  const p = parseParams(url, report.parameters);
  const blockId = url.searchParams.get("block") ?? undefined;

  try {
    const viewer = await exportViewer(user);
    const csv = await renderCsv(report, p, { tenantId: row.tenantId, blockId, viewer });
    await prisma.reportRun.create({
      data: {
        tenantId: user.tenantId,
        reportId: row.id,
        userId: user.viaApiKey ? null : user.id,
        format: "csv",
        params: JSON.stringify(p),
        status: "completed",
      },
    });
    recordAudit({
      user, kind: "export.csv", target: row.id, req,
      meta: { name: row.name, blockId: blockId ?? null, paramKeys: Object.keys(p) },
    });
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": contentDisposition("attachment", row.name, "csv"),
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Failed" }, { status: 400 });
  }
}
