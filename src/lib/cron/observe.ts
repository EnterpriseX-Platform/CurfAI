/**
 * Records one cron run (a schedule scan, the schedule loop, the platform sweeps) as metrics and a log line, whichever process
 * runs it — the web pod for POST /api/cron/tick, the worker for the queued jobs. "Success" here means the run did not throw;
 * a sweep inside it that reports its own error is counted separately (`curf_cron_tick_errors_total`), because the sweeps
 * are isolated from each other on purpose and one failing must not look like the tick not running.
 */
import { cronFired, cronLastSuccess, cronRuns, cronRunSeconds, cronTickErrors } from "@/lib/metrics";
import { log } from "@/lib/log";
import type { FiredItem } from "@/lib/cron/types";

export type CronRun = "schedule_loop" | "schedule_scan" | "platform_ticks";

export async function observeCronRun<T>(run: CronRun, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const out = await fn();
    cronRuns.inc?.({ run, status: "ok" });
    cronLastSuccess.set?.({ run }, Math.floor(Date.now() / 1000));
    return out;
  } catch (e) {
    cronRuns.inc?.({ run, status: "error" });
    log.error("cron run failed", { run, err: e });
    throw e;
  } finally {
    cronRunSeconds.observe?.({ run }, (Date.now() - t0) / 1000);
  }
}

/** Count what a run fired. Kinds and statuses are short strings set in code (delivery, watcher, lake pull…). */
export function countFired(items: readonly FiredItem[]): void {
  for (const f of items) cronFired.inc?.({ kind: String(f.kind).slice(0, 40), status: String(f.status).slice(0, 20) });
}

/**
 * The platform tick returns one entry per sweep; a sweep that caught its own failure answers `{ error }`. Counts those per sweep
 * and logs each (the message is scrubbed by the logger).
 */
export function countSweepErrors(result: Record<string, unknown>): void {
  for (const [tick, v] of Object.entries(result)) {
    const err = v && typeof v === "object" ? (v as { error?: unknown }).error : undefined;
    if (typeof err !== "string") continue;
    cronTickErrors.inc?.({ tick: tick.slice(0, 40) });
    log.warn("tick sweep failed", { tick, error: err });
  }
}
