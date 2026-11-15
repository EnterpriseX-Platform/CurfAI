/**
 * Rate limiter — window enforcement, the stale-bucket sweep, and the Redis-backed window.
 *
 * The sweep half exists because of a real memory-growth risk this module carries: buckets are keyed per caller, and the
 * IP-scoped call sites (forgot / reset / try / signup) mint a key for every distinct IP that ever hits them. Nothing removes
 * those keys when that caller never comes back, so on a long-running single instance the Map only grows. That's invisible
 * in short test runs and only shows up under sustained traffic over hours — pinned here instead of relying on a soak test.
 *
 * The Redis suite runs only when CURF_TEST_REDIS_URL points at a Valkey/Redis (the Migration Safety Gate–style
 * integration tests do the same for Postgres): it proves two "pods" (two independent clients) share one window.
 */
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { rateLimit, ensureLimit, sweepStaleBuckets, resetRedisBackoff } from "./rateLimit";

describe("rateLimit — sliding window", () => {
  it("allows exactly `limit` calls, then blocks", async () => {
    const key = `win-${Math.random()}`;
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await rateLimit(key, 10, 60_000));
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(results.filter((r) => !r.ok)).toHaveLength(2);
  });

  it("reports a positive retryAfterMs once blocked", async () => {
    const key = `retry-${Math.random()}`;
    for (let i = 0; i < 3; i++) await rateLimit(key, 3, 60_000);
    const blocked = await rateLimit(key, 3, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("does not record rejected hits (a blocked caller isn't starved forever)", async () => {
    const key = `starve-${Math.random()}`;
    for (let i = 0; i < 2; i++) await rateLimit(key, 2, 60_000);
    // Hammer while blocked — none of these should extend the window.
    const first = (await rateLimit(key, 2, 60_000)).retryAfterMs;
    for (let i = 0; i < 50; i++) await rateLimit(key, 2, 60_000);
    const afterHammering = (await rateLimit(key, 2, 60_000)).retryAfterMs;
    expect(afterHammering).toBeLessThanOrEqual(first);
  });

  it("scopes independently per key", async () => {
    const a = `scope-a-${Math.random()}`;
    const b = `scope-b-${Math.random()}`;
    for (let i = 0; i < 5; i++) await rateLimit(a, 5, 60_000);
    expect((await rateLimit(a, 5, 60_000)).ok).toBe(false);
    expect((await rateLimit(b, 5, 60_000)).ok).toBe(true);
  });
});

describe("ensureLimit — HTTP shape", () => {
  it("returns null while under the limit", async () => {
    expect(await ensureLimit("route", `s-${Math.random()}`, 5, 60_000)).toBeNull();
  });

  it("returns a 429 with Retry-After once over", async () => {
    const scope = `over-${Math.random()}`;
    for (let i = 0; i < 3; i++) await ensureLimit("route", scope, 3, 60_000);
    const res = await ensureLimit("route", scope, 3, 60_000);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
    expect(Number(res!.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(res!.headers.get("X-RateLimit-Remaining")).toBe("0");
  });
});

describe("sweepStaleBuckets — bounds memory on long uptimes", () => {
  it("evicts buckets whose newest hit is older than any live window", async () => {
    const key = `stale-${Math.random()}`;
    await rateLimit(key, 5, 60_000);
    // Sweep from a point far enough in the future that this key is unreachable
    // by every window in use (longest today is forgot-email's 15min).
    const evicted = sweepStaleBuckets(Date.now() + 60 * 60_000);
    expect(evicted).toBeGreaterThanOrEqual(1);
    // Evicting a stale bucket must reset the caller, not permanently block it.
    expect((await rateLimit(key, 5, 60_000)).ok).toBe(true);
  });

  it("leaves buckets that are still inside a live window untouched", async () => {
    const key = `fresh-${Math.random()}`;
    for (let i = 0; i < 5; i++) await rateLimit(key, 5, 60_000);
    sweepStaleBuckets(Date.now());
    // Still at the limit — the sweep must not have handed back a fresh budget.
    expect((await rateLimit(key, 5, 60_000)).ok).toBe(false);
  });

  it("is safe to run against an unbounded number of one-shot keys", async () => {
    // Mimics the IP-scoped call sites: many callers, one hit each, never seen
    // again. Before the timer-based sweep these accumulated until the map
    // crossed a size threshold that only ever tripped under heavy load.
    for (let i = 0; i < 2000; i++) await rateLimit(`oneshot-${i}-${Math.random()}`, 10, 60_000);
    expect(sweepStaleBuckets(Date.now() + 60 * 60_000)).toBeGreaterThanOrEqual(2000);
  });
});

const REDIS_URL = process.env.CURF_TEST_REDIS_URL;

describe.skipIf(!REDIS_URL)("rateLimit — shared through Redis", () => {
  let other: import("ioredis").Redis;

  beforeAll(async () => {
    process.env.CURF_REDIS_URL = REDIS_URL;
    const { default: IORedis } = await import("ioredis");
    other = new IORedis(REDIS_URL!);
  });
  afterAll(async () => {
    delete process.env.CURF_REDIS_URL;
    other?.disconnect();
    const { closeRedis } = await import("./redis");
    await closeRedis();
  });

  it("counts hits from every caller against one window (two pods can't both take the last slot)", async () => {
    const key = `shared-${Math.random()}`;
    // Fire 20 concurrent calls at a limit of 5: exactly 5 get through, however they interleave.
    const results = await Promise.all(Array.from({ length: 20 }, () => rateLimit(key, 5, 60_000)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    // The window is in Redis, where a second process (a second client here) sees the same count.
    expect(await other.zcard(`rl:${key}`)).toBe(5);
    const blocked = await rateLimit(key, 5, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("lets the window slide: a slot frees when the oldest hit ages out", async () => {
    const key = `slide-${Math.random()}`;
    expect((await rateLimit(key, 2, 300)).ok).toBe(true);
    expect((await rateLimit(key, 2, 300)).ok).toBe(true);
    expect((await rateLimit(key, 2, 300)).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 400));
    expect((await rateLimit(key, 2, 300)).ok).toBe(true);
  });

  it("expires its keys, so idle callers don't accumulate in Redis", async () => {
    const key = `ttl-${Math.random()}`;
    await rateLimit(key, 5, 1_000);
    const ttl = await other.pttl(`rl:${key}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2_000);
  });

  it("falls back to the in-process window when Redis can't be reached, never to no limit", async () => {
    const { closeRedis } = await import("./redis");
    await closeRedis();
    process.env.CURF_REDIS_URL = "redis://127.0.0.1:1"; // nothing listens here
    try {
      const key = `down-${Math.random()}`;
      const t0 = Date.now();
      const results = [];
      for (let i = 0; i < 6; i++) results.push(await rateLimit(key, 3, 60_000));
      expect(results.filter((r) => r.ok)).toHaveLength(3);
      // Only the first call pays for the failed attempt; the rest go straight to the in-process window.
      expect(Date.now() - t0).toBeLessThan(5_000);
    } finally {
      await closeRedis();
      resetRedisBackoff();
      process.env.CURF_REDIS_URL = REDIS_URL;
    }
  }, 20_000);
});
