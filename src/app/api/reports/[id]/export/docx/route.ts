import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ReportSchema } from "@/lib/reporting/schema";
import { resolveCurrency } from "@/lib/reporting/currency";
import { resolveDateStyle } from "@/lib/reporting/format";
import { renderDocx } from "@/lib/reporting/renderers/docx";
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

  const tenantRow = await prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { currency: true } }).catch(() => null);
  const viewer = await exportViewer(user);
  let buf: Buffer;
  try {
    buf = await renderDocx(report, p, { tenantId: row.tenantId, currency: resolveCurrency((report as any).currency, tenantRow?.currency), viewer, dateStyle: resolveDateStyle(req.cookies.get("rd_locale")?.value, req.cookies.get("rd_era")?.value === "ce" ? "ce" : undefined, report.dateEra) });
  } catch (e: any) {
    await prisma.reportRun.create({
      data: {
        tenantId: user.tenantId,
        reportId: row.id,
        userId: user.viaApiKey ? null : user.id,
        format: "docx",
        params: JSON.stringify(p),
        status: "failed",
        error: e?.message,
      },
    });
    return NextResponse.json({ error: e?.message ?? "Failed" }, { status: 500 });
  }
  await prisma.reportRun.create({
    data: {
      tenantId: user.tenantId,
      reportId: row.id,
      userId: user.viaApiKey ? null : user.id,
      format: "docx",
      params: JSON.stringify(p),
      status: "completed",
    },
  });
  recordAudit({
    user, kind: "export.docx", target: row.id, req,
    meta: { name: row.name, paramKeys: Object.keys(p) },
  });
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": contentDisposition("attachment", row.name, "docx"),
    },
  });
}
