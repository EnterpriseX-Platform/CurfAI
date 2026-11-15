/**
 * Fire one `delivery` schedule: render the report in the schedule's format as its creator, and send it to the recipients
 * through the schedule's channel. Used by the cron tick (lib/cron/tickRunner.ts) and by the `schedule.fire` job
 * (lib/jobs/handlers.ts), which is why it lives here and not in the route.
 */
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { dispatchDelivery, parseDeliveryConfig, type Rendered } from "@/lib/delivery/dispatch";
import { renderPdf } from "@/lib/reporting/renderers/pdf";
import { renderXlsx } from "@/lib/reporting/renderers/xlsx";
import { renderDocx } from "@/lib/reporting/renderers/docx";
import { renderCsv } from "@/lib/reporting/renderers/csv";
import { ReportSchema } from "@/lib/reporting/schema";
import { runReport } from "@/lib/reporting/runner";
import { deliveryViewer } from "@/lib/reporting/exportCaller";
import { visibleReport } from "@/lib/reporting/visibleReport";
import { safeParseJson } from "@/lib/cron/types";
import { appBase } from "@/lib/http/appBase";

export async function fireDelivery(sched: any, req: NextRequest) {
  const reportRow = await prisma.report.findUnique({ where: { id: sched.reportId } });
  if (!reportRow) throw new Error("Report missing");
  // Blocks a report author gated by role stay out of a delivery whoever
  // created it, as they always have: the scheduled PDF's page filters them
  // as nobody (renderPdf below isn't passed blocksAsViewer), so every other
  // format does too. The creator (below) decides only which data the
  // remaining blocks carry.
  const report = visibleReport(ReportSchema.parse(JSON.parse(reportRow.definition)), undefined);
  const runParams: Record<string, unknown> = safeParseJson<Record<string, unknown>>(sched.params) ?? {};
  // No one is asking for this file, and it goes to whoever is on the
  // recipient list, so it renders as the schedule's creator. It used to
  // render as the system, and a developer could have emailed out data from
  // sources their own role can't see.
  const viewer = await deliveryViewer(sched);

  let body: Buffer;
  let contentType: string;
  let ext: string;
  switch (sched.format) {
    case "xlsx":
      body = await renderXlsx(report, runParams, { reportId: sched.reportId, tenantId: sched.tenantId, viewer });
      contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      ext = "xlsx";
      break;
    case "docx":
      body = await renderDocx(report, runParams, { tenantId: sched.tenantId, viewer });
      contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      ext = "docx";
      break;
    case "csv": {
      const csv = await renderCsv(report, runParams, { tenantId: sched.tenantId, viewer });
      body = Buffer.from(csv);
      contentType = "text/csv; charset=utf-8";
      ext = "csv";
      break;
    }
    case "pdf":
    default:
      await runReport({ report, params: runParams, tenantId: sched.tenantId, viewer });
      body = await renderPdf({
        reportId: sched.reportId,
        tenantId: sched.tenantId,
        viewer,
        params: runParams,
        pageSize: report.pages[0]?.size,
        landscape: report.pages[0]?.orientation === "landscape",
      });
      contentType = "application/pdf";
      ext = "pdf";
      break;
  }

  const slug = reportRow.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report";
  const rendered: Rendered = {
    body,
    filename: slug + "." + ext,
    contentType,
    reportName: reportRow.name,
    reportId: reportRow.id,
    origin: appBase(req),
    tenantId: sched.tenantId,
  };

  const recipients = safeParseJson<string[]>(sched.recipients) ?? [];
  const config = parseDeliveryConfig(sched.deliveryConfigJson, recipients);

  const result = await dispatchDelivery(config, rendered);

  await prisma.schedule.update({
    where: { id: sched.id },
    data: {
      lastRunAt: new Date(),
      lastStatus: result.status === "delivered" ? "ok" : result.status === "skipped" ? "skipped" : "failed",
    },
  });

  return result;
}

