import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ReportSchema } from "@/lib/reporting/schema";
import { requireUser, tenantWhere, requireReportInScope } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { runReport } from "@/lib/reporting/runner";
import { renderPdf } from "@/lib/reporting/renderers/pdf";
import { renderXlsx } from "@/lib/reporting/renderers/xlsx";
import { renderDocx } from "@/lib/reporting/renderers/docx";
import { renderCsv } from "@/lib/reporting/renderers/csv";
import { browserBusyResponse } from "@/lib/reporting/renderers/headlessBrowser";
import { exportViewer, forwardedSessionCookie } from "@/lib/reporting/exportCaller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/schedules/:id/run
 * Executes a schedule's report right now, returns the rendered file inline.
 * Used by the "Run now" button and suitable for an external cron to POST against.
 *
 * Any role may run one, viewers included: the file comes back to the caller
 * and nowhere else, and it renders as the caller, so it carries only what
 * that caller could already export from the report itself.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const schedule = await prisma.schedule.findFirst({
    // Delivery only: watchers and digests have their own run routes.
    where: { id: params.id, kind: "delivery", ...tenantWhere(user) },
    include: { report: true },
  });
  if (!schedule) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // A report-scoped API key may only run schedules on its allowlisted
  // reports — this route renders the report and returns the file, so
  // without the check any schedule id would hand it any tenant report.
  const scopeBlock = requireReportInScope(user, schedule.reportId);
  if (scopeBlock) return scopeBlock;

  const report = ReportSchema.parse(JSON.parse(schedule.report.definition));
  const runParams = JSON.parse(schedule.params);
  const viewer = await exportViewer(user);
  const authCookie = forwardedSessionCookie(req);

  try {
    let body: Buffer | string;
    let contentType: string;
    let ext: string;
    switch (schedule.format) {
      case "xlsx":
        body = await renderXlsx(report, runParams, { reportId: schedule.reportId, tenantId: schedule.tenantId, authCookie, viewer });
        contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        ext = "xlsx";
        break;
      case "docx":
        body = await renderDocx(report, runParams, { tenantId: schedule.tenantId, viewer });
        contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        ext = "docx";
        break;
      case "csv":
        body = await renderCsv(report, runParams, { tenantId: schedule.tenantId, viewer });
        contentType = "text/csv; charset=utf-8";
        ext = "csv";
        break;
      case "pdf":
      default:
        // PDF needs the report to be executable via the runner to pre-warm dataset
        await runReport({ report, params: runParams, tenantId: schedule.tenantId, viewer });
        body = await renderPdf({
          reportId: schedule.reportId,
          tenantId: schedule.tenantId,
          viewer,
          // The file comes back to the caller, so it has the caller's
          // blocks, like the other formats here. The cron's doesn't.
          blocksAsViewer: true,
          params: runParams,
          pageSize: report.pages[0]?.size,
          landscape: report.pages[0]?.orientation === "landscape",
          authCookie,
          locale: req.cookies.get("rd_locale")?.value,
        });
        contentType = "application/pdf";
        ext = "pdf";
        break;
    }

    await prisma.schedule.update({
      where: { id: schedule.id },
      data: { lastRunAt: new Date(), lastStatus: "ok" },
    });

    recordAudit({
      user, kind: "schedule.runManual", target: schedule.id,
      meta: { reportId: schedule.reportId, format: schedule.format },
    });

    const slug = schedule.report.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report";
    const buf = typeof body === "string" ? Buffer.from(body) : body;
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${slug}.${ext}"`,
      },
    });
  } catch (e: any) {
    // Busy means the run never started, so this schedule's last status is unchanged.
    const busy = browserBusyResponse(e);
    if (busy) return busy;
    await prisma.schedule.update({
      where: { id: schedule.id },
      data: { lastRunAt: new Date(), lastStatus: "failed" },
    });
    return NextResponse.json({ error: e?.message ?? "Run failed" }, { status: 500 });
  }
}
