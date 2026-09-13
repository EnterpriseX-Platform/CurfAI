import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { cronMatches } from "@/lib/cron/cronMatches";
import { dispatchDelivery, parseDeliveryConfig, type Rendered } from "@/lib/delivery/dispatch";
import { renderPdf } from "@/lib/reporting/renderers/pdf";
import { renderXlsx } from "@/lib/reporting/renderers/xlsx";
import { renderDocx } from "@/lib/reporting/renderers/docx";
import { renderCsv } from "@/lib/reporting/renderers/csv";
import { ensureLimit } from "@/lib/rateLimit";
import { ReportSchema } from "@/lib/reporting/schema";
import { runReport } from "@/lib/reporting/runner";
import { safeParseJson } from "@/lib/cron/types";
import type { FiredItem } from "@/lib/cron/types";
import { tickLakePulls, tickMaterializedViews, tickLakeBackups, tickHourlySnapshots } from "@/lib/cron/lakeTicks";
import { tickAuditRetention, tickAiUsageThreshold, tickSecurityAlerts } from "@/lib/cron/opsTicks";
import { ee } from "@/ee";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest)  { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }

/** Constant-time secret compare (SHA-256 equalises length so timingSafeEqual
 *  never throws on a mismatched-length guess and leaks no length via timing). */
function secretMatches(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

async function handle(req: NextRequest) {
  const url = new URL(req.url);
  // Header only — a `?secret=` query param would leak into access/proxy logs
  // and Referer headers.
  const secret = req.headers.get("x-cron-secret") ?? "";
  const expected = process.env.CRON_SECRET ?? "";
  if (!secretMatches(secret, expected)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const limited = ensureLimit("cron", "global", 4, 60_000);
  if (limited) return limited;
  const force = url.searchParams.get("force") === "1";
  const now = new Date();

  let schedules: any[] = [];
  try {
    schedules = await prisma.schedule.findMany({ where: { enabled: true } });
  } catch {
    return NextResponse.json({ ok: true, fired: 0, note: "Schedule table not initialised" });
  }

  const fired: Array<{ id: string; kind: string; status: string; narrative?: string }> = [];
  for (const sched of schedules) {
    if (!force && !cronMatches(sched.cron, now)) continue;
    try {
      if (sched.kind === "delivery" || !sched.kind) {
        const result = await fireDelivery(sched, req);
        fired.push({ id: sched.id, kind: "delivery", status: result.status, narrative: result.message });
      } else {
        // watcher / brief / digest live in the paid edition. In Community
        // a stray row of one of those kinds is recorded, never crashed on.
        const result = ee.cron ? await ee.cron.fireSchedule(sched, req) : null;
        if (result) fired.push({ id: sched.id, kind: sched.kind, status: result.status, narrative: result.narrative });
        else fired.push({ id: sched.id, kind: sched.kind, status: "skipped", narrative: "Not available in this edition" });
      }
    } catch (e: any) {
      fired.push({ id: sched.id, kind: sched.kind ?? "delivery", status: "failed", narrative: e?.message });
      await prisma.schedule.update({
        where: { id: sched.id },
        data: { lastRunAt: new Date(), lastStatus: "failed" },
      }).catch(() => null);
    }
  }
  // Community ticks first, in the order they always ran; then the paid
  // edition's, through the registry. Same fired-array mutation, same
  // per-block error isolation.
  await tickLakePulls(fired, now, force);
  await tickMaterializedViews(fired, now, force);
  await tickLakeBackups(fired, now, force);
  await tickHourlySnapshots(fired, now, force);
  await tickAuditRetention(fired, now, force);
  await tickAiUsageThreshold(fired, now, force);
  await tickSecurityAlerts(fired, now, force);
  // CDC, streaming, Parquet, pipelines, activations, data quality, SLA,
  // embeddings, sync, decisions, forecast accuracy, Master Builder, Ask
  // suggestions and viewer sweeps are paid ticks — src/ee/cron/tick.ts.
  const extra = ee.cron ? await ee.cron.tick({ req, fired, now, force }) : {};

  return NextResponse.json({ ok: true, fired: fired.length, items: fired, ...extra });
}

async function fireDelivery(sched: any, req: NextRequest) {
  const reportRow = await prisma.report.findUnique({ where: { id: sched.reportId } });
  if (!reportRow) throw new Error("Report missing");
  const report = ReportSchema.parse(JSON.parse(reportRow.definition));
  const runParams: Record<string, unknown> = safeParseJson<Record<string, unknown>>(sched.params) ?? {};

  let body: Buffer;
  let contentType: string;
  let ext: string;
  switch (sched.format) {
    case "xlsx":
      body = await renderXlsx(report, runParams, { reportId: sched.reportId });
      contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      ext = "xlsx";
      break;
    case "docx":
      body = await renderDocx(report, runParams);
      contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      ext = "docx";
      break;
    case "csv": {
      const csv = await renderCsv(report, runParams);
      body = Buffer.from(csv);
      contentType = "text/csv; charset=utf-8";
      ext = "csv";
      break;
    }
    case "pdf":
    default:
      await runReport({ report, params: runParams });
      body = await renderPdf({
        reportId: sched.reportId,
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
    origin: new URL(req.url).origin,
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

