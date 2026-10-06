import type { NextRequest } from "next/server";
import { headers } from "next/headers";

/**
 * The app's own public origin, for building an absolute link (invite and
 * password-reset emails, sign-in links, embed snippets, delivery deep
 * links) from inside a server route. Every such link goes through here —
 * never `new URL(req.url).origin`, which behind the k8s ingress resolves to
 * the pod's own `https://localhost:3100`: reset and invite emails, embed
 * snippets and scheduled-delivery links all pointed there on prod until
 * 2026-09-24 (FE-AUTH-07 / FE-ADM-USR-01).
 *
 * The configured NEXTAUTH_URL comes first. It must already be the public,
 * browser-facing origin (NextAuth's own redirects use it), and unlike the
 * request's headers it can't be chosen by the caller: with no proxy in
 * front — a self-hosted Community deployment — anyone can send
 * X-Forwarded-Host, and a reset link built from it would carry a valid
 * token to their domain. The forwarded headers (set by the ingress) and
 * then req.url's own origin (local dev, no proxy) are fallbacks for a
 * deployment that hasn't set NEXTAUTH_URL.
 */
export function appBase(req: NextRequest): string {
  if (process.env.NEXTAUTH_URL) return process.env.NEXTAUTH_URL.replace(/\/+$/, "");
  const proto = req.headers.get("x-forwarded-proto");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (proto && host) return `${proto}://${host}`;
  return new URL(req.url).origin;
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
  if (process.env.NEXTAUTH_URL) return process.env.NEXTAUTH_URL.replace(/\/+$/, "");
  const h = headers();
  const proto = h.get("x-forwarded-proto");
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (proto && host) return `${proto}://${host}`;
  return "http://localhost:3100";
}
