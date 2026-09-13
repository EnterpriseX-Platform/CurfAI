/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `next dev` wipes and rebuilds its dist directory on start, so two dev
  // servers in one checkout (a second Claude session, an e2e run against
  // its own port) clobber each other's output through the shared `.next`
  // and wedge. Point a second server at its own directory instead:
  //   CURF_DIST_DIR=.next-e2e next dev -p 3102
  // Unset = `.next`, exactly as before.
  distDir: process.env.CURF_DIST_DIR || ".next",
  // Minor info-disclosure fix (OWASP A02:2025 checklist, 2026-08-25) — stop
  // announcing the framework in every response header.
  poweredByHeader: false,
  experimental: {
    // Keep these native/heavy deps external so Next doesn't try to bundle them
    // into route handlers.
    serverComponentsExternalPackages: ["puppeteer", "better-sqlite3", "docx", "exceljs", "pg", "mysql2", "snowflake-sdk", "@google-cloud/bigquery", "@duckdb/node-api", "ssh2-sftp-client", "ssh2"],
  },
  async headers() {
    return [
      // Baseline hardening on every response. HSTS is only honoured over
      // https, so it's a no-op in local http dev and safe to send always.
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          // Added 2026-08-25 (OWASP A02:2025 checklist). Deliberately omits
          // `frame-ancestors` — that's already X-Frame-Options's job above,
          // and duplicating it here risks colliding with /embed/*'s CSP
          // override below: multiple Content-Security-Policy headers on one
          // response are combined by the browser as an INTERSECTION (most
          // restrictive directive wins across all of them), so a
          // `frame-ancestors` here would silently re-block the embed
          // surface that override exists to allow.
          // script-src/connect-src allow esm.sh + cdn.jsdelivr.net — the
          // only genuine client-side external load in the app
          // (MapBlock.tsx fetches d3-geo/topojson-client + world-atlas
          // topology from there at runtime; see that file's module doc).
          // 'unsafe-inline' on script/style is a pragmatic starting point
          // (no nonce plumbing yet, and Next.js's own hydration + Tailwind
          // both lean on inline); tighten to nonces later if this needs
          // to get stricter.
          // 'unsafe-eval' verified necessary, not assumed: without it, a
          // real production build (`next build && next start`, not just
          // dev) threw "EvalError: Evaluating a string as JavaScript
          // violates..." from Next.js's own main-app.js runtime chunk on
          // every single page (login included) — this is framework-
          // internal, not attacker-controlled content, so it doesn't
          // undermine the policy's actual goal (blocking injected
          // <script> tags / inline handlers from untrusted data).
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://esm.sh",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self'",
              "connect-src 'self' https://cdn.jsdelivr.net https://esm.sh",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
      // /embed/* is the documented exception — it must be iframable so tenants
      // can embed reports. It overrides the DENY above with a framing policy.
      // Tighten `frame-ancestors` to a per-tenant allowlist when productizing.
      {
        source: "/embed/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors *" },
          { key: "X-Frame-Options", value: "" },
        ],
      },
    ];
  },
  /**
   * Sidebar reorg landed — these routes moved homes. Redirect (308 permanent)
   * so existing bookmarks, audit links, marketplace pubs, in-app cross-refs
   * we missed during the sweep, and external integrations all keep working.
   * Keep these forever — there's no cost to leaving redirects in place, but
   * removing them breaks tenants who had the old URL pinned.
   */
  async redirects() {
    return [
      // Operate platform → /operate (was /business-actions)
      { source: "/business-actions", destination: "/operate", permanent: true },
      { source: "/business-actions/:path*", destination: "/operate/:path*", permanent: true },
      // Action Center → /operate/incidents (was /actions)
      { source: "/actions", destination: "/operate/incidents", permanent: true },
      { source: "/actions/:path*", destination: "/operate/incidents/:path*", permanent: true },
      // Watchers moved out of Admin
      { source: "/admin/watchers", destination: "/operate/watchers", permanent: true },
      { source: "/admin/watchers/:path*", destination: "/operate/watchers/:path*", permanent: true },
      // Data quality moved out of Admin (to the Data group)
      { source: "/admin/quality", destination: "/data/quality", permanent: true },
      { source: "/admin/quality/:path*", destination: "/data/quality/:path*", permanent: true },
      // Connections (was /data-sources)
      { source: "/data-sources", destination: "/connections", permanent: true },
      { source: "/data-sources/:path*", destination: "/connections/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
