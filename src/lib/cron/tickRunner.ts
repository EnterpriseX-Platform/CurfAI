/**
 * What one cron tick does, in two halves so it can run either way:
 *
 *  - `runScheduleLoop`: the workspaces' own schedules that are due this minute (deliveries; watchers, briefs and digests in
 *    the paid edition).
 *  - `runPlatformTicks`: everything else — lake pulls, materialized views, backups, retention, lifecycle, alerts, and the
 *    paid edition's sweeps.
 *
 * POST /api/cron/tick runs both in the request, as it always did (the Community edition, and a deploy with no queue). With a
 * queue configured (lib/jobs) the worker runs them as separate jobs instead, and the route stays as a manual trigger.
 */
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { OPEN_TENANT } from "@/lib/tenantStatus";
import { cronMatches } from "@/lib/cron/cronMatches";
import { fireDelivery } from "@/lib/cron/fireDelivery";
import type { FiredItem } from "@/lib/cron/types";
import { tickLakePulls, tickMaterializedViews, tickLakeBackups, tickBackupSnapshots } from "@/lib/cron/lakeTicks";
import { tickAuditRetention, tickAiUsageThreshold, tickSecurityAlerts, tickWebhookSecrets, tickLifecycle } from "@/lib/cron/opsTicks";
import { ee } from "@/ee";
import { countFired, countSweepErrors, observeCronRun } from "@/lib/cron/observe";

/** The due schedules. Returns false when the Schedule table isn't there yet (a fresh database). */
export function runScheduleLoop(req: NextRequest, now: Date, force: boolean, fired: FiredItem[]): Promise<boolean> {
  return observeCronRun("schedule_loop", () => scheduleLoop(req, now, force, fired));
}

async function scheduleLoop(req: NextRequest, now: Date, force: boolean, fired: FiredItem[]): Promise<boolean> {
  let schedules: any[] = [];
  try {
    // A closed workspace's scheduled reports, watchers, briefs and digests
    // don't run (suspended, or waiting to be deleted — lib/tenantStatus.ts);
    // nothing is deleted, and they pick up again when it is restored.
    schedules = await prisma.schedule.findMany({ where: { enabled: true, tenant: OPEN_TENANT } });
  } catch {
    return false;
  }
  for (const sched of schedules) {
    if (!force && !cronMatches(sched.cron, now)) continue;
    fired.push(await fireSchedule(sched, req));
  }
  return true;
}

/** Fire one schedule row, recording a failure on the row. Never throws. */
export async function fireSchedule(sched: any, req: NextRequest): Promise<FiredItem> {
  const item = await fireScheduleRow(sched, req);
  countFired([item]);
  return item;
}

async function fireScheduleRow(sched: any, req: NextRequest): Promise<FiredItem> {
  try {
    if (sched.kind === "delivery" || !sched.kind) {
      const result = await fireDelivery(sched, req);
      return { id: sched.id, kind: "delivery", status: result.status, narrative: result.message };
    }
    // watcher / brief / digest live in the paid edition. In Community
    // a stray row of one of those kinds is recorded, never crashed on.
    const result = ee.cron ? await ee.cron.fireSchedule(sched, req) : null;
    if (result) return { id: sched.id, kind: sched.kind, status: result.status, narrative: result.narrative };
    return { id: sched.id, kind: sched.kind, status: "skipped", narrative: "Not available in this edition" };
  } catch (e: any) {
    await prisma.schedule.update({
      where: { id: sched.id },
      data: { lastRunAt: new Date(), lastStatus: "failed" },
    }).catch(() => null);
    return { id: sched.id, kind: sched.kind ?? "delivery", status: "failed", narrative: e?.message };
  }
}

/** Everything but the schedule loop. Community ticks first, in the order they always ran; then the paid edition's. */
export function runPlatformTicks(req: NextRequest, now: Date, force: boolean, fired: FiredItem[]): Promise<Record<string, unknown>> {
  return observeCronRun("platform_ticks", async () => {
    const before = fired.length;
    const result = await platformTicks(req, now, force, fired);
    countFired(fired.slice(before));
    countSweepErrors(result);
    return result;
  });
}

async function platformTicks(req: NextRequest, now: Date, force: boolean, fired: FiredItem[]): Promise<Record<string, unknown>> {
  await tickLakePulls(fired, now, force);
  await tickMaterializedViews(fired, now, force);
  await tickLakeBackups(fired, now, force);
  await tickBackupSnapshots(fired, now, force);
  await tickAuditRetention(fired, now, force);
  await tickWebhookSecrets(fired);
  await tickLifecycle(fired, now);
  await tickAiUsageThreshold(fired, now, force);
  await tickSecurityAlerts(fired, now, force);
  // CDC, streaming, Parquet, pipelines, activations, data quality, SLA,
  // embeddings, sync, decisions, forecast accuracy, Master Builder, Ask
  // suggestions and viewer sweeps are paid ticks — src/ee/cron/tick.ts.
  return ee.cron ? await ee.cron.tick({ req, fired, now, force }) : {};
}
