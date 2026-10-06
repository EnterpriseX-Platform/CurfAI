import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { EDITION } from "@/lib/ee/edition";

/**
 * Serve the docs static export (built into public/docs/ at image build time).
 *
 * Next.js's public/ directory doesn't do directory indexing — it serves files
 * at their exact paths only. The docs static export generates slug/index.html
 * files (trailingSlash: true in docs-site/next.config.mjs), so we rewrite:
 *
 *   /docs               → /docs/index.html
 *   /docs/quickstart    → /docs/quickstart/index.html
 *   /docs/concepts/...  → /docs/concepts/.../index.html
 *
 * Requests that already carry a file extension (JS, CSS, HTML, fonts, etc.)
 * are passed through unchanged — those are the _next/ assets served directly.
 */
/**
 * CORS for the public API. /api/v1 is authenticated with Bearer keys, not
 * cookies, so a wildcard origin adds no CSRF surface — an attacker's page
 * still needs a key it doesn't have. Without these headers no external
 * frontend (the whole point of the v1 API) can call it from a browser.
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

// The MCP OAuth discovery documents and token endpoints are fetched
// directly by a remote connector's own backend (claude.ai, ChatGPT), the
// same cross-origin shape as /api/v1 — CORS-open for the same reason: these
// are either public metadata or authenticated by the request's own
// credentials (a client_id/secret pair, a PKCE verifier), not a cookie, so
// a wildcard origin adds no CSRF surface.
function isOauthPath(pathname: string): boolean {
  return pathname === "/.well-known/oauth-authorization-server"
    || pathname === "/.well-known/oauth-protected-resource"
    || pathname.startsWith("/api/oauth/");
}

// The marketing site (curf.ai — a static Astro build on its own origin)
// posts its contact form to /api/waitlist. That route is unauthenticated,
// Zod-validated and rate-limited per email, and never reads a cookie, so
// letting the marketing origin call it adds no CSRF surface. It is an
// allowlist, not a wildcard: only the marketing hosts (plus the local Astro
// preview outside production) may call it from a browser.
const MARKETING_ORIGINS = new Set([
  "https://curf.ai",
  "https://www.curf.ai",
  ...(process.env.NODE_ENV !== "production" ? ["http://localhost:4321", "http://127.0.0.1:4321"] : []),
]);

// ── The Executive view (CEO 2026-09-25) ─────────────────────────────────
// Executives and viewers use /executive; the Curf Console is the builder's
// tool. A Console page sends them there. What they may still open directly:
// a report, a dashboard, an app, an Operate request or the decision ledger
// someone linked them to — content, not the Console's hubs.
// Not in the Community edition, which has no Executive view.
const CONSOLE_PAGE = /^\/(admin|account|agent|ask|brief|build|catalog|connections|connectors|dashboards|data|knowledge|metrics|notebooks|on-screen|operate|reports|schedules|tables|templates)(\/|$)/;
const EXEC_ROLES = new Set(["executive", "viewer"]);

/** Where an executive/viewer on this Console path belongs, or null to let it through. */
export function executiveRedirectFor(pathname: string): string | null {
  const m = pathname.match(CONSOLE_PAGE);
  if (!m) return null;
  const seg = m[1];
  if (seg === "account") return "/executive/account";
  // One report or dashboard someone linked them to — but not a list, a new one, or the designer.
  if ((seg === "reports" || seg === "dashboards") && /^\/(reports|dashboards)\/(?!new(\/|$))[^/]+\/?$/.test(pathname)) return null;
  // One Operate request (what an approval card or email links to) — not the builder's Operate pages.
  if (seg === "operate" && /^\/operate\/(?!templates|insights|incidents|watchers|new|action-center)[^/]+\/?$/.test(pathname)) return null;
  return "/executive";
}

// Pages that lived in the Console before the Executive view had its own
// surface. Links to them are in sent emails, LINE cards and bookmarks, so
// they redirect — for everyone, with the query string kept.
const MOVED_TO_EXECUTIVE = /^\/(home|approvals|assist|tracking)(\/[^/]+)?\/?$/;

/** The /executive path an old Console path moved to, or null. */
export function movedToExecutive(pathname: string): string | null {
  const m = pathname.match(MOVED_TO_EXECUTIVE);
  if (!m) return null;
  if (m[2] && m[1] !== "tracking") return null; // only /tracking/<id> had children
  return m[1] === "home" ? "/executive" : `/executive/${m[1]}${m[2] ?? ""}`;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const moved = EDITION !== "community" ? movedToExecutive(pathname) : null;
  if (moved) {
    const url = req.nextUrl.clone();
    url.pathname = moved;
    return NextResponse.redirect(url);
  }

  if (EDITION !== "community" && !pathname.startsWith("/api/") && !pathname.startsWith("/docs") && CONSOLE_PAGE.test(pathname)) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET }).catch(() => null);
    const target = token && EXEC_ROLES.has(String((token as any).role ?? "")) ? executiveRedirectFor(pathname) : null;
    if (target) return NextResponse.redirect(new URL(target, req.url));
    return NextResponse.next();
  }

  if (pathname === "/api/waitlist") {
    const origin = req.headers.get("origin");
    if (origin && MARKETING_ORIGINS.has(origin)) {
      const headers: Record<string, string> = {
        ...CORS_HEADERS,
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        Vary: "Origin",
      };
      if (req.method === "OPTIONS") return new NextResponse(null, { status: 204, headers });
      const res = NextResponse.next();
      for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
      return res;
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/v1") || isOauthPath(pathname)) {
    if (req.method === "OPTIONS") {
      return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
    }
    const res = NextResponse.next();
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
    return res;
  }

  // Only /docs is rewritten below; anything else that reached here passes through.
  if (!(pathname === "/docs" || pathname.startsWith("/docs/"))) return NextResponse.next();
  // Already has an extension — static asset, pass through.
  if (/\.\w+$/.test(pathname)) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname =
    pathname === "/docs" || pathname === "/docs/"
      ? "/docs/index.html"
      : pathname.replace(/\/$/, "") + "/index.html";

  return NextResponse.rewrite(url);
}

export const config = {
  matcher: [
    "/docs", "/docs/:path*", "/api/v1/:path*", "/api/waitlist",
    "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource",
    "/api/oauth/:path*",
    // Old paths that moved to the Executive view.
    "/home", "/approvals", "/assist", "/tracking", "/tracking/:path*",
    // Console pages, for sending executives and viewers to /executive.
    "/(admin|account|agent|ask|brief|build|catalog|connections|connectors|dashboards|data|knowledge|metrics|notebooks|on-screen|operate|reports|schedules|tables|templates)/:path*",
    "/(admin|account|agent|ask|brief|build|catalog|connections|connectors|dashboards|data|knowledge|metrics|notebooks|on-screen|operate|reports|schedules|tables|templates)",
  ],
};
