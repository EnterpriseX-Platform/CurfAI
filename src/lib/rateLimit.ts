/**
 * Tiny in-memory sliding-window rate limiter.
 *
 * This is appropriate for single-instance deploys (one Docker container, one
 * Fly machine, one Railway replica). For horizontal scaling, swap the Map
 * for Redis-backed storage (ioredis + ZADD/ZREMRANGEBYSCORE pattern) without
 * changing the call sites. The return shape is already Redis-friendly.
 *
 * Call sites get back a uniform { ok, retryAfterMs, remaining } object and
 * decide themselves how to respond (429 + Retry-After, toast, etc.).
 */

type Hit = number; // unix ms

const buckets = new Map<string, Hit[]>();

// Longest windowMs any call site actually uses today (forgot-email: 15min).
// Keys idle longer than this can't still be "in window" for any caller, so
// they're safe to drop outright rather than just trim.
const MAX_STALE_AGE_MS = 20 * 60_000;

/**
 * Drop every bucket whose newest hit is already older than any window a
 * caller could still be inside. Exported (and returning the eviction count)
 * so the sweep is directly testable — otherwise its only trigger would be a
 * 5-minute timer, which no unit test can reasonably wait on.
 *
 * Replaces an older "GC when buckets.size > 5000" check that ran inline on
 * the request path: that trigger only fired once the map was ALREADY
 * oversized, and the O(n) scan+filter it then ran shared the same
 * event-loop turn as whichever request happened to cross the threshold — a
 * latency spike landing exactly when traffic is already high enough to have
 * grown the map that large. Sustained traffic (a soak test, or just a long
 * uptime) reaches that path because IP-scoped buckets (forgot/signup/try)
 * accumulate one-off keys from callers who never return. Sweeping on a
 * timer decouples cleanup cost from request latency and bounds memory
 * regardless of whether size ever crosses a threshold.
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

/**
 * @param key   A unique identifier — tenantId, userId, tenantId+route, or
 *              `ip:routeKey` for anonymous endpoints.
 * @param limit Max calls allowed per windowMs.
 * @param windowMs Window length in milliseconds (e.g. 60_000 for per-minute).
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
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
 * Convenience for Next route handlers: given a rate-limit result, return the
 * standard 429 response, or null if the call is allowed. Usage:
 *
 *   const limited = ensureLimit("ask", `t:${user.tenantId}`, 20, 60_000);
 *   if (limited) return limited;
 */
import { NextResponse } from "next/server";

export function ensureLimit(
  routeKey: string,
  scope: string,
  limit: number,
  windowMs: number,
): NextResponse | null {
  const { ok, retryAfterMs, remaining } = rateLimit(`${routeKey}:${scope}`, limit, windowMs);
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
