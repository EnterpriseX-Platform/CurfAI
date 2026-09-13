import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ReportSchema } from "@/lib/reporting/schema";
import { renderPdf } from "@/lib/reporting/renderers/pdf";
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
  const page = report.pages[0];

  const sessionCookie = req.cookies.get("next-auth.session-token")
    ?? req.cookies.get("__Secure-next-auth.session-token");
  const authCookie = sessionCookie
    ? sessionCookie.name + "=" + encodeURIComponent(sessionCookie.value)
    : undefined;
  const locale = req.cookies.get("rd_locale")?.value;

  try {
    const pdf = await renderPdf({
      reportId: row.id,
      params: p,
      pageSize: page?.size,
      landscape: page?.orientation === "landscape",
      authCookie,
      locale,
      reportName: row.name,
    });
    await prisma.reportRun.create({
      data: {
        tenantId: user.tenantId,
        reportId: row.id,
        userId: user.viaApiKey ? null : user.id,
        format: "pdf",
        params: JSON.stringify(p),
        status: "completed",
      },
    });
    recordAudit({
      user, kind: "export.pdf", target: row.id, req,
      meta: { name: row.name, paramKeys: Object.keys(p) },
    });
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'inline; filename="' + slug(row.name) + '.pdf"',
      },
    });
  } catch (e: any) {
    await prisma.reportRun.create({
      data: {
        tenantId: user.tenantId,
        reportId: row.id,
        userId: user.viaApiKey ? null : user.id,
        format: "pdf",
        params: JSON.stringify(p),
        status: "failed",
        error: e?.message,
      },
    });
    return NextResponse.json({ error: e?.message ?? "Failed" }, { status: 500 });
  }
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report";
}
