/**
 * Which engine endpoints Curf's admin console may reach, and with what.
 *
 * "One console": a Curf admin manages the engine's views, its connections to the customer's databases, and who
 * holds which attribute from Curf's own screens, so customers never meet the engine's API. Those screens talk to
 * the engine through one guarded proxy (app/api/engine/admin/[...path]) instead of a route per endpoint. The
 * guard is this allow-list: only these paths, only these methods, each path segment a plain identifier, only
 * these query parameters. Anything else is a 404 or 405 before the engine is called — a proxy that forwarded
 * "whatever path the browser sent" would be a way to reach every engine endpoint with an admin's token.
 */

const ID = "[0-9a-fA-F-]{36}";

type Rule = { pattern: RegExp; methods: readonly string[] };

export const ADMIN_RULES: readonly Rule[] = [
  { pattern: /^\/views$/, methods: ["GET", "POST"] },
  { pattern: new RegExp(`^/views/${ID}$`), methods: ["GET", "PUT", "DELETE"] },
  { pattern: new RegExp(`^/views/${ID}/(summary|versions)$`), methods: ["GET"] },
  { pattern: new RegExp(`^/views/${ID}/(preview|publish|unpublish)$`), methods: ["POST"] },
  { pattern: /^\/connections$/, methods: ["GET", "POST"] },
  { pattern: new RegExp(`^/connections/${ID}$`), methods: ["GET", "PUT", "DELETE"] },
  { pattern: new RegExp(`^/connections/${ID}/(test|introspect)$`), methods: ["POST"] },
  { pattern: /^\/policies\/entitlements$/, methods: ["GET", "PUT"] },
  { pattern: /^\/audit-events$/, methods: ["GET"] },
];

/** Query parameters that are passed on, by name. Everything else the browser sent is dropped. */
export const ADMIN_QUERY_PARAMS = ["page", "size", "subject", "attribute"] as const;

const SEGMENT = /^[A-Za-z0-9-]{1,64}$/;

export type AdminRoute = { ok: true; path: string } | { ok: false; status: 404 | 405 };

/** The engine path for these URL segments and method, or why not. Segments come from the router, already decoded. */
export function matchAdminRoute(method: string, segments: string[]): AdminRoute {
  if (segments.length === 0 || segments.length > 4 || !segments.every((s) => SEGMENT.test(s))) return { ok: false, status: 404 };
  const path = `/${segments.join("/")}`;
  const rule = ADMIN_RULES.find((r) => r.pattern.test(path));
  if (!rule) return { ok: false, status: 404 };
  if (!rule.methods.includes(method.toUpperCase())) return { ok: false, status: 405 };
  return { ok: true, path };
}

/** The query string to send the engine: the allowed parameters only, each bounded, properly encoded. */
export function adminQuery(search: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const name of ADMIN_QUERY_PARAMS) {
    const value = search.get(name);
    if (value !== null && value.length <= 255) out.set(name, value);
  }
  const text = out.toString();
  return text ? `?${text}` : "";
}

/** What a mutating call is recorded as in the audit trail: the method and the engine path, never the body (it may hold a password). */
export function adminAuditMeta(method: string, path: string): { method: string; path: string } {
  return { method: method.toUpperCase(), path };
}

/** The most of a request body the proxy will pass on. */
export const ADMIN_BODY_MAX_BYTES = 1024 * 1024;
