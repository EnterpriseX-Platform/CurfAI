import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ReportSchema } from "@/lib/reporting/schema";
import { requireUser, tenantWhere } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { runReport } from "@/lib/reporting/runner";
import { renderPdf } from "@/lib/reporting/renderers/pdf";
import { renderXlsx } from "@/lib/reporting/renderers/xlsx";
import { renderDocx } from "@/lib/reporting/renderers/docx";
import { renderCsv } from "@/lib/reporting/renderers/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/schedules/:id/run
 * Executes a schedule's report right now, returns the rendered file inline.
 * Used by the "Run now" button and suitable for an external cron to POST against.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const schedule = await prisma.schedule.findFirst({ where: { id: params.id, tenantId: user.tenantId },
    include: { report: true },
  });
  if (!schedule) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const report = ReportSchema.parse(JSON.parse(schedule.report.definition));
  const runParams = JSON.parse(schedule.params);

  try {
    let body: Buffer | string;
    let contentType: string;
    let ext: string;
    switch (schedule.format) {
      case "xlsx":
        body = await renderXlsx(report, runParams, { reportId: schedule.reportId });
        contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        ext = "xlsx";
        break;
      case "docx":
        body = await renderDocx(report, runParams);
        contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        ext = "docx";
        break;
      case "csv":
        body = await renderCsv(report, runParams);
        contentType = "text/csv; charset=utf-8";
        ext = "csv";
        break;
      case "pdf":
      default:
        // PDF needs the report to be executable via the runner to pre-warm dataset
        await runReport({ report, params: runParams });
        body = await renderPdf({
          reportId: schedule.reportId,
          params: runParams,
          pageSize: report.pages[0]?.size,
          landscape: report.pages[0]?.orientation === "landscape",
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
    await prisma.schedule.update({
      where: { id: schedule.id },
      data: { lastRunAt: new Date(), lastStatus: "failed" },
    });
    return NextResponse.json({ error: e?.message ?? "Run failed" }, { status: 500 });
  }
}
