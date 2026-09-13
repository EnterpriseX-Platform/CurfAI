import { NextRequest, NextResponse } from "next/server";

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

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

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
  ],
};
