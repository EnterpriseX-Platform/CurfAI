/**
 * The few metrics that are state, not events: what the database server, the job queue and the SCIM retry table say right now.
 * Read just before a scrape of the web pod (cached for 10 s, so two scrapers or a refresh storm cost one round of queries).
 * Every number is a count or a state name: no workspace, no person. A source that cannot be reached is reported as down
 * (`curf_db_up 0`, `curf_job_queue_up 0`), never as an error from the scrape itself, so the metrics endpoint still answers while
 * the thing it reports on is broken — that is when somebody is looking at it.
 */
import { prisma } from "@/lib/db";
import { ee } from "@/ee";
import { jobsEnabled } from "@/lib/redis";
import { defineGauge } from "@/lib/metrics";

// Defined here, not in lib/metrics.ts: only the web pod reads these, and a label-less gauge is exported as 0 from the moment it
// exists, so a worker that defined them would report "database down" it never checked.
const dbUp = defineGauge("curf_db_up", "1 when the database answered the scrape's probe, 0 when it did not", []);
const dbConnections = defineGauge("curf_db_connections", "Backend connections on the database server by state (all databases, all roles)", ["state"]);
const dbConnectionsMax = defineGauge("curf_db_connections_max", "The server's max_connections", []);
// SCIM retries are a paid table (ee.identity): an edition without it defines neither gauge, rather than reporting a 0 it never read.
const scimRetryCounts = ee.identity?.scimRetryCounts;
const scimRetryRows = scimRetryCounts && defineGauge("curf_scim_retry_rows", "SCIM Keycloak steps waiting to be retried", []);
const scimRetryOverdueRows = scimRetryCounts && defineGauge("curf_scim_retry_overdue_rows", "Of those, how many were due more than 15 minutes ago (the sweep is not draining them)", []);
const jobQueueJobs = defineGauge("curf_job_queue_jobs", "Jobs in each queue by state (waiting, active, delayed, failed). Absent when no queue is configured", ["queue", "state"]);
const jobQueueUp = defineGauge("curf_job_queue_up", "1 when the queue's Redis answered the scrape, 0 when it did not. Absent when no queue is configured", ["queue"]);

const CACHE_MS = 10_000;
const STEP_TIMEOUT_MS = 3_000;

let last = 0;
let inflight: Promise<void> | null = null;

function within<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), STEP_TIMEOUT_MS).unref())]);
}

async function database(): Promise<void> {
  try {
    await within(prisma.$queryRaw`SELECT 1`);
    dbUp.set?.({}, 1);
  } catch {
    dbUp.set?.({}, 0);
    return;
  }
  try {
    // pg_stat_database.numbackends counts the connected client backends of every database on the server (Keycloak's shares it) and,
    // unlike pg_stat_activity, is readable by a non-superuser in full. pg_stat_activity then only names the state of the
    // sessions this role may see; what it cannot see is "other".
    const total = await within(prisma.$queryRaw<Array<{ n: number }>>`SELECT coalesce(sum(numbackends), 0)::int AS n FROM pg_stat_database`);
    const seen = await within(prisma.$queryRaw<Array<{ state: string; n: number }>>`
      SELECT state, count(*)::int AS n FROM pg_stat_activity WHERE state IS NOT NULL AND backend_type = 'client backend' GROUP BY state`);
    let named = 0;
    const byState = new Map<string, number>();
    for (const r of seen) {
      const key = r.state === "active" ? "active" : r.state === "idle" ? "idle" : r.state.startsWith("idle in transaction") ? "idle_in_transaction" : "other";
      byState.set(key, (byState.get(key) ?? 0) + Number(r.n));
      named += Number(r.n);
    }
    byState.set("other", (byState.get("other") ?? 0) + Math.max(Number(total[0]?.n ?? 0) - named, 0));
    for (const state of ["active", "idle", "idle_in_transaction", "other"]) dbConnections.set?.({ state }, byState.get(state) ?? 0);
    const max = await within(prisma.$queryRaw<Array<{ max: number }>>`SELECT current_setting('max_connections')::int AS max`);
    if (max[0]) dbConnectionsMax.set?.({}, Number(max[0].max));
  } catch { /* the connection count is a nicety next to db_up */ }
}

async function scim(): Promise<void> {
  if (!scimRetryCounts) return;
  try {
    const { all, overdue } = await within(scimRetryCounts(new Date(Date.now() - 15 * 60_000)));
    scimRetryRows?.set?.({}, all);
    scimRetryOverdueRows?.set?.({}, overdue);
  } catch { /* table missing on a fresh database, or the database is down (db_up says so) */ }
}

async function queues(): Promise<void> {
  // The queues are Cloud only (ee.jobs); without them, or with no queue configured, the job gauges stay absent.
  const queueCounts = ee.jobs?.queueCounts;
  if (!queueCounts || !jobsEnabled()) return;
  try {
    const all = await within(queueCounts());
    for (const { queue, counts } of all) {
      for (const state of ["waiting", "active", "delayed", "failed"] as const) jobQueueJobs.set?.({ queue, state }, counts[state]);
    }
    for (const { queue } of all) jobQueueUp.set?.({ queue }, 1);
  } catch {
    // Which queue failed is not known (one Redis serves both), so all are reported down.
    jobQueueUp.set?.({ queue: "schedules" }, 0);
    jobQueueUp.set?.({ queue: "maintenance" }, 0);
  }
}

/** Bring the state gauges up to date (at most once per 10 s). Never throws. */
export function refreshScrapeState(): Promise<void> {
  if (Date.now() - last < CACHE_MS) return Promise.resolve();
  inflight ??= Promise.all([database(), scim(), queues()])
    .then(() => { last = Date.now(); })
    .catch(() => {})
    .finally(() => { inflight = null; });
  return inflight;
}
