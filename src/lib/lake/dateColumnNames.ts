/**
 * Which output column names of a DuckDB query are safe to reformat as a
 * plain `YYYY-MM-DD` date, given the tenant's own declared lake schema.
 *
 * The problem: a `date`-typed lake column is stored as a DuckDB TIMESTAMP
 * (see engine/duckdb.ts's own notes on `duckdbTypeForLakeColumn`) and
 * reads back as a JS `Date` — over JSON that becomes
 * `"2026-03-01T00:00:00.000Z"`, which fails ChartBlock's `smartXLabel`
 * regex (anchored to bare `YYYY-MM-DD`, no time component) and degrades a
 * forecast chart's x-axis labels to `+1, +2` (E1B_PHASE_E_SCOPING_PLAN.md
 * §5.4 — confirmed against a real DuckDB file, not assumed).
 *
 * The fix has to know which output columns actually ARE declared `date`
 * columns before touching them — a blanket "any midnight-UTC Date value
 * is a date" rule at the connection layer (engine/duckdb.ts's
 * sanitizeDuckDbRow, which runs on every row of every query) would also
 * catch a genuine TIMESTAMP that happens to fall exactly at midnight (an
 * event logged at 00:00 UTC, a `DATE_TRUNC('day', …)`), silently dropping
 * its time-of-day. Report SQL is free-form, though — there's no stored
 * "this query reads these tables" list to consult (DataSourceDefSchema
 * carries no `tablesUsed`; that's a Master Builder-only concept) — so this
 * reuses `sqlAccess.ts`'s own conservative "does the SQL text reference
 * this table name" word-boundary match (the same rule that already backs
 * ACL enforcement for free-form lake SQL) to find every table a query
 * COULD touch, then only trusts a column name when every one of those
 * tables agrees it's a `date` column. A name that's `date` in one table
 * and something else in another is left alone rather than guessed.
 */
import { prisma } from "@/lib/db";
import { referencesTable } from "./sqlAccess";
import type { LakeColumn } from "./tables";

type Row = Record<string, unknown>;

/**
 * Column names that are unambiguously `date`-typed across every lake
 * table `sql` could plausibly reference for this tenant. Safe to reformat
 * a matching output column's Date value in the query's result rows.
 */
/**
 * The tenant's table names and schemas, read once a minute rather than on
 * every DuckDB query (audit 2026-09-30, P5) — and forgotten as soon as the
 * lake changes (bustLakeCacheForTenant), so a retyped column is never read
 * with its old type.
 */
const CATALOG_TTL_MS = 60_000;
const catalogCache = new Map<string, { at: number; tables: Array<{ name: string; schemaJson: string }> }>();

async function lakeCatalog(tenantId: string): Promise<Array<{ name: string; schemaJson: string }>> {
  const hit = catalogCache.get(tenantId);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.tables;
  const tables = await prisma.lakeTable.findMany({ where: { tenantId }, select: { name: true, schemaJson: true } });
  catalogCache.set(tenantId, { at: Date.now(), tables });
  return tables;
}

/** Drop the tenant's cached catalog — its tables or their columns just changed. */
export function forgetLakeCatalog(tenantId: string): void {
  catalogCache.delete(tenantId);
}

export async function unambiguousDateColumnNames(tenantId: string, sql: string): Promise<Set<string>> {
  const tables = await lakeCatalog(tenantId);
  const referenced = tables.filter((t) => referencesTable(sql, t.name));
  if (referenced.length === 0) return new Set();

  const typesByName = new Map<string, Set<LakeColumn["type"]>>();
  for (const t of referenced) {
    let cols: LakeColumn[] = [];
    try {
      const parsed = JSON.parse(t.schemaJson || "[]");
      if (Array.isArray(parsed)) cols = parsed;
    } catch { /* malformed schema cache — nothing to learn from this table */ }
    for (const c of cols) {
      if (!c?.name) continue;
      if (!typesByName.has(c.name)) typesByName.set(c.name, new Set());
      typesByName.get(c.name)!.add(c.type);
    }
  }

  const dateNames = new Set<string>();
  for (const [name, types] of typesByName) {
    if (types.size === 1 && types.has("date")) dateNames.add(name);
  }
  return dateNames;
}

/**
 * Reformats every `dateColumnNames` key whose value is a `Date` instance
 * (a DuckDB TIMESTAMP round-trip) to `YYYY-MM-DD`, in place. Only ever
 * called with names `unambiguousDateColumnNames` already vetted, and even
 * then only touches a value that's exactly midnight UTC — a `date` lake
 * column is always cleaned to a bare ISO date before storage (see
 * `cleanForType`/`cleanDateToken`), so a same-named column that isn't
 * exactly midnight is either a real (non-date) timestamp that slipped
 * past the name match, or ingest data that predates this feature; either
 * way it's safer to leave the full instant visible than to truncate it.
 */
export function applyDateColumnFormatting(rows: Row[], dateColumnNames: Set<string>): void {
  if (dateColumnNames.size === 0) return;
  for (const row of rows) {
    for (const name of dateColumnNames) {
      const v = row[name];
      if (v instanceof Date && v.getTime() === Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate())) {
        row[name] = v.toISOString().slice(0, 10);
      }
    }
  }
}
