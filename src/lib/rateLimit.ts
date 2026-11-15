/**
 * Sliding-window rate limiter, shared across replicas when Redis is configured.
 *
 * With CURF_REDIS_URL set (lib/redis), the window lives in Redis: one sorted set per key, counted and trimmed by a single
 * Lua script so concurrent pods can't both take the last slot. Without it — the Community edition, a single replica, local
 * development — the same limits are enforced by an in-process sliding window, exactly as before. If Redis is configured
 * but unreachable the in-process window answers instead (a limiter that fails open is an open door for password guessing),
 * so the worst case is the old per-pod behaviour, never no limit at all.
 *
 * Call sites get a uniform { ok, retryAfterMs, remaining } and decide how to respond (429 + Retry-After, toast, etc.).
 * The function is async because the shared store is.
 */
import { NextResponse } from "next/server";
import { redis, redisWarn, sharedStateEnabled } from "@/lib/redis";

type Hit = number; // unix ms

const buckets = new Map<string, Hit[]>();

// Longest windowMs any call site actually uses today (forgot-email: 15min).
// Keys idle longer than this can't still be "in window" for any caller, so
// they're safe to drop outright rather than just trim.
const MAX_STALE_AGE_MS = 20 * 60_000;

/**
 * Drop every in-process bucket whose newest hit is already older than any window a caller could still be inside. Exported
 * (and returning the eviction count) so the sweep is directly testable. Swept on a timer, not on the request path: an inline
 * "GC when the map is big" check ran its O(n) scan in the same event-loop turn as whichever request crossed the threshold,
 * a latency spike exactly when traffic was already high.
 */
export function sweepStaleBuckets(now: number = Date.now()): number {
  const cutoff = now - MAX_STALE_AGE_MS;
  let evicted = 0;
  for (const [key, hits] of buckets) {
    if (hits.length === 0 || hits[hits.length - 1] <= cutoff) {
      buckets.delete(key);
      evicted++;
    }
  }
  return evicted;
}

if (typeof setInterval !== "undefined") {
  const gc = setInterval(() => sweepStaleBuckets(), 5 * 60_000);
  // Never keep the process alive just for this — matters for scripts/tests
  // that import this module and expect to exit on their own.
  gc.unref?.();
}

export type RateLimitResult = {
  ok: boolean;
  /** Milliseconds until the oldest in-window hit falls off (0 when ok). */
  retryAfterMs: number;
  /** Requests remaining in the current window after this call. Clamped to 0. */
  remaining: number;
};

/** The in-process window: the whole limiter without Redis, and the fallback with it. */
function localLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const cutoff = now - windowMs;
  const list = (buckets.get(key) ?? []).filter((t) => t > cutoff);
  if (list.length >= limit) {
    const oldestInWindow = list[0];
    const retryAfterMs = Math.max(0, oldestInWindow + windowMs - now);
    // Don't record this rejected hit — that would starve the caller forever.
    buckets.set(key, list);
    return { ok: false, retryAfterMs, remaining: 0 };
  }
  list.push(now);
  buckets.set(key, list);
  return { ok: true, retryAfterMs: 0, remaining: Math.max(0, limit - list.length) };
}

/**
 * KEYS[1] the window's sorted set; ARGV: limit, windowMs, a unique member suffix.
 * Time comes from the server so pods with skewed clocks share one timeline. A refused hit is not recorded (same rule as
 * the in-process window). Returns {allowed, retryAfterMs, remaining}.
 */
const SLIDING_WINDOW_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
if count >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local retry = 0
  if oldest[2] then retry = math.max(0, tonumber(oldest[2]) + window - now) end
  return {0, retry, 0}
end
redis.call('ZADD', KEYS[1], now, now .. ':' .. ARGV[3])
redis.call('PEXPIRE', KEYS[1], window + 1000)
return {1, 0, limit - count - 1}
`;

let member = 0;

async function sharedLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const r = await redis("cache");
  const res = (await r.eval(SLIDING_WINDOW_LUA, 1, `rl:${key}`, String(limit), String(windowMs), `${process.pid}-${++member}`)) as number[];
  return { ok: res[0] === 1, retryAfterMs: Number(res[1]), remaining: Math.max(0, Number(res[2])) };
}

/**
 * @param key   A unique identifier — tenantId, userId, tenantId+route, or
 *              `ip:routeKey` for anonymous endpoints.
 * @param limit Max calls allowed per windowMs.
 * @param windowMs Window length in milliseconds (e.g. 60_000 for per-minute).
 */
export async function rateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  if (!sharedStateEnabled() || Date.now() < redisDownUntil) return localLimit(key, limit, windowMs);
  try {
    return await sharedLimit(key, limit, windowMs);
  } catch (e: any) {
    // Don't make every request pay a timeout while Redis is down: stay on the in-process window for a few seconds, then try again.
    redisDownUntil = Date.now() + REDIS_RETRY_AFTER_MS;
    redisWarn("ratelimit", `[ratelimit] Redis unavailable, limiting per process: ${e?.message ?? e}`);
    return localLimit(key, limit, windowMs);
  }
}

const REDIS_RETRY_AFTER_MS = 5_000;
let redisDownUntil = 0;

/** Forget that Redis was down (tests, and a reconnect the caller knows about). */
export function resetRedisBackoff(): void { redisDownUntil = 0; }

/**
 * Convenience for Next route handlers: given a rate-limit result, return the
 * standard 429 response, or null if the call is allowed. Usage:
 *
 *   const limited = await ensureLimit("ask", `t:${user.tenantId}`, 20, 60_000);
 *   if (limited) return limited;
 */
export async function ensureLimit(
  routeKey: string,
  scope: string,
  limit: number,
  windowMs: number,
): Promise<NextResponse | null> {
  const { ok, retryAfterMs, remaining } = await rateLimit(`${routeKey}:${scope}`, limit, windowMs);
  if (ok) return null;
  const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return NextResponse.json(
    {
      error: "Rate limit exceeded",
      route: routeKey,
      limit,
      windowMs,
      retryAfterMs,
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSec),
        "X-RateLimit-Remaining": String(remaining),
      },
    }
  );
}
