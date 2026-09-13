/**
 * Combine a REST connection's base URL with a per-query path — shared by
 * the report runner (runOnRest) and the connection test endpoint, which
 * both used to carry their own copy of this.
 *
 * Unlike `new URL(path, baseUrl)`, which resolves "/" against the origin
 * and wipes out the base path, this preserves the base path when the
 * caller passes "/" or an empty string.
 *
 * Security note: `path` is the untrusted half of this call — it comes
 * from a report author's DataSourceDef, or a request body, while
 * `baseUrl` is the connection's own trusted origin (the credential that
 * gets attached alongside it). An absolute `path` pointing at a
 * DIFFERENT origin than `baseUrl` used to be honoured verbatim, which let
 * a report author redirect the request — decrypted connection headers
 * (Authorization: Bearer …) included — to any host they typed, e.g. a
 * pagination "next" link is a legitimate reason to want an absolute URL,
 * but there's no legitimate reason for that URL to leave the connection's
 * own host while still carrying its credentials. Reject instead of
 * silently stripping headers, so the failure is loud rather than a
 * quietly-degraded request.
 */
export function joinRestUrl(baseUrl: string, path: string | undefined): string {
  const p = (path ?? "").trim();
  if (p === "" || p === "/") return baseUrl;
  if (/^https?:\/\//.test(p)) {
    if (new URL(p).origin !== new URL(baseUrl).origin) {
      throw new Error(
        `path "${p}" is an absolute URL on a different host than this connection's base URL — refusing to send its credentials there.`,
      );
    }
    return p;
  }
  const base = baseUrl.replace(/\/+$/, "");
  const rel = p.startsWith("/") ? p : "/" + p;
  return base + rel;
}
