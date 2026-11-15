/**
 * Transport resilience for the HTTP-hosted LLM providers (OpenAI and the
 * OpenAI-compatible family — Moonshot/Kimi, DeepSeek, …): a small
 * concurrency limiter per provider endpoint, and a bounded retry with
 * backoff for the failures that are the provider's or the network's, not
 * the prompt's.
 *
 * Why here and not at each call site: every Curf feature goes through
 * callLLM(), and the symptoms (a Master Builder stage that "timed out",
 * a report that came back Simplified) were the same transient provider
 * failure surfacing in a dozen places, each of which either gave up on
 * the first one or hand-rolled its own single retry. Fixing it once in
 * the shared function (CLAUDE.md: fix where it lives) covers them all,
 * including the ones written later.
 *
 * Pure of server imports so it is unit-testable with a fake clock/driver.
 */
import type { LlmResponse } from "./types";

// ── Concurrency limiter ──────────────────────────────────────────────

type Waiter = { resolve: (release: () => void) => void; reject: (e: unknown) => void; signal?: AbortSignal; onAbort?: () => void; timer?: ReturnType<typeof setTimeout> };
type Lane = { active: number; queue: Waiter[] };
const lanes = new Map<string, Lane>();

/** Calls allowed in flight to one endpoint. 0 or less turns the limiter off. */
export function llmConcurrency(): number {
  const raw = Number(process.env.CURF_LLM_CONCURRENCY);
  return Number.isFinite(raw) && process.env.CURF_LLM_CONCURRENCY !== undefined && process.env.CURF_LLM_CONCURRENCY !== ""
    ? Math.floor(raw)
    : 3;
}

/** The lane (one per provider endpoint) a call to `driverId` at `baseUrl` waits in. */
export function laneKey(driverId: string, baseUrl: string | null | undefined): string {
  return `${driverId}|${baseUrl ?? ""}`;
}

/**
 * How long a call may queue for a slot on a shared trial host: past `maxQueue` waiters, or `maxWaitMs` of waiting, it
 * is refused with an LlmBusyError instead of waiting behind other workspaces' long jobs. Null/absent = no limit.
 */
export type LaneLimit = { maxQueue?: number | null; maxWaitMs?: number | null };

/** A call refused because its model's host is too busy (the marker is what routes and run logs recognise). */
export const TRIAL_MODEL_BUSY = "TRIAL_MODEL_BUSY";
export class LlmBusyError extends Error {
  constructor() { super(`${TRIAL_MODEL_BUSY}: the model's host is busy right now.`); this.name = "LlmBusyError"; }
}

/**
 * Whether a new long job (a build, a deep research) should start on this lane now. A long job holds a slot for
 * minutes to hours, so it is refused while the queue behind the slots is already a third of the cap: the cap itself
 * is kept for short calls, which would otherwise wait behind it.
 */
export function laneAdmitsLongJob(key: string, max: number, limit: LaneLimit): boolean {
  if (max <= 0 || limit.maxQueue == null) return true;
  const { active, queued } = laneState(key);
  return !(active >= max && queued >= Math.max(1, Math.ceil(limit.maxQueue / 3)));
}

/**
 * Wait for a free slot on `key` (an endpoint: provider + base URL) and
 * return the function that gives it back. FIFO, so a long Master Builder
 * build cannot starve a short caption forever behind later arrivals.
 * A caller's abort signal leaves the queue immediately.
 */
export function acquireSlot(key: string, max: number, signal?: AbortSignal, limit?: LaneLimit): Promise<() => void> {
  if (max <= 0) return Promise.resolve(() => {});
  let lane = lanes.get(key);
  if (!lane) { lane = { active: 0, queue: [] }; lanes.set(key, lane); }
  const l = lane;
  const release = () => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      l.active -= 1;
      pump(l, max);
    };
  };
  if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
  if (l.active < max && l.queue.length === 0) {
    l.active += 1;
    return Promise.resolve(release());
  }
  if (limit?.maxQueue != null && l.queue.length >= limit.maxQueue) return Promise.reject(new LlmBusyError());
  return new Promise<() => void>((resolve, reject) => {
    const w: Waiter = {
      resolve: () => resolve(release()),
      reject,
      signal,
    };
    const leave = () => {
      const i = l.queue.indexOf(w);
      if (i >= 0) l.queue.splice(i, 1);
    };
    if (signal) {
      w.onAbort = () => {
        if (w.timer) clearTimeout(w.timer);
        leave();
        reject(new Error("Cancelled"));
      };
      signal.addEventListener("abort", w.onAbort, { once: true });
    }
    if (limit?.maxWaitMs != null && limit.maxWaitMs > 0) {
      w.timer = setTimeout(() => {
        if (l.queue.indexOf(w) < 0) return; // already served
        leave();
        if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
        reject(new LlmBusyError());
      }, limit.maxWaitMs);
    }
    l.queue.push(w);
  });
}

function pump(l: Lane, max: number): void {
  while (l.active < max && l.queue.length > 0) {
    const w = l.queue.shift()!;
    if (w.timer) clearTimeout(w.timer);
    if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
    l.active += 1;
    w.resolve(() => {});
  }
}

/** Test/diagnostic view of one endpoint's lane. */
export function laneState(key: string): { active: number; queued: number } {
  const l = lanes.get(key);
  return { active: l?.active ?? 0, queued: l?.queue.length ?? 0 };
}

// ── Retry policy ─────────────────────────────────────────────────────

/** Extra attempts after the first, for a retryable failure. */
export function llmMaxRetries(): number {
  const raw = process.env.CURF_LLM_RETRIES;
  if (raw === undefined || raw === "") return 2;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 5) : 2;
}

/**
 * What kind of failure a failed response was, as far as a retry is
 * concerned. The drivers set `retryable` from the HTTP status / error
 * class they actually saw; this just reads it, so a provider whose driver
 * sets nothing (Anthropic, Gemini) is never retried here — unchanged.
 */
export function isRetryable(resp: Pick<LlmResponse, "status" | "retryable">): boolean {
  return resp.status === "failed" && resp.retryable === true;
}

/** Parse a Retry-After header value (seconds or an HTTP date) into ms; undefined when absent or unusable. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * Delay before retry number `retry` (1-based): exponential from 2s with
 * jitter, capped at 30s, never shorter than the provider's own Retry-After
 * (itself capped at 60s so a hostile or buggy header can't park a request).
 */
export function backoffMs(retry: number, retryAfterMs?: number, random: () => number = Math.random): number {
  const base = Math.min(2000 * 2 ** (retry - 1), 30_000);
  const jittered = base * (0.75 + random() * 0.5);
  return Math.round(Math.max(jittered, Math.min(retryAfterMs ?? 0, 60_000)));
}

/** Sleep that a caller's abort signal cuts short (resolves false when aborted). */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(true); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(false); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The status codes worth another try: throttled, or the provider's own server trouble. */
export function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

// ── Streaming + time budget ──────────────────────────────────────────

/** Streaming is the default for the HTTP drivers (CURF_LLM_STREAM=off turns it off). */
export function streamingEnabled(): boolean {
  return (process.env.CURF_LLM_STREAM ?? "").toLowerCase() !== "off";
}

/**
 * Wall-clock ceiling for one request. A reasoning model writes ~40 tokens/s
 * (measured on kimi-k3: p50 38-48 tok/s across every Curf call kind,
 * thinking tokens included), so a request allowed to write maxTokens needs
 * maxTokens/40 seconds just to finish — a 9000-token blueprint needs 225s
 * and was given 150s, which is why a third of instant-view calls ended in a
 * timeout at exactly that ceiling. When the response streams, a stall is
 * caught by the idle timeout instead, so the ceiling can safely cover the
 * whole token budget (at 35 tok/s), up to the 300s the ingress allows.
 * Without streaming nothing tells a stall from slow work: unchanged.
 */
/** The longest one request may run (CURF_LLM_WALL_MAX_MS, default 300s: what the hosted ingress allows). A self-hosted model that writes ~23 tok/s needs more for a 9000-token answer. */
export function wallCeilingMs(): number {
  const n = Math.floor(Number(process.env.CURF_LLM_WALL_MAX_MS));
  return Number.isFinite(n) && n >= 60_000 ? Math.min(n, 1_800_000) : 300_000;
}

export function effectiveTimeoutMs(req: { timeoutMs?: number; maxTokens?: number }): number {
  const base = req.timeoutMs ?? 90_000;
  if (!streamingEnabled()) return base;
  return Math.min(wallCeilingMs(), Math.max(base, Math.round((req.maxTokens ?? 0) * 28)));
}

/**
 * A provider refusal that no retry will fix: the account is out of credit or
 * suspended (Moonshot answers that with HTTP 429 and "exceeded_current_quota_error",
 * which looks exactly like throttling), or the workspace's own AI credits are
 * spent. Retrying these 49 times in a row is what a live run did on 2026-10-04
 * when the Kimi balance ran out.
 */
export function isFatalProviderError(error: string | undefined): boolean {
  return /insufficient[_ ](balance|quota|funds)|exceeded[_ ](your[_ ])?(current[_ ])?quota|account is suspended|suspended due to|credit balance is too low|run out of credit|AI_CREDITS_EXHAUSTED/i.test(error ?? "");
}
