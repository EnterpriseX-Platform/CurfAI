/**
 * Proof-carrying provenance for every query a report runs.
 *
 * Each query produces a ProvenanceRecord that fingerprints:
 *   - the exact query definition (so two identical-looking SQL strings with
 *     different whitespace hash the same, but any real change invalidates)
 *   - the data source it ran against
 *   - when it ran, and how long it took
 *   - how many rows came back
 *   - a hash of the result set itself
 *
 * The fingerprint is what makes reports auditable: if a KPI says
 * "$1.2M revenue", we can prove which query ran, at what moment, against
 * which data source, and that the data hasn't been tampered with since.
 *
 * Pure helpers — safe to import on the server. Uses Node's crypto module.
 */
import { createHash } from "node:crypto";
import type { DataSourceDef } from "@/lib/reporting/schema";
import type { Row } from "@/lib/reporting/interpolate";

export type ProvenanceRecord = {
  /** Stable id matching the DataSourceDef.id in the report definition. */
  queryId: string;
  /** Human label from DataSourceDef.name — shown in the popover header. */
  queryName: string;
  /** SHA-256 of the normalized query definition (SQL/path/body/params shape). */
  queryHash: string;
  /** ISO timestamp when the query finished. */
  runAt: string;
  /** How long the query took, in milliseconds. */
  durationMs: number;
  /** Number of rows returned. */
  rowCount: number;
  /** SHA-256 of the result rows — detects tampering or source drift. */
  dataHash: string;
  /** Resolved data source name (e.g. "sample_warehouse"). */
  dataSourceName: string;
  /** Driver kind: "sqlite" | "rest" | etc. */
  dataSourceKind: string;
  /**
   * Set when the runner skipped the query because the viewer can't see the
   * source (visibility ACL). The dataset will be empty rows and downstream
   * blocks should render as "no access" rather than as zero-data graphs.
   */
  accessDeniedNote?: string;
  /**
   * Set when the runner caught an exception executing the query (driver
   * failure, network timeout, missing table, etc). The dataset is empty
   * rows; downstream blocks should render as "couldn't run this query"
   * rather than as zero-data graphs. The full message is truncated to keep
   * this serializable safely; check server logs for the full stack.
   */
  executionError?: string;
  /**
   * Cross-source JOIN summary. When the query ATTACHed foreign sources,
   * each appears here so the proof popover can render
   *   "Joined: warehouse → excel:imports as `m`"
   * preserving the multi-source narrative on every cell that consumes
   * this query. Empty / unset means the query ran against a single source.
   */
  attachedSources?: Array<{ name: string; kind: string; alias: string }>;
};

export type ProvenanceMap = Record<string, ProvenanceRecord>;

/**
 * Normalize a query definition so equivalent queries hash the same.
 * SQL is lowercased and collapsed; REST is normalized as method+path+body+headers.
 * Parameters are part of the hash so "same SQL, different params" = different fingerprint.
 */
export function hashQueryDef(ds: DataSourceDef, params: Record<string, unknown>): string {
  const bound: Record<string, unknown> = {};
  // Only include parameters that are actually referenced — keeps hash stable
  // when an unrelated param changes.
  const refRegex = /[:{]([a-zA-Z_][a-zA-Z0-9_]*)\}?/g;
  const haystacks = [ds.sql ?? "", ds.path ?? "", ds.body ?? ""].join(" ");
  let m: RegExpExecArray | null;
  while ((m = refRegex.exec(haystacks)) !== null) {
    const k = m[1];
    if (k in params) bound[k] = params[k];
  }

  const canonical = JSON.stringify({
    sql: (ds.sql ?? "").replace(/\s+/g, " ").trim().toLowerCase(),
    method: ds.method ?? null,
    path: ds.path ?? null,
    body: ds.body ?? null,
    jsonPath: ds.jsonPath ?? null,
    headers: ds.headers ?? null,
    params: bound,
  });
  return "sha256:" + createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

/**
 * Stable hash of a row set. Re-serializes each row with keys sorted so
 * accidental key reordering doesn't change the fingerprint.
 */
export function hashRows(rows: Row[]): string {
  const h = createHash("sha256");
  for (const row of rows) {
    const keys = Object.keys(row).sort();
    const stable: Record<string, unknown> = {};
    for (const k of keys) stable[k] = row[k];
    h.update(JSON.stringify(stable));
    h.update("\n");
  }
  return "sha256:" + h.digest("hex").slice(0, 24);
}

/**
 * Build a full provenance record. Called by the runner after each query runs.
 *
 * `dataHash` is optional to let a cache hit pass in the hash computed on
 * the original miss instead of paying for a full hashRows(rows) pass again
 * — that's a sorted-keys JSON.stringify of every row, which is real cost
 * at tens of thousands of rows (150-900ms observed in a workload test) and
 * used to run unconditionally on every call, cache hit or not.
 */
export function buildProvenance(args: {
  ds: DataSourceDef;
  rows: Row[];
  params: Record<string, unknown>;
  dataSourceName: string;
  dataSourceKind: string;
  startedAt: number;
  /** Precomputed hashRows(rows) result, e.g. from a query-cache hit. Recomputed when omitted. */
  dataHash?: string;
  /** Optional — set when the runner skipped due to visibility ACL. */
  accessDeniedNote?: string;
  /** Optional — set when the query threw at execution time. */
  executionError?: string;
  /** Optional — set when the query ATTACHed foreign sources (cross-source JOIN). */
  attachedSources?: Array<{ name: string; kind: string; alias: string }>;
}): ProvenanceRecord {
  const endedAt = Date.now();
  return {
    queryId: args.ds.id,
    queryName: args.ds.name,
    queryHash: hashQueryDef(args.ds, args.params),
    runAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - args.startedAt,
    rowCount: args.rows.length,
    dataHash: args.dataHash ?? hashRows(args.rows),
    dataSourceName: args.dataSourceName,
    dataSourceKind: args.dataSourceKind,
    accessDeniedNote: args.accessDeniedNote,
    executionError: args.executionError,
    attachedSources: args.attachedSources,
  };
}
