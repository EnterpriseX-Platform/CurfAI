/**
 * Executes a report's named data sources against the configured connections
 * and returns a dataset map { queryId: rows[] }. Dispatches by DataSource.kind:
 *   - sqlite : SELECT via better-sqlite3 (validated + parameterised).
 *   - rest   : HTTP fetch; response JSON "flattened" through optional jsonPath.
 *
 * Adding a new kind = add a new branch here and ensure the DataSource row's
 * `connection` field holds whatever that driver expects.
 */
import Database from "better-sqlite3";
import { Client as PgClient } from "pg";
import { createConnection as createMyConnection } from "mysql2/promise";
import { prisma } from "@/lib/db";
import type { DataSourceDef, Report } from "@/lib/reporting/schema";
import { interpolate as interpolatePure } from "@/lib/reporting/interpolate";
import { decodePgConnection, resolvePgClientConfig } from "@/lib/connections/postgres";
import { decodeMyConnection, resolveMyClientConfig } from "@/lib/connections/mysql";
import { decodeRestConnection, resolveRestHeaders } from "@/lib/connections/rest";
import { joinRestUrl } from "@/lib/reporting/restUrl";
import { tenantLakePath } from "@/lib/lake/storage";
import { assertSelectOnly } from "./sqlGuard";
export { assertSelectOnly };
import { guardedFetch } from "@/lib/security/ssrfGuard";


import type { Dataset, Row } from "@/lib/reporting/interpolate";
import { buildProvenance, hashRows, type ProvenanceMap } from "@/lib/reporting/provenance";
import { canSeeDataSource } from "@/lib/datasourceAcl";
import { hashJoin } from "@/lib/reporting/hashJoin";
import { getCachedRows, setCachedRows } from "@/lib/reporting/queryCache";
import { reportRunMs } from "@/lib/metrics";
import { ee } from "@/ee";
import { rewriteNamedParams, translateNamedToQuestionMark } from "@/lib/reporting/namedParams";
export type { Dataset, Row };
export type { ProvenanceMap, ProvenanceRecord } from "@/lib/reporting/provenance";

/**
 * Defense-in-depth viewer identity. When supplied, the runner checks each
 * referenced DataSource against the visibility ACL before executing its
 * query — if the viewer can't see the source, the query gets an empty
 * result + a provenance note rather than throwing. This protects reports
 * that were valid at design time but reference a source the viewer lost
 * access to (visibility was tightened, owner_only was added, etc).
 *
 * Callers without an authenticated viewer (server cron, watcher narration)
 * may omit this; the runner then runs every query, since those contexts
 * predate per-user filtering.
 */
export type RunViewer = {
  id: string;
  isAdmin: boolean;
  roles: string[];
};

export type RunContext = {
  report: Report;
  params: Record<string, unknown>;
  viewer?: RunViewer;
  /**
   * When true, skip the in-process query result cache for this run. Wired
   * to `?bust=1` on the report data API so a viewer can force a refresh.
   * Cache writes still happen — busting only affects reads.
   */
  cacheBust?: boolean;
  /**
   * Run for a file export rather than the screen.
   *
   * Lifts the generator's display cap (see `previewLimit` on the query) so
   * an exported file holds the whole table instead of the first page of it.
   * A limit the report author wrote themselves is never touched.
   */
  forExport?: boolean;
};

export type RunResult = {
  dataset: Dataset;
  provenance: ProvenanceMap;
};

// ---------- Helpers ----------

export function bindParams(sql: string, params: Record<string, unknown>) {
  const needed = new Set<string>();
  sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, p1) => {
    needed.add(p1);
    return _m;
  });
  const bound: Record<string, unknown> = {};
  for (const name of needed) {
    if (!(name in params)) throw new Error(`Missing parameter: ${name}`);
    bound[name] = params[name];
  }
  return bound;
}

/**
 * Reject anything that isn\'t a SELECT (or a WITH-bound SELECT). The intent
 * is to block writes (INSERT/UPDATE/DELETE/DROP/...) and side-effecty
 * statements (PRAGMA/ATTACH/CREATE/...). We deliberately do NOT round-trip
 * the query through node-sql-parser - it fails on legitimate SQLite syntax
 * (CASE expressions, strftime, window functions in some contexts), which
 * would block real customer reports. Better-sqlite3 still parses + binds
 * the query at execution time, so a malformed query still errors cleanly.
 */
/**
 * Hard ceiling on rows an export may pull. The display cap exists for
 * speed; this one exists so a runaway table can't exhaust memory building
 * a file nobody can open. Far above any realistic spreadsheet.
 */
export const EXPORT_ROW_CAP = 100_000;

/**
 * Swap a generator-applied display cap for the export ceiling.
 *
 * Only touches queries carrying `previewLimit` — the marker the report
 * generator sets on the `SELECT * … LIMIT n` it writes for the on-screen
 * preview. A LIMIT the report author typed has no marker and is left
 * exactly as written; silently overriding it would be its own bug.
 *
 * Returns the query unchanged when there is nothing to lift, so callers
 * can map over every query unconditionally.
 */
export function liftPreviewLimit(ds: DataSourceDef): DataSourceDef {
  if (!ds.previewLimit || !ds.sql) return ds;
  // Match only a LIMIT that ends the statement (optionally with OFFSET, and
  // tolerating a trailing semicolon). Anything else — a LIMIT inside a
  // subquery, say — is left alone.
  const trailing = /\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*;?\s*$/i;
  if (!trailing.test(ds.sql)) return ds;
  const sql = ds.sql.replace(trailing, "") + ` LIMIT ${EXPORT_ROW_CAP}`;
  return { ...ds, sql };
}

// Walk a dotted path into a JSON value: "$.data.items" => json.data.items.
// Returns the original value if path is empty or "$".
function pluck(json: any, path?: string): any {
  if (!path || path === "$" || path === "") return json;
  const parts = path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let v = json;
  for (const p of parts) {
    if (v == null) return v;
    v = v[p];
  }
  return v;
}

// ---------- SQL driver (SQLite) ----------

/**
 * Run a SQL query against the primary SQLite/Excel-imported connection,
 * optionally ATTACHing foreign sources so the SQL can JOIN across them.
 *
 * Caching:
 *   - No attaches    → reuse the per-source connection from connCache.
 *   - With attaches  → open a fresh, dedicated connection. Attached state
 *                      is owned by the connection, and we close it after
 *                      the query so it doesn't bleed into subsequent runs.
 *                      Foreign sources are opened in their own connections
 *                      cached by id, but ATTACH operates on the primary's
 *                      file paths — no shared open is needed.
 *
 * Path safety: connection strings come from DataSource.connection in our
 * own DB, never from user-supplied SQL. Single quotes in the path get
 * doubled per SQLite's literal-quoting rule before splicing into the
 * ATTACH statement.
 */
function runOnSqlite(
  ds: DataSourceDef,
  dsRow: { connection: string },
  connCache: Map<string, any>,
  params: Record<string, unknown>,
  attaches?: ResolvedAttach[],
): Row[] {
  if (!ds.sql) throw new Error(`Query "${ds.name}" has no sql`);
  assertSelectOnly(ds.sql);

  const hasAttaches = !!attaches && attaches.length > 0;
  let db: any;
  if (hasAttaches) {
    // Fresh connection that we'll close after the query — keeps attached
    // state out of the per-report connCache.
    db = new Database(dsRow.connection, { readonly: true, fileMustExist: true });
    for (const a of attaches!) {
      // SQLite ATTACH doesn't accept ? bindings. Connection paths are
      // controlled by us (DataSource.connection column); aliases are
      // regex-validated by the schema. Belt-and-braces: escape single
      // quotes in the path per SQLite literal-quoting.
      const safePath = a.connection.replace(/'/g, "''");
      db.exec(`ATTACH DATABASE '${safePath}' AS ${a.alias}`);
    }
  } else {
    db = connCache.get(ds.dataSourceId);
    if (!db) {
      db = new Database(dsRow.connection, { readonly: true, fileMustExist: true });
      connCache.set(ds.dataSourceId, db);
    }
  }

  try {
    const bound = bindParams(ds.sql, params);
    const stmt = db.prepare(ds.sql);
    return stmt.all(bound) as Row[];
  } finally {
    if (hasAttaches) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

/** A resolved attach (foreign source) ready for the runner to ATTACH. */
type ResolvedAttach = {
  alias: string;
  connection: string;
  /** Used by provenance — display name + kind for the proof popover. */
  name: string;
  kind: string;
};

// ---------- Named-parameter translation (shared by all SQL drivers) ----------

// One scanner for `:name` placeholders, shared by the three dialect
// translators below. They used to be three copies of the same regex walk
// differing only in the emitted placeholder, so every edge-case fix (like
// the `::` cast rule) had to be applied three times.
//

// ---------- SQL driver (Postgres) ----------

/**
 * Translate SQLite-style `:name` placeholders into Postgres-style `$1, $2, ...`
 * ordered binds. Keeps query authors writing portable SQL — same `:name`
 * syntax works against sqlite/excel and postgres.
 *
 * Returns the rewritten SQL plus the values array in $-position order. Each
 * named param can be referenced multiple times; we de-duplicate so the same
 * value goes to the same $N (smaller wire payload + idiomatic).
 */
function translateNamedToPositional(
  sql: string,
  params: Record<string, unknown>,
): { sql: string; values: unknown[]; missing: string[] } {
  const indexByName = new Map<string, number>();
  const values: unknown[] = [];
  const { sql: rewritten, missing } = rewriteNamedParams(sql, params, (name) => {
    let i = indexByName.get(name);
    if (i == null) {
      values.push(params[name]);
      i = values.length;
      indexByName.set(name, i);
    }
    return "$" + i;
  });
  return { sql: rewritten, values, missing };
}

async function runOnPostgres(
  ds: DataSourceDef,
  dsRow: { connection: string },
  connCache: Map<string, any>,
  params: Record<string, unknown>,
): Promise<Row[]> {
  if (!ds.sql) throw new Error(`Query "${ds.name}" has no sql`);
  assertSelectOnly(ds.sql);
  const stored = decodePgConnection(dsRow.connection);
  // Cache one pg.Client per source for the lifetime of one report run, just
  // like the sqlite path. The shared connCache stores PgClient instances
  // alongside better-sqlite3 ones — distinguished by kind, not type.
  let client: PgClient | undefined = connCache.get(ds.dataSourceId);
  if (!client) {
    client = new PgClient(resolvePgClientConfig(stored));
    await client.connect();
    connCache.set(ds.dataSourceId, client);
  }
  const { sql, values, missing } = translateNamedToPositional(ds.sql, params);
  if (missing.length > 0) {
    throw new Error(`Missing parameter${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  }
  const result = await client.query(sql, values);
  return result.rows as Row[];
}

// ---------- SQL driver (MySQL) ----------


async function runOnMysql(
  ds: DataSourceDef,
  dsRow: { connection: string },
  connCache: Map<string, any>,
  params: Record<string, unknown>,
): Promise<Row[]> {
  if (!ds.sql) throw new Error(`Query "${ds.name}" has no sql`);
  assertSelectOnly(ds.sql);
  const stored = decodeMyConnection(dsRow.connection);
  let conn = connCache.get(ds.dataSourceId);
  if (!conn) {
    conn = await createMyConnection(resolveMyClientConfig(stored));
    connCache.set(ds.dataSourceId, conn);
  }
  const { sql, values, missing } = translateNamedToQuestionMark(ds.sql, params);
  if (missing.length > 0) {
    throw new Error(`Missing parameter${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  }
  const [rows] = await conn.query(sql, values);
  // mysql2 returns OkPacket for non-SELECT, but assertSelectOnly already
  // gates that. Cast through unknown so TypeScript stays happy.
  return rows as unknown as Row[];
}



/**
 * Warehouse kinds (Snowflake, BigQuery) are paid connectors: the drivers
 * live in src/ee/connectors and register under DataSource.kind. Community
 * has no entry, so the kind is simply unsupported in that edition.
 */
async function runOnWarehouse(
  ds: DataSourceDef,
  dsRow: { kind: string; connection: string },
  connCache: Map<string, any>,
  params: Record<string, unknown>,
): Promise<Row[]> {
  const connector = ee.connectors?.warehouses[dsRow.kind];
  if (!connector) throw new Error(`Unsupported data source kind: ${dsRow.kind}`);
  return connector.run(ds, dsRow, connCache, params);
}

// ---------- REST driver ----------

/**
 * REST's counterpart to assertSelectOnly. Every SQL-kind driver is already
 * unconditionally SELECT-only (assertSelectOnly, called above); REST has no
 * such built-in restriction — a report's DataSourceDef.method can be any of
 * GET/POST/PUT/PATCH/DELETE. This is what makes DataSource.readOnly actually
 * do something: when set, only GET is allowed against this connection,
 * regardless of what any individual report's query definition asks for.
 */
export function assertRestMethodAllowed(method: string, readOnly: boolean | null | undefined): void {
  if (readOnly && method.toUpperCase() !== "GET") {
    throw new Error(`This REST connection is marked read-only; only GET requests are allowed (got ${method.toUpperCase()}).`);
  }
}

/**
 * `connection` for a REST data source is JSON:
 *   { "baseUrl": "https://api.example.com", "headers": { "Authorization": "Bearer ..." } }
 *
 * Per-query fields come from DataSourceDef:
 *   method, path (with :name placeholders), body (JSON string with {{param.x}} interpolation),
 *   jsonPath (dotted path into the response to find the rows array).
 */
async function runOnRest(ds: DataSourceDef, dsRow: { connection: string; readOnly?: boolean | null }, params: Record<string, unknown>): Promise<Row[]> {
  assertRestMethodAllowed((ds.method ?? "GET").toUpperCase(), dsRow.readOnly);
  // decodeRestConnection + resolveRestHeaders (not a raw JSON.parse) — headers
  // are stored encrypted (headersEnc) by encodeRestConnection; a bare
  // JSON.parse().headers only ever sees the legacy plaintext shape, which is
  // empty on every connection created since encryption landed. That silently
  // dropped any connection-level auth header (Bearer token, API key) on
  // every real report run — the test/probe routes already decrypt correctly
  // via this same helper, only this execution path had drifted.
  let conn: { baseUrl: string; headers: Record<string, string> };
  try {
    const stored = decodeRestConnection(dsRow.connection);
    conn = { baseUrl: stored.baseUrl, headers: resolveRestHeaders(stored) };
  } catch (e: any) {
    throw new Error(`REST DataSource "${ds.dataSourceId}" has invalid connection: ${e?.message ?? "unknown error"}`);
  }

  // Substitute :name in path with URL-encoded parameter values.
  const path = (ds.path ?? "").replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name) => {
    if (!(name in params)) throw new Error(`Missing parameter: ${name}`);
    return encodeURIComponent(String(params[name]));
  });

  const url = new URL(joinRestUrl(conn.baseUrl, path));
  // Unused params ride along as querystring for GETs (common convention).
  const usedInPath = new Set<string>();
  (ds.path ?? "").replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, n) => { usedInPath.add(n); return _m; });
  if ((ds.method ?? "GET") === "GET") {
    for (const [k, v] of Object.entries(params)) {
      if (v == null || v === "" || usedInPath.has(k)) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = { Accept: "application/json", ...(conn.headers ?? {}), ...(ds.headers ?? {}) };
  const method = (ds.method ?? "GET").toUpperCase();
  let body: string | undefined;
  if (method !== "GET" && ds.body) {
    body = interpolatePure(ds.body, { params });
    if (!("Content-Type" in headers || "content-type" in headers)) {
      headers["Content-Type"] = "application/json";
    }
  }

  // guardedFetch validates the URL (and every redirect hop) against the
  // SSRF guard — see lib/security/ssrfGuard.ts.
  const res = await guardedFetch(url.toString(), { method, headers, body });
  if (!res.ok) throw new Error(`REST ${method} ${url} -> ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const rows = pluck(json, ds.jsonPath);

  if (Array.isArray(rows)) return rows as Row[];
  if (rows && typeof rows === "object") return [rows as Row]; // single-object responses wrap as one row
  return [];
}

// ---------- Top-level dispatch ----------

export async function runReport(ctx: RunContext): Promise<Dataset> {
  const { dataset } = await runReportWithProof(ctx);
  return dataset;
}

/**
 * Run every query in the report and return both rows AND a provenance
 * record per query (query hash, data hash, timestamp, duration, row count).
 * Callers that surface trust/audit UI should use this variant.
 */
export async function runReportWithProof(ctx: RunContext): Promise<RunResult> {
  const { report, params, viewer } = ctx;
  const dataset: Dataset = {};
  const provenance: ProvenanceMap = {};

  // Cache sqlite connections so we don't reopen for each query on the same source.
  const connCache = new Map<string, any>();

  // curf_report_run_ms (Harness 11 / docs/SLO.md "Viewer p95 load"). Tenant
  // is taken from the first DataSource resolved below — this function has
  // no tenantId of its own, and every dataSourceId in a report belongs to
  // the same tenant as the report.
  const metricStartedAt = Date.now();
  let metricTenant = "unknown";

  try {
    // Topo-sort so any query referenced via joins[] runs before its consumer.
    // Cycles throw; missing references throw with a clean message that
    // points at the offending alias.
    const ordered = topoSortQueries(report.dataSources).map((d) =>
      ctx.forExport ? liftPreviewLimit(d) : d,
    );
    for (const ds of ordered) {
      const dsRow = await prisma.dataSource.findUnique({ where: { id: ds.dataSourceId } });
      if (!dsRow) throw new Error(`DataSource not found: ${ds.dataSourceId}`);
      if (metricTenant === "unknown") metricTenant = dsRow.tenantId;

      // Visibility check (defense-in-depth). When a viewer identity is
      // supplied AND they can't see this source, return empty rows + a
      // proof note explaining why. Better UX than a hard error: the rest
      // of the report still renders, blocks bound to this query show
      // empty/zero, and the proof badge tells the user what happened.
      if (viewer && !canSeeDataSource(dsRow, viewer)) {
        dataset[ds.id] = [];
        provenance[ds.id] = buildProvenance({
          ds,
          rows: [],
          params,
          dataSourceName: dsRow.name,
          dataSourceKind: dsRow.kind,
          startedAt: Date.now(),
          accessDeniedNote: "Hidden by visibility — you don't have access to this source.",
        });
        continue;
      }

      // Resolve cross-source ATTACHes (Tier 1 cross-source JOIN). For each
      // foreign source: enforce the same tenant + visibility ACL, refuse
      // unless it's also a file-backed kind, then hand the runner a tuple
      // of (alias, connection path) to splice into ATTACH DATABASE.
      let resolvedAttaches: ResolvedAttach[] | undefined;
      const attachInputs = ds.attaches ?? [];
      if (attachInputs.length > 0) {
        if (dsRow.kind !== "sqlite" && dsRow.kind !== "excel") {
          dataset[ds.id] = [];
          provenance[ds.id] = buildProvenance({
            ds, rows: [], params,
            dataSourceName: dsRow.name, dataSourceKind: dsRow.kind, startedAt: Date.now(),
            accessDeniedNote: `Cross-source ATTACH only works when the primary source is sqlite or excel; this query's primary is "${dsRow.kind}".`,
          });
          continue;
        }
        resolvedAttaches = [];
        let blocked = false;
        for (const a of attachInputs) {
          const foreign = await prisma.dataSource.findUnique({ where: { id: a.dataSourceId } });
          if (!foreign || foreign.tenantId !== dsRow.tenantId) {
            blocked = true;
            provenance[ds.id] = buildProvenance({
              ds, rows: [], params,
              dataSourceName: dsRow.name, dataSourceKind: dsRow.kind, startedAt: Date.now(),
              accessDeniedNote: `Attached source "${a.alias}" is missing or belongs to another tenant.`,
            });
            break;
          }
          if (foreign.kind !== "sqlite" && foreign.kind !== "excel") {
            blocked = true;
            provenance[ds.id] = buildProvenance({
              ds, rows: [], params,
              dataSourceName: dsRow.name, dataSourceKind: dsRow.kind, startedAt: Date.now(),
              accessDeniedNote: `Attached source "${a.alias}" is kind "${foreign.kind}" — only sqlite and excel can be ATTACHed.`,
            });
            break;
          }
          if (viewer && !canSeeDataSource(foreign, viewer)) {
            blocked = true;
            provenance[ds.id] = buildProvenance({
              ds, rows: [], params,
              dataSourceName: dsRow.name, dataSourceKind: dsRow.kind, startedAt: Date.now(),
              accessDeniedNote: `Attached source "${a.alias}" is hidden by visibility — you don't have access.`,
            });
            break;
          }
          resolvedAttaches.push({
            alias: a.alias,
            connection: foreign.connection,
            name: foreign.name,
            kind: foreign.kind,
          });
        }
        if (blocked) {
          dataset[ds.id] = [];
          continue;
        }
      }

      const startedAt = Date.now();

      // Cache eligibility: only when there are no cross-source attaches or
      // joins (those depend on sibling rows or foreign DBs we don't key on),
      // not REST (rows come from a third-party URL we don't control), and
      // not when the caller passed cacheBust. We key by (tenant, source,
      // sql, params); see lib/reporting/queryCache.ts for the safety notes.
      const hasFan = (resolvedAttaches && resolvedAttaches.length > 0) || (ds.joins && ds.joins.length > 0);
      const cacheable = !!ds.sql && dsRow.kind !== "rest" && !hasFan && !ctx.cacheBust;
      // The TypeScript flow analyzer can't follow that the switch below
      // either assigns or throws on the default branch, so we leave `rows`
      // optional during the assignment phase and assert after.
      let rows: Row[] | undefined;
      // Set on a cache hit so buildProvenance() below can reuse it instead
      // of re-hashing every row — see queryCache.ts's CacheEntry.dataHash.
      let cachedDataHash: string | undefined;
      if (cacheable) {
        const hit = getCachedRows({
          tenantId: dsRow.tenantId,
          dataSourceId: ds.dataSourceId,
          sql: ds.sql!,
          params,
        });
        if (hit) {
          rows = hit.rows;
          cachedDataHash = hit.dataHash;
        }
      }

      // Track per-query execution failures so a single bad source doesn't
      // 500 the whole report. The original behaviour was to throw out of
      // the whole loop — that meant one unreachable Postgres took down a
      // report whose other queries were perfectly fine. Now: catch, set
      // empty rows, attach the message to provenance, continue.
      let executionError: string | undefined;

      if (rows === undefined) {
        try {
          switch (dsRow.kind) {
            case "sqlite":
            // Excel imports are stored as a per-tenant SQLite file; the runner
            // path is identical once the file exists. See lib/connections/excelImport.ts.
            case "excel":
              rows = runOnSqlite(ds, dsRow, connCache, params, resolvedAttaches);
              break;
            case "lake":
              // Curf Tables (Phase 1 managed table store). The lake file is
              // addressed by the DataSource row's OWN tenantId — never by the
              // `connection` string, which is a human-readable label that can
              // be stale. Cloning a workspace (starter pack) copies the source
              // tenant's `lake://<id>` verbatim, so trusting it made every new
              // workspace read another tenant's lake: reports came up empty,
              // and same-named tables would have served the other tenant's rows.
              rows = runOnSqlite(
                ds,
                { ...dsRow, connection: tenantLakePath(dsRow.tenantId) },
                connCache, params, resolvedAttaches,
              );
              break;
            case "postgres":
              rows = await runOnPostgres(ds, dsRow, connCache, params);
              break;
            case "mysql":
              rows = await runOnMysql(ds, dsRow, connCache, params);
              break;
            case "rest":
              rows = await runOnRest(ds, dsRow, params);
              break;
            default:
              rows = await runOnWarehouse(ds, dsRow, connCache, params);
          }
          // Persist to the cache only on a true miss for an eligible query.
          // We pass durationMs so the metrics page can credit the hits with
          // the cumulative ms saved. Hash once here and reuse it for
          // buildProvenance() below AND for the cache entry, so a future
          // cache hit skips re-hashing every row too, not just the query.
          if (cacheable) {
            cachedDataHash = hashRows(rows!);
            setCachedRows({
              tenantId: dsRow.tenantId,
              dataSourceId: ds.dataSourceId,
              sql: ds.sql!,
              params,
              rows: rows!,
              dataHash: cachedDataHash,
              durationMs: Date.now() - startedAt,
            });
          }
        } catch (e: any) {
          // One source choked. Don't propagate — produce a record that
          // lets the rest of the report render and tells consumers what
          // went wrong on this query specifically.
          executionError = (e?.message ?? String(e)).slice(0, 500);
          // Useful in dev logs even though it's also in provenance.
          // eslint-disable-next-line no-console
          console.warn(`[runner] query "${ds.name}" failed: ${executionError}`);
          rows = [];
        }
      }
      if (rows === undefined) {
        // Unreachable in practice — the switch + catch above always settle
        // rows to an array. Keeps TS satisfied.
        rows = [];
      }
      // Cross-source hash JOIN (Tier 2). After the primary query runs, walk
      // ds.joins[] (each entry references a sibling DataSourceDef in the
      // same report). Topo sort ensures every referenced sibling has already
      // run, so we can pull its rows from `dataset` and merge in Node.
      //
      // Each referenced sibling appears once in attachedSources for the proof
      // popover. The hash-join engine handles left/inner semantics + a
      // MAX_MERGED_ROWS cap.
      const joinSpecs = ds.joins ?? [];
      const joinedSourcesForProof: Array<{ name: string; kind: string; alias: string }> = [];
      // Skip joins entirely if the primary query failed — joining on []
      // produces [], but we'd rather record the original error against the
      // primary and not muddle it with a "join sibling missing" follow-up.
      if (joinSpecs.length > 0 && !executionError) {
        for (const j of joinSpecs) {
          const sibling = report.dataSources.find((q) => q.id === j.queryId);
          if (!sibling) {
            executionError = `Cross-source join on "${ds.name}": sibling query "${j.queryId}" not found`;
            break;
          }
          const rightRows = dataset[sibling.id];
          if (!rightRows) {
            // Topo sort should have run it; treat missing as empty so we
            // don't crash a partially-loaded report.
            continue;
          }
          const merged = hashJoin(rows, rightRows, {
            type: j.type,
            leftKey: j.on.left,
            rightKey: j.on.right,
            alias: j.alias,
          });
          rows = merged.rows;

          // Resolve sibling's source for the proof popover.
          const siblingDsRow = await prisma.dataSource.findUnique({ where: { id: sibling.dataSourceId } });
          if (siblingDsRow) {
            joinedSourcesForProof.push({
              name: siblingDsRow.name,
              kind: siblingDsRow.kind,
              alias: j.alias,
            });
          }
        }
      }

      dataset[ds.id] = rows;
      provenance[ds.id] = buildProvenance({
        ds, rows, params,
        dataSourceName: dsRow.name,
        dataSourceKind: dsRow.kind,
        startedAt,
        executionError,
        // Reuse the hash computed on the cache hit/miss above instead of
        // paying for another full hashRows() pass. Safe unconditionally:
        // `cacheable` (and therefore `cachedDataHash`) requires !hasFan, so
        // whenever this is set, the join loop above never touched `rows`.
        dataHash: cachedDataHash,
        // Tag the proof popover with every additional source — both
        // SQLite-ATTACHed (Tier 1) and hash-joined (Tier 2).
        attachedSources: [
          ...(resolvedAttaches?.map((a) => ({ name: a.name, kind: a.kind, alias: a.alias })) ?? []),
          ...joinedSourcesForProof,
        ],
      });
    }
  } finally {
    await closeCachedConnections(connCache);
    reportRunMs.observe?.({ tenant: metricTenant }, Date.now() - metricStartedAt);
  }

  return { dataset, provenance };
}

/**
 * Topologically sort report.dataSources so any query referenced via joins[]
 * comes before its consumer. Throws on cycles (A.joins[B] + B.joins[A]) and
 * on dangling references (queryId points at nothing in the same report).
 *
 * Stable for inputs with no joins — preserves the original order, which
 * keeps existing reports' execution order unchanged.
 */
function topoSortQueries(queries: DataSourceDef[]): DataSourceDef[] {
  const byId = new Map(queries.map((q) => [q.id, q]));
  const result: DataSourceDef[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(q: DataSourceDef) {
    if (visited.has(q.id)) return;
    if (visiting.has(q.id)) {
      throw new Error(`Cross-source join cycle detected at query "${q.name}" (id="${q.id}").`);
    }
    visiting.add(q.id);
    for (const j of q.joins ?? []) {
      const dep = byId.get(j.queryId);
      if (!dep) {
        throw new Error(`Cross-source join on "${q.name}" references missing query id "${j.queryId}".`);
      }
      visit(dep);
    }
    visiting.delete(q.id);
    visited.add(q.id);
    result.push(q);
  }

  for (const q of queries) visit(q);
  return result;
}

/**
 * Close every cached connection. Both kinds end up in the same map but
 * better-sqlite3 has sync `.close()` while pg.Client has async `.end()`.
 * Best-effort: errors are swallowed so cleanup doesn't shadow the original
 * (more interesting) error from the query path.
 */
async function closeCachedConnections(cache: Map<string, any>): Promise<void> {
  for (const c of cache.values()) {
    try {
      if (typeof c?.end === "function") {
        await c.end();
      } else if (typeof c?.close === "function") {
        c.close();
      }
    } catch { /* ignore */ }
  }
}

// interpolate() lives in its own pure module so client components can use it
// without pulling better-sqlite3 into the browser bundle. Re-exported so
// existing server-side call sites (docx renderer etc.) keep working unchanged.
export { interpolate } from "@/lib/reporting/interpolate";


/**
 * Execute a single query definition. Used by the "Run query" button in the
 * designer's Queries tab so users can verify results before binding blocks.
 * Mirrors the dispatch logic in `runReport` but for one DataSourceDef.
 *
 * Cross-source ATTACHes resolve here too — the designer can preview a JOIN
 * that spans sqlite + excel before saving the report. Tenant scope is the
 * authority; designer is admin-gated upstream so we don't run an extra
 * per-user visibility check here (see runReportWithProof for that).
 */
export async function runSingleQuery(
  ds: DataSourceDef,
  params: Record<string, unknown>
): Promise<Row[]> {
  const dsRow = await prisma.dataSource.findUnique({ where: { id: ds.dataSourceId } });
  if (!dsRow) throw new Error(`DataSource not found: ${ds.dataSourceId}`);

  // Resolve attaches if any. Same kind/tenant guards as runReportWithProof.
  let resolvedAttaches: ResolvedAttach[] | undefined;
  const attachInputs = ds.attaches ?? [];
  if (attachInputs.length > 0) {
    if (dsRow.kind !== "sqlite" && dsRow.kind !== "excel") {
      throw new Error(`Cross-source ATTACH requires the primary source to be sqlite or excel; got "${dsRow.kind}".`);
    }
    resolvedAttaches = [];
    for (const a of attachInputs) {
      const foreign = await prisma.dataSource.findUnique({ where: { id: a.dataSourceId } });
      if (!foreign || foreign.tenantId !== dsRow.tenantId) {
        throw new Error(`Attached source "${a.alias}" is missing or belongs to another tenant.`);
      }
      if (foreign.kind !== "sqlite" && foreign.kind !== "excel") {
        throw new Error(`Attached source "${a.alias}" is kind "${foreign.kind}" — only sqlite and excel can be ATTACHed.`);
      }
      resolvedAttaches.push({ alias: a.alias, connection: foreign.connection, name: foreign.name, kind: foreign.kind });
    }
  }

  switch (dsRow.kind) {
    case "sqlite":
    // Excel imports route through the SQLite path (per-tenant .db file).
    case "excel": {
      const cache = new Map<string, any>();
      try {
        return runOnSqlite(ds, dsRow, cache, params, resolvedAttaches);
      } finally {
        await closeCachedConnections(cache);
      }
    }
    case "lake": {
      const cache = new Map<string, any>();
      try {
        // Address the lake by the row's own tenantId — see the note on the
        // other "lake" branch above.
        return runOnSqlite(
          ds,
          { ...dsRow, connection: tenantLakePath(dsRow.tenantId) },
          cache, params, resolvedAttaches
        );
      } finally {
        await closeCachedConnections(cache);
      }
    }
    case "postgres": {
      const cache = new Map<string, any>();
      try {
        return await runOnPostgres(ds, dsRow, cache, params);
      } finally {
        await closeCachedConnections(cache);
      }
    }
    case "mysql": {
      const cache = new Map<string, any>();
      try {
        return await runOnMysql(ds, dsRow, cache, params);
      } finally {
        await closeCachedConnections(cache);
      }
    }
    case "rest":
      return await runOnRest(ds, dsRow, params);
    default:
      // Snowflake / BigQuery open their own sessions per query, so the
      // one-shot cache is only for signature symmetry.
      return await runOnWarehouse(ds, dsRow, new Map<string, any>(), params);
  }
}

