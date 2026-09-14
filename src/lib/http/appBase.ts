import type { NextRequest } from "next/server";
import { headers } from "next/headers";

/**
 * The app's own public origin, for building an absolute link (invite
 * email, sign-in link) from inside a server route. `new URL(req.url).origin`
 * alone is wrong behind a reverse proxy / k8s ingress — it resolves to
 * whatever host the Next.js server itself sees the request arrive on
 * (here, the pod's internal `http://localhost:3100`), not the public
 * domain the browser actually used. Live case: an external-viewer invite
 * link built that way pointed at localhost:3100 — unreachable outside the
 * cluster, so the invite was silently unusable no matter how it was sent.
 *
 * Same fallback order already used ad hoc in a couple of routes
 * (reports/route.ts, reports/from-template/route.ts): trust
 * X-Forwarded-Proto/Host first (set correctly by the ingress), then the
 * configured NEXTAUTH_URL, then req.url's own origin as a last resort
 * (correct for local dev, where there's no proxy in front of the request).
 */
export function appBase(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (proto && host) return `${proto}://${host}`;
  return process.env.NEXTAUTH_URL ?? new URL(req.url).origin;
}

/**
 * Same resolution as appBase(), for a server component that only has
 * next/headers — no NextRequest to read req.url from, so the last resort is
 * NEXTAUTH_URL's own default rather than a request URL.
 */
/**
 * Origin the server uses to call ITSELF — the PDF and XLSX renderers open
 * the viewer in headless Chromium. INTERNAL_BASE_URL wins (a cluster-local
 * address that skips the ingress), then the public NEXTAUTH_URL, then the
 * dev default. Without this, an instance on any port but 3100 could not
 * export a PDF.
 */
export function internalBase(): string {
  return process.env.INTERNAL_BASE_URL ?? process.env.NEXTAUTH_URL ?? "http://localhost:3100";
}

export function appBaseFromHeaders(): string {
  const h = headers();
  const proto = h.get("x-forwarded-proto");
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (proto && host) return `${proto}://${host}`;
  return process.env.NEXTAUTH_URL ?? "http://localhost:3100";
}
