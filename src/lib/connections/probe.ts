/**
 * REST data-source probe. Given a REST DataSource, makes one sample HTTP call
 * to its baseUrl (or a hint path), parses the JSON response, and infers field
 * names + types from the first row(s) of the rows-shaped payload.
 *
 * The result lives on DataSource.discoveredSchemaJson and gets fed into the
 * AI report generator's prompt, alongside the SQLite tables it discovers via
 * PRAGMA. So Claude sees a unified data inventory regardless of the
 * underlying source.
 *
 * No npm deps - plain fetch + JSON walk. Honours the connection's `headers`
 * (Authorization, etc) and the optional `jsonPath` to peel into nested
 * responses (e.g. "$.data.items").
 */
import { guardedFetch } from "@/lib/security/ssrfGuard";
import { safeJsonParse } from "@/lib/security/safeJson";

export type DiscoveredField = {
  name: string;
  /** Best-effort JS type inferred from sample values: string|number|boolean|null|object|array */
  type: string;
  sample: unknown;
};

export type DiscoveredSchema = {
  fields: DiscoveredField[];
  sampleRow: Record<string, unknown> | null;
  rowCount: number;
  /** Path inside the response that yielded the rows (when nested). */
  jsonPath?: string;
  probedFrom?: string;
  probedAt: string;
  source: "probe" | "manual" | "openapi";
};

export type ProbeResult =
  | { ok: true; schema: DiscoveredSchema }
  | { ok: false; error: string; httpStatus?: number; raw?: string };

const HEADERS = "headers";
const BASE_URL = "baseUrl";

/**
 * Probe a REST data source. Connection JSON shape:
 *   { "baseUrl": "https://api.example.com", "headers": { "Authorization": "..." } }
 *
 * Probe options:
 *   path:     URL path to GET. Defaults to "/" (the baseUrl root).
 *   jsonPath: dotted path into the response to find rows (e.g. "$.data.items")
 */
export async function probeRestDataSource(
  connectionJson: string,
  opts: { path?: string; jsonPath?: string } = {},
): Promise<ProbeResult> {
  let conn: { baseUrl?: string; headers?: Record<string, string> };
  try {
    // safeJsonParse (OWASP A08:2025) — connectionJson is tenant-supplied
    // config; Object.assign(headers, conn.headers) below would otherwise
    // let a "__proto__" key in a crafted connection swap headers' own
    // prototype (see lib/security/safeJson.ts's header comment).
    conn = safeJsonParse(connectionJson) as typeof conn;
  } catch {
    return { ok: false, error: "Invalid REST connection JSON" };
  }
  if (!conn.baseUrl) return { ok: false, error: "Connection missing baseUrl" };

  const url = joinUrl(conn.baseUrl, opts.path ?? "/");
  const headers: Record<string, string> = { "Accept": "application/json" };
  if (conn.headers) Object.assign(headers, conn.headers);

  let res: Response;
  try {
    // 8s timeout via AbortController so a slow API doesn't hang the request.
    // guardedFetch validates the URL (and every redirect hop) against the
    // SSRF guard — see lib/security/ssrfGuard.ts.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    res = await guardedFetch(url, { headers, signal: ctrl.signal });
    clearTimeout(timer);
  } catch (e: any) {
    return { ok: false, error: "Network error: " + (e?.message ?? e) };
  }

  if (!res.ok) {
    const raw = (await res.text()).slice(0, 400);
    return {
      ok: false,
      error: "HTTP " + res.status + " " + res.statusText,
      httpStatus: res.status,
      raw,
    };
  }

  let json: any;
  try {
    json = await res.json();
  } catch (e: any) {
    return { ok: false, error: "Response was not JSON: " + (e?.message ?? e) };
  }

  // Pluck the rows array. Try the explicit jsonPath first; if absent, walk the
  // top-level response and pick the first array we find (covers
  // {data:[...]}, {results:[...]}, {items:[...]}, plain [...] etc).
  const plucked = opts.jsonPath ? walkPath(json, opts.jsonPath) : autoFindArray(json);
  const rowsCandidate = plucked.value;
  const rows: Array<Record<string, unknown>> = Array.isArray(rowsCandidate)
    ? rowsCandidate.filter((r) => r != null && typeof r === "object")
    : (rowsCandidate && typeof rowsCandidate === "object" ? [rowsCandidate as Record<string, unknown>] : []);

  if (rows.length === 0) {
    return {
      ok: false,
      error: "Couldn't find a rows array in the response. Try setting jsonPath (e.g. $.data.items).",
      raw: JSON.stringify(json).slice(0, 400),
    };
  }

  const sampleRow = rows[0];
  // Union of keys across the first 5 rows so we don't miss optional fields.
  const fieldNames = new Set<string>();
  for (const r of rows.slice(0, 5)) {
    for (const k of Object.keys(r)) fieldNames.add(k);
  }

  const fields: DiscoveredField[] = Array.from(fieldNames).map((name) => ({
    name,
    type: detectType(sampleRow[name]),
    sample: previewValue(sampleRow[name]),
  }));

  return {
    ok: true,
    schema: {
      fields,
      sampleRow: simplifySampleRow(sampleRow),
      rowCount: rows.length,
      jsonPath: opts.jsonPath ?? plucked.pathFound,
      probedFrom: opts.path ?? "/",
      probedAt: new Date().toISOString(),
      source: "probe",
    },
  };
}

// ---------------------------------------------------------------------------

function joinUrl(base: string, path: string): string {
  if (!path) return base;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  if (base.endsWith("/") && path.startsWith("/")) return base + path.slice(1);
  if (!base.endsWith("/") && !path.startsWith("/")) return base + "/" + path;
  return base + path;
}

function walkPath(obj: any, path: string): { value: any; pathFound?: string } {
  const parts = path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let v = obj;
  for (const p of parts) {
    if (v == null) return { value: undefined };
    v = v[p];
  }
  return { value: v, pathFound: path };
}

/**
 * Heuristically find the rows array in an arbitrary JSON response. Searches
 * for the longest array of objects in the first three levels of the tree.
 */
function autoFindArray(obj: any, depth = 0, path = "$"): { value: any; pathFound?: string } {
  if (depth > 3) return { value: undefined };
  if (Array.isArray(obj) && obj.length > 0 && obj.every((x) => typeof x === "object" && x != null)) {
    return { value: obj, pathFound: path };
  }
  if (obj && typeof obj === "object") {
    let bestArr: any[] | null = null;
    let bestPath: string | undefined;
    for (const [k, v] of Object.entries(obj)) {
      const child = autoFindArray(v, depth + 1, path + "." + k);
      if (Array.isArray(child.value) && (!bestArr || child.value.length > bestArr.length)) {
        bestArr = child.value as any[];
        bestPath = child.pathFound;
      }
    }
    if (bestArr) return { value: bestArr, pathFound: bestPath };
  }
  return { value: undefined };
}

function detectType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return typeof v;
}

function previewValue(v: unknown): unknown {
  if (v == null) return v;
  if (typeof v === "string") return v.length > 80 ? v.slice(0, 77) + "…" : v;
  if (typeof v === "object") return JSON.stringify(v).slice(0, 80);
  return v;
}

/** Trim oversized fields out of the sample so the prompt stays compact. */
function simplifySampleRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = previewValue(v);
  return out;
}

/**
 * Parse a manual schema declaration. Accepts either:
 *   - a JSON object matching DiscoveredSchema (advanced), or
 *   - a freeform table-like string: "field_name: type, other_field: type"
 *
 * Used as a fallback when the auto-probe doesn't work.
 */
export function parseManualSchema(text: string): ProbeResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Schema is empty" };

  // JSON path: try parsing as a full DiscoveredSchema or just a fields array.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const j = JSON.parse(trimmed);
      const fields: DiscoveredField[] = Array.isArray(j)
        ? j.map((f: any) => ({ name: String(f.name ?? ""), type: String(f.type ?? "string"), sample: f.sample ?? null }))
        : Array.isArray(j.fields) ? j.fields : [];
      if (fields.length === 0) return { ok: false, error: "No fields found in JSON" };
      return {
        ok: true,
        schema: {
          fields,
          sampleRow: j.sampleRow ?? null,
          rowCount: j.rowCount ?? 0,
          jsonPath: j.jsonPath,
          probedFrom: j.probedFrom,
          probedAt: new Date().toISOString(),
          source: "manual",
        },
      };
    } catch (e: any) {
      return { ok: false, error: "Invalid JSON: " + (e?.message ?? e) };
    }
  }

  // Freeform: "id: number, name: string, total: number"
  const fields: DiscoveredField[] = [];
  for (const part of trimmed.split(",")) {
    const [name, type] = part.split(":").map((s) => s.trim());
    if (!name) continue;
    fields.push({ name, type: type || "string", sample: null });
  }
  if (fields.length === 0) return { ok: false, error: "Couldn't parse any fields" };
  return {
    ok: true,
    schema: {
      fields,
      sampleRow: null,
      rowCount: 0,
      probedAt: new Date().toISOString(),
      source: "manual",
    },
  };
}
