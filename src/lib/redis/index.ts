/**
 * Valkey / Redis connections (docs/ENTERPRISE_SAAS_GAP_ANALYSIS.md §4.5.2).
 *
 * Two roles, two instances, because their memory policies contradict each other:
 *
 *   cache  (CURF_REDIS_URL)        — rate limits, approval waits, cross-pod notices. No persistence, `allkeys-lru`. Losing it
 *                                    costs a few forgotten counters, never data.
 *   queue  (CURF_REDIS_QUEUE_URL)  — BullMQ queues and schedulers. AOF on, `noeviction`: an evicted job is a lost job. Falls
 *                                    back to CURF_REDIS_URL when unset (fine for development; production should split them).
 *
 * Unset = no shared state: every consumer keeps its in-process implementation, which is what the Community edition and a
 * single-replica deploy run. `sharedStateEnabled()` is how a consumer asks. The client library is loaded on first use, so a
 * process that never configures Redis never loads it.
 *
 * A consumer that can't reach Redis must degrade, not fail: the rate limiter falls back to its in-process counters, a wait
 * falls back to in-process delivery. `redisWarn` logs that at most once a minute per reason.
 */
import type { Redis, RedisOptions } from "ioredis";

type Role = "cache" | "queue";

export function cacheUrl(): string | undefined {
  return process.env.CURF_REDIS_URL?.trim() || undefined;
}

export function queueUrl(): string | undefined {
  return process.env.CURF_REDIS_QUEUE_URL?.trim() || cacheUrl();
}

/** True when this process shares state through Redis (the cache instance is configured). */
export function sharedStateEnabled(): boolean {
  return !!cacheUrl();
}

/** True when background jobs run on BullMQ (a queue instance is configured and jobs aren't switched off). */
export function jobsEnabled(): boolean {
  return !!queueUrl() && process.env.CURF_JOBS !== "off";
}

const shared = globalThis as unknown as { __curfRedis?: Partial<Record<Role, Promise<Redis>>> };

function options(role: Role): RedisOptions {
  return {
    // BullMQ requires null here (it blocks on commands); everything else wants a bounded wait so a dead Redis degrades
    // quickly instead of hanging the request.
    maxRetriesPerRequest: role === "queue" ? null : 1,
    enableReadyCheck: true,
    connectTimeout: 1_500,
    // A command that can't be answered quickly is a failure the caller degrades on, not a request that hangs.
    ...(role === "cache" ? { commandTimeout: 750 } : {}),
    lazyConnect: false,
    retryStrategy: (times) => Math.min(2_000, 100 * 2 ** Math.min(times, 5)),
    // Clients identify themselves, so CLIENT LIST on the server says which pod holds which connection.
    connectionName: `curf-${role}-${process.pid}`,
  };
}

/** The shared client for a role. Throws when that role isn't configured: check `sharedStateEnabled()` / `jobsEnabled()` first. */
export function redis(role: Role = "cache"): Promise<Redis> {
  const url = role === "cache" ? cacheUrl() : queueUrl();
  if (!url) return Promise.reject(new Error(`Redis (${role}) is not configured`));
  const clients = (shared.__curfRedis ??= {});
  clients[role] ??= import("ioredis").then(({ default: IORedis }) => {
    const c = new IORedis(url, options(role));
    // An unhandled 'error' event would crash the process; connection trouble is reported where it is acted on.
    c.on("error", (e) => redisWarn(`${role}-error`, `[redis:${role}] ${e.message}`));
    return c;
  });
  return clients[role]!;
}

/** A dedicated connection, for subscribing (a subscribed connection can't run other commands) or for BullMQ workers. */
export async function duplicate(role: Role = "cache", overrides: RedisOptions = {}): Promise<Redis> {
  const base = await redis(role);
  const c = base.duplicate(overrides);
  c.on("error", (e) => redisWarn(`${role}-dup-error`, `[redis:${role}] ${e.message}`));
  return c;
}

const warned = new Map<string, number>();
export function redisWarn(reason: string, message: string): void {
  const now = Date.now();
  if ((warned.get(reason) ?? 0) > now - 60_000) return;
  warned.set(reason, now);
  console.warn(message);
}

/** Round-trip check for the readiness probe: undefined when not configured, else whether PING answered in time. */
export async function pingRedis(role: Role = "cache", timeoutMs = 1_500): Promise<{ configured: boolean; ok: boolean; ms?: number; error?: string }> {
  const url = role === "cache" ? cacheUrl() : queueUrl();
  if (!url) return { configured: false, ok: true };
  const t0 = Date.now();
  try {
    const c = await redis(role);
    await Promise.race([c.ping(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))]);
    return { configured: true, ok: true, ms: Date.now() - t0 };
  } catch (e: any) {
    return { configured: true, ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** Close the shared clients (tests, graceful shutdown). */
export async function closeRedis(): Promise<void> {
  const clients = shared.__curfRedis;
  if (!clients) return;
  shared.__curfRedis = {};
  await Promise.all(Object.values(clients).map(async (p) => { try { (await p).disconnect(); } catch { /* already gone */ } }));
}
