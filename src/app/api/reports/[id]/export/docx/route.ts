import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ReportSchema } from "@/lib/reporting/schema";
import { resolveCurrency } from "@/lib/reporting/currency";
import { renderDocx } from "@/lib/reporting/renderers/docx";
import { parseParams } from "@/lib/reporting/params";
import { requireUser, requireReportInScope } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

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
  const buf = await renderDocx(report, p, resolveCurrency((report as any).currency, tenantRow?.currency));
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
      "Content-Disposition": 'attachment; filename="' + slug(row.name) + '.docx"',
    },
  });
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report";
}
