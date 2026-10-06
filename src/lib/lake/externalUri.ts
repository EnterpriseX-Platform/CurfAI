/**
 * Validation for an external-table URI.
 *
 * This is a security boundary, not a typo check. Registering an external
 * table makes the server FETCH the URI — once immediately, to probe the
 * schema (see probeExternalSchema), and again on every query that reads the
 * table. So the URI is a server-side request the tenant gets to aim, and the
 * old rule aimed it anywhere: any http(s) URL, including
 * http://169.254.169.254/ (cloud instance metadata) and anything on the
 * cluster's private network, plus ANY absolute filesystem path, which let an
 * admin read the server's own disk through DuckDB.
 */
import path from "node:path";
import { assertPublicHttpUrl } from "@/lib/security/ssrfGuard";

/**
 * Root that local-filesystem URIs must sit under. Unset — the default, and
 * how Cloud runs — means no local path is readable at all. A self-hosted
 * deploy that mounts a data volume points this at it and keeps working.
 */
export function externalTableLocalRoot(): string | null {
  const v = (process.env.CURF_EXTERNAL_TABLE_ROOT ?? "").trim();
  return v ? v.replace(/[\/]+$/, "") : null;
}

/** Empty string when the URI is acceptable, else the reason to reject it. */
export async function validateExternalUri(format: string, uri: string): Promise<string> {
  const isObjectStore = /^(s3|gs|azure|abfss|abfs):\/\//i.test(uri);
  const isHttp = /^https?:\/\//i.test(uri);
  const isAbsolutePath = /^\//.test(uri);

  if (format === "csv_url" || format === "json_url") {
    if (!isHttp) return "csv_url / json_url must use http:// or https://";
  } else if (!isObjectStore && !isHttp && !isAbsolutePath) {
    return "URI must start with s3://, gs://, https://, abfss://, or be an absolute filesystem path.";
  }

  if (isHttp) {
    // The same guard every other outbound-URL surface uses (REST data
    // sources, webhooks, backup destinations). It resolves DNS first, so a
    // public hostname pointing at a private address is caught too.
    try {
      await assertPublicHttpUrl(uri);
    } catch (e: any) {
      return e?.message ?? "That URL is not reachable from this server.";
    }
  }

  if (isAbsolutePath) {
    const root = externalTableLocalRoot();
    if (!root) {
      return "Local filesystem paths are not enabled on this deployment. Use s3://, gs://, abfss:// or https:// instead.";
    }
    // Resolve both sides before comparing so `..` can't climb out, and
    // compare against `root + sep` so /data-secrets doesn't pass for /data.
    const resolved = path.resolve(uri);
    const rootResolved = path.resolve(root);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      return `Local paths must sit under ${rootResolved}.`;
    }
  }

  return "";
}
