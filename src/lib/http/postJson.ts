/**
 * The one way to POST JSON to an external webhook (Slack/Teams/Discord/
 * generic). Every outbound integration must go through this instead of a
 * bare fetch(): before this helper existed the same POST was hand-rolled in
 * four places and three of them had no timeout — a hung endpoint could
 * stall a whole cron tick.
 *
 * Never throws. Network errors and timeouts come back as
 * { ok: false, status: 0, body: <reason> } so callers map results without
 * their own try/catch ceremony.
 */

import { guardedFetch } from "@/lib/security/ssrfGuard";

export type PostJsonResult = {
  ok: boolean;
  /** HTTP status; 0 when the request never completed (network error / timeout). */
  status: number;
  /** Response body (or failure reason), truncated — enough for run logs. */
  body: string;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const BODY_SLICE = 300;

export async function postJson(
  url: string,
  payload: unknown,
  opts?: { timeoutMs?: number; headers?: Record<string, string> },
): Promise<PostJsonResult> {
  // AbortController over AbortSignal.timeout — safer across Node versions.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    // guardedFetch validates the URL (and every redirect hop) against the
    // SSRF guard — see lib/security/ssrfGuard.ts.
    const res = await guardedFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
      // Pre-serialized payloads (already a string) pass through untouched so
      // callers that sign the exact bytes (HMAC webhooks) stay correct.
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = (await res.text().catch(() => "")).slice(0, BODY_SLICE);
    return { ok: res.ok, status: res.status, body };
  } catch (e: any) {
    const reason = e?.name === "AbortError" ? "timeout" : (e?.message ?? String(e));
    return { ok: false, status: 0, body: reason.slice(0, BODY_SLICE) };
  } finally {
    clearTimeout(timer);
  }
}
