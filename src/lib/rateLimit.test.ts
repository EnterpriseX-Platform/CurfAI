/**
 * Rate limiter — window enforcement + the stale-bucket sweep.
 *
 * The sweep half exists because of a real memory-growth risk this module
 * carries: buckets are keyed per caller, and the IP-scoped call sites
 * (forgot / reset / try / signup) mint a key for every distinct IP that
 * ever hits them. Nothing removes those keys when that caller never comes
 * back, so on a long-running single instance the Map only grows. That's
 * invisible in short test runs and only shows up under sustained traffic
 * over hours — exactly the class of bug a soak test is meant to surface,
 * so it's pinned here instead of relying on one being run.
 */
import { describe, it, expect } from "vitest";
import { rateLimit, ensureLimit, sweepStaleBuckets } from "./rateLimit";

describe("rateLimit — sliding window", () => {
  it("allows exactly `limit` calls, then blocks", () => {
    const key = `win-${Math.random()}`;
    const results = Array.from({ length: 12 }, () => rateLimit(key, 10, 60_000));
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(results.filter((r) => !r.ok)).toHaveLength(2);
  });

  it("reports a positive retryAfterMs once blocked", () => {
    const key = `retry-${Math.random()}`;
    for (let i = 0; i < 3; i++) rateLimit(key, 3, 60_000);
    const blocked = rateLimit(key, 3, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("does not record rejected hits (a blocked caller isn't starved forever)", () => {
    const key = `starve-${Math.random()}`;
    for (let i = 0; i < 2; i++) rateLimit(key, 2, 60_000);
    // Hammer while blocked — none of these should extend the window.
    const first = rateLimit(key, 2, 60_000).retryAfterMs;
    for (let i = 0; i < 50; i++) rateLimit(key, 2, 60_000);
    const afterHammering = rateLimit(key, 2, 60_000).retryAfterMs;
    expect(afterHammering).toBeLessThanOrEqual(first);
  });

  it("scopes independently per key", () => {
    const a = `scope-a-${Math.random()}`;
    const b = `scope-b-${Math.random()}`;
    for (let i = 0; i < 5; i++) rateLimit(a, 5, 60_000);
    expect(rateLimit(a, 5, 60_000).ok).toBe(false);
    expect(rateLimit(b, 5, 60_000).ok).toBe(true);
  });
});

describe("ensureLimit — HTTP shape", () => {
  it("returns null while under the limit", () => {
    expect(ensureLimit("route", `s-${Math.random()}`, 5, 60_000)).toBeNull();
  });

  it("returns a 429 with Retry-After once over", () => {
    const scope = `over-${Math.random()}`;
    for (let i = 0; i < 3; i++) ensureLimit("route", scope, 3, 60_000);
    const res = ensureLimit("route", scope, 3, 60_000);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
    expect(Number(res!.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(res!.headers.get("X-RateLimit-Remaining")).toBe("0");
  });
});

describe("sweepStaleBuckets — bounds memory on long uptimes", () => {
  it("evicts buckets whose newest hit is older than any live window", () => {
    const key = `stale-${Math.random()}`;
    rateLimit(key, 5, 60_000);
    // Sweep from a point far enough in the future that this key is unreachable
    // by every window in use (longest today is forgot-email's 15min).
    const evicted = sweepStaleBuckets(Date.now() + 60 * 60_000);
    expect(evicted).toBeGreaterThanOrEqual(1);
    // Evicting a stale bucket must reset the caller, not permanently block it.
    expect(rateLimit(key, 5, 60_000).ok).toBe(true);
  });

  it("leaves buckets that are still inside a live window untouched", () => {
    const key = `fresh-${Math.random()}`;
    for (let i = 0; i < 5; i++) rateLimit(key, 5, 60_000);
    sweepStaleBuckets(Date.now());
    // Still at the limit — the sweep must not have handed back a fresh budget.
    expect(rateLimit(key, 5, 60_000).ok).toBe(false);
  });

  it("is safe to run against an unbounded number of one-shot keys", () => {
    // Mimics the IP-scoped call sites: many callers, one hit each, never seen
    // again. Before the timer-based sweep these accumulated until the map
    // crossed a size threshold that only ever tripped under heavy load.
    for (let i = 0; i < 2000; i++) rateLimit(`oneshot-${i}-${Math.random()}`, 10, 60_000);
    expect(sweepStaleBuckets(Date.now() + 60 * 60_000)).toBeGreaterThanOrEqual(2000);
  });
});
