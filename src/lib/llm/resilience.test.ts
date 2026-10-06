import { describe, it, expect, afterEach } from "vitest";
import { abortableSleep, acquireSlot, backoffMs, isFatalProviderError, isRetryable, isTransientHttpStatus, laneState, parseRetryAfter } from "./resilience";

describe("limiter", () => {
  it("lets only `max` through at once and hands slots out FIFO", async () => {
    const order: string[] = [];
    const a = await acquireSlot("k1", 2);
    const b = await acquireSlot("k1", 2);
    const c = acquireSlot("k1", 2).then((r) => { order.push("c"); return r; });
    const d = acquireSlot("k1", 2).then((r) => { order.push("d"); return r; });
    await Promise.resolve();
    expect(laneState("k1")).toEqual({ active: 2, queued: 2 });
    a();
    const rc = await c;
    expect(order).toEqual(["c"]);
    expect(laneState("k1")).toEqual({ active: 2, queued: 1 });
    b();
    const rd = await d;
    expect(order).toEqual(["c", "d"]);
    rc(); rd();
    expect(laneState("k1")).toEqual({ active: 0, queued: 0 });
  });

  it("a release is idempotent and lanes are independent", async () => {
    const a = await acquireSlot("k2", 1);
    a(); a();
    expect(laneState("k2").active).toBe(0);
    const x = await acquireSlot("k3", 1);
    const y = await acquireSlot("k4", 1); // different endpoint: not blocked
    x(); y();
  });

  it("an aborted waiter leaves the queue and does not eat a slot", async () => {
    const a = await acquireSlot("k5", 1);
    const ac = new AbortController();
    const waiting = acquireSlot("k5", 1, ac.signal);
    ac.abort();
    await expect(waiting).rejects.toThrow("Cancelled");
    expect(laneState("k5").queued).toBe(0);
    a();
    expect(laneState("k5").active).toBe(0);
  });

  it("max <= 0 turns the limiter off", async () => {
    const rs = await Promise.all([acquireSlot("k6", 0), acquireSlot("k6", 0), acquireSlot("k6", 0)]);
    expect(laneState("k6").active).toBe(0);
    rs.forEach((r) => r());
  });
});

describe("retry policy", () => {
  afterEach(() => { delete process.env.CURF_LLM_RETRIES; });

  it("only a driver-flagged failure is retryable", () => {
    expect(isRetryable({ status: "failed", retryable: true })).toBe(true);
    expect(isRetryable({ status: "failed" })).toBe(false);
    expect(isRetryable({ status: "ok", retryable: true })).toBe(false);
  });

  it("which HTTP statuses are transient", () => {
    for (const s of [408, 429, 500, 502, 503, 504]) expect(isTransientHttpStatus(s)).toBe(true);
    for (const s of [400, 401, 402, 403, 404, 422]) expect(isTransientHttpStatus(s)).toBe(false);
  });

  it("parses Retry-After seconds and dates, ignores junk", () => {
    expect(parseRetryAfter("7")).toBe(7000);
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:10 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(10_000);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("backs off exponentially, honours Retry-After, caps both", () => {
    const mid = () => 0.5; // jitter factor 1.0
    expect(backoffMs(1, undefined, mid)).toBe(2000);
    expect(backoffMs(2, undefined, mid)).toBe(4000);
    expect(backoffMs(3, undefined, mid)).toBe(8000);
    expect(backoffMs(10, undefined, mid)).toBe(30_000);
    expect(backoffMs(1, 12_000, mid)).toBe(12_000);
    expect(backoffMs(1, 10 * 60_000, mid)).toBe(60_000);
  });

  it("sleep resolves false when aborted", async () => {
    const ac = new AbortController();
    const p = abortableSleep(10_000, ac.signal);
    ac.abort();
    expect(await p).toBe(false);
    expect(await abortableSleep(1)).toBe(true);
  });
});

describe("fatal provider errors", () => {
  it("recognises an account that is out of credit however it is worded", () => {
    expect(isFatalProviderError('HTTP 429: {"error":{"message":"Your account is suspended due to insufficient balance","type":"exceeded_current_quota_error"}}')).toBe(true);
    expect(isFatalProviderError("You exceeded your current quota, please check your plan")).toBe(true);
    expect(isFatalProviderError("AI_CREDITS_EXHAUSTED: used up")).toBe(true);
    expect(isFatalProviderError("The AI provider's account has run out of credit")).toBe(true);
  });
  it("does not mistake throttling or a timeout for it", () => {
    expect(isFatalProviderError("HTTP 429: Too many requests, slow down")).toBe(false);
    expect(isFatalProviderError("Request timed out after 90s")).toBe(false);
    expect(isFatalProviderError(undefined)).toBe(false);
  });
});
