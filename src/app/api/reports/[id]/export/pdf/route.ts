import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ReportSchema } from "@/lib/reporting/schema";
import { renderPdf } from "@/lib/reporting/renderers/pdf";
import { browserBusyResponse } from "@/lib/reporting/renderers/headlessBrowser";
import { parseParams } from "@/lib/reporting/params";
import { requireUser, requireReportInScope } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { exportViewer, forwardedSessionCookie } from "@/lib/reporting/exportCaller";
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
  const page = report.pages[0];

  const authCookie = forwardedSessionCookie(req);
  const locale = req.cookies.get("rd_locale")?.value;
  const era = req.cookies.get("rd_era")?.value === "ce" ? "ce" as const : undefined;
  // An API key has no cookie to forward, so the page runs the report as
  // this viewer from the render token, and shows the blocks it may see.
  const viewer = await exportViewer(user);

  try {
    const pdf = await renderPdf({
      reportId: row.id,
      tenantId: row.tenantId,
      viewer,
      blocksAsViewer: true,
      params: p,
      pageSize: page?.size,
      landscape: page?.orientation === "landscape",
      authCookie,
      locale,
      era,
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
        "Content-Disposition": contentDisposition("inline", row.name, "pdf"),
      },
    });
  } catch (e: any) {
    // Busy is "try again", not a failed run. It never started.
    const busy = browserBusyResponse(e);
    if (busy) return busy;
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
