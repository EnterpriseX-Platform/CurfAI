/**
 * The client IP a rate limiter or audit row should key on.
 *
 * `X-Forwarded-For` is a comma-separated chain that every proxy APPENDS to,
 * so its FIRST entry is whatever the client chose to send — keying a
 * limiter on it lets anyone reset their bucket per request with a header.
 * The trustworthy entry is the one our own proxy added: the last hop, or
 * the N-th from the end when several trusted proxies (CDN, then ingress)
 * sit in front of the app. CURF_TRUSTED_PROXY_HOPS says how many; the
 * default of 1 matches a single ingress.
 *
 * `X-Real-IP` (set by nginx-ingress from the actual peer) is the fallback,
 * then "unknown" — which still rate-limits, just as one shared bucket.
 */
import type { NextRequest } from "next/server";

export function clientIp(req: Pick<NextRequest, "headers">): string {
  const hops = Math.max(1, Number.parseInt(process.env.CURF_TRUSTED_PROXY_HOPS ?? "1", 10) || 1);
  const chain = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fromChain = chain.length >= hops ? chain[chain.length - hops] : chain[0];
  return fromChain || req.headers.get("x-real-ip")?.trim() || "unknown";
}
