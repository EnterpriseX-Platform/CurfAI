/**
 * Table-level ACL + column-level redaction enforcement for surfaces that
 * run free-form (viewer-authored) SQL directly against a tenant's lake —
 * Notebook SQL cells, Data Quality's custom_sql check, the Agent's
 * query_lake tool, and the Activation runner's lake source.
 *
 * Those surfaces don't know in advance which table(s) a query touches the
 * way `/api/lake/tables/[name]` does, so they historically skipped
 * `canRead()`/`applyRedaction()` entirely — a query against an "owner_only"
 * or role-restricted table, or one with PII-tagged columns, ran unchecked.
 * This closes that gap the same simple way `findLikelyDuplicateRealTable()`
 * matches table names elsewhere in this codebase: substring/word-boundary
 * matching against the tenant's own (small, known) table list, not a real
 * SQL parser. That's deliberately conservative — a name that merely
 * *looks* referenced can still deny a query that doesn't actually touch
 * it, but nothing genuinely reachable through an ACL-restricted table
 * slips through unnoticed.
 */
import { prisma } from "@/lib/db";
import { canRead, loadRoleSlugs, type LakeViewer } from "./acl";
import { applyRedaction, type RedactionViewer } from "./redaction";
import type { LakeColumn } from "./tables";
import { parseSchemaJson } from "./schemaGovernance";

export type SqlAccessViewer = { id: string; tenantId: string; role: string };

export type SqlAccessResult =
  | { ok: true; schema: LakeColumn[] }
  | { ok: false; error: string };

/**
 * Word-boundary match — good enough to catch every real reference (a
 * table name appears as its own token in FROM/JOIN, quoted or bare) while
 * staying immune to the identifier-injection concerns a full SQL parser
 * would introduce. Anchored so "loan" doesn't match "loan_portfolio".
 *
 * Exported so `dateColumnNames.ts` can reuse the exact same "does this SQL
 * touch this table" rule to decide which typed date columns are safe to
 * reformat in a DuckDB result, and so `sourceGovernance.ts` can agree with
 * this file on which tables (and, for its fail-closed rule, which column
 * names) a query touches — three different concerns from this file's own
 * ACL/redaction one, but the same underlying question.
 */
export function referencesTable(sql: string, tableName: string): boolean {
  const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}($|[^A-Za-z0-9_])`, "i").test(sql);
}

/**
 * Check whether `viewer` may run `sql` against their tenant's lake, and
 * return the merged schema (across every table the query references) for
 * the caller to redact the result rows with afterward. Denies the whole
 * query if it references even one table the viewer can't read — a
 * partial-redaction "run it anyway" isn't safe when the query can already
 * cross-join or subquery around a plain column mask.
 */
export async function checkSqlAccess(opts: {
  tenantId: string;
  sql: string;
  viewer: SqlAccessViewer;
}): Promise<SqlAccessResult> {
  const tables = await prisma.lakeTable.findMany({
    where: { tenantId: opts.tenantId },
    select: { name: true, ownerUserId: true, visibleToRolesJson: true, schemaJson: true },
  });
  const referenced = tables.filter((t) => referencesTable(opts.sql, t.name));
  if (referenced.length === 0) return { ok: true, schema: [] };

  const roleSlugs = await loadRoleSlugs(opts.viewer.id, opts.tenantId);
  const lakeViewer: LakeViewer = { id: opts.viewer.id, tenantId: opts.tenantId, role: opts.viewer.role, roleSlugs };

  const schema: LakeColumn[] = [];
  for (const t of referenced) {
    if (!canRead(lakeViewer, { ownerUserId: t.ownerUserId, visibleToRolesJson: t.visibleToRolesJson, tenantId: opts.tenantId })) {
      return { ok: false, error: `You don't have access to table "${t.name}".` };
    }
    // A malformed schema cache parses to [] — nothing to redact for this table.
    schema.push(...parseSchemaJson(t.schemaJson));
  }
  return { ok: true, schema };
}

/** Convenience wrapper: check access, then redact `rows` in place if allowed. */
export async function checkAccessAndRedact(opts: {
  tenantId: string;
  sql: string;
  viewer: SqlAccessViewer;
  rows: Array<Record<string, unknown>>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await checkSqlAccess(opts);
  if (!result.ok) return result;
  if (result.schema.length > 0) {
    const roleSlugs = await loadRoleSlugs(opts.viewer.id, opts.tenantId);
    const redactionViewer: RedactionViewer = { id: opts.viewer.id, role: opts.viewer.role, roleSlugs };
    applyRedaction(opts.rows, result.schema, redactionViewer);
  }
  return { ok: true };
}
