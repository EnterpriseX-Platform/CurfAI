/**
 * Inherit column-level redaction tags from SOURCE lake tables into the DERIVED
 * lake tables built from them — materialized-view outputs (`mv_<name>`) and
 * pipeline step outputs.
 *
 * Why: redaction (redaction.ts) is enforced from the tags in the catalog row of
 * the table being READ. A derived table is written from freshly inferred
 * columns, so it starts with no tags; a viewer who may not see
 * `customers.email` raw could read the same values out of
 * `SELECT email FROM customers` materialized as `mv_emails` (PII laundering
 * through a view). Tags an admin sets on the derived table itself survive a
 * rewrite (schemaGovernance.ts); this module adds the missing half — tags that
 * flow in from what the table was derived FROM.
 *
 * THE RULE
 *
 *  Sources. The tenant's lake tables the SQL references, found with
 *  sqlAccess.ts's referencesTable() — the very matcher the read path uses to
 *  decide whose tags to enforce, so write and read agree on "what this query
 *  touches" (and it needs no SQL parser; it over-matches, which here only ever
 *  ADDS restriction). A source that is itself derived carries its own inherited
 *  tags in its catalog row, so a view over a view, or a pipeline step reading
 *  an earlier step's output, inherits transitively.
 *
 *  R1 — same name (binding, on every write). An output column takes the tags of
 *  the same-named column (case-insensitive) in each referenced source, which is
 *  exactly how the read path masks (applyRedaction() works by output column
 *  name across every referenced table's schema). Several tagged sources:
 *  the allowlist is the INTERSECTION of theirs (an inherited tag never grants
 *  a role access the source withheld; an empty result = nobody, the same
 *  default-deny a missing allowlist means) and the label is the most severe.
 *  The label only picks the mask text; who can see the value is decided by the
 *  allowlist alone.
 *
 *  Own tags. The derived table's own tags (an admin's, or ones inherited on an
 *  earlier write) are combined the same way, never overwritten: the result is
 *  never looser than either input. So inheritance can only add restriction, and
 *  is idempotent. It is also sticky — a restriction is not lifted when the
 *  source is later loosened, and clearing the tag on a derived column whose
 *  source is still tagged is undone by the next write. To declassify, declassify
 *  the source (then clear the derived tag once).
 *
 *  R2 — fail closed on a column we cannot match by name. An alias
 *  (`email AS contact`), expression (`lower(email)`) or aggregate
 *  (`MAX(email)`) produces a name no source has. When such a column is NEW to
 *  the derived table (absent from its previous catalog schema) and the SQL
 *  mentions a tagged source column by name, it is tagged with the combined
 *  restriction of the tagged columns mentioned. This is deliberately once, at
 *  the column's first appearance: a false positive (`COUNT(email) AS n` masked
 *  as pii) can be cleared through the sensitivity route and stays cleared on
 *  later refreshes.
 *
 *  UX cost of R2, stated plainly: it is a name-token heuristic, so a column that
 *  merely mentions a tagged column — a count, or a WHERE/JOIN on it — starts
 *  masked for non-admins until someone clears it. Numeric columns masked with a
 *  text mask can break a chart. That is the price of failing closed; the
 *  alternative (leave aliases untagged) leaks the value instead of hiding a
 *  count.
 *
 * KNOWN GAPS (not closed here)
 *  - R2 is first-appearance only: repointing an EXISTING derived column at a
 *    tagged source under a new expression is not re-flagged. Builders can also
 *    clear tags themselves (the sensitivity route only needs canBuild on a
 *    tenant-wide table), so this is not a defence against a deliberate
 *    builder; it covers the accidental case, which is what leaks in practice.
 *  - A column built from a tagged one without spelling its name (whole-row
 *    functions such as to_json(t)) is not detected.
 *
 * TABLE-LEVEL ACL INHERITANCE (owner_only / visibleToRoles, acl.ts)
 *
 *  A separate mechanism from the column-level tags above, gating whether the
 *  derived TABLE shows up for a viewer at all (Tables browser, catalog list)
 *  rather than which of its columns are masked. Previously not inherited: an
 *  MV over an owner_only or role-restricted source table was tenant-wide once
 *  materialized, visible to every member regardless of the source's own ACL.
 *
 *  Rule — applied ONCE PER WRITE, only while the derived table is currently
 *  open (no ownerUserId, no visibleToRoles); an already-restricted derived
 *  table is left exactly as it is, whether that restriction came from an
 *  admin or an earlier inheritance run. Same "to declassify, declassify the
 *  source" stickiness column tags already document: reopening the derived
 *  table by hand while its source is STILL restricted just gets it
 *  re-inherited on the next write (there is no stored flag distinguishing
 *  "never restricted" from "an admin deliberately reopened it"), so the only
 *  durable way to open a derived table back up is to loosen the source too.
 *
 *   - No restricted source → untouched.
 *   - Every restricted source shares the exact same restriction (one
 *     owner_only owner, or role lists that combine losslessly — see below) →
 *     the derived table gets that restriction.
 *   - `owner_only` sources: all must name the SAME owner (that's the only way
 *     to express "only someone who could already see every source" with a
 *     single ownerUserId column) — propagates that owner. Two owner_only
 *     sources with DIFFERENT owners means literally nobody could satisfy
 *     both; see the deny-all case below.
 *   - `roles` sources: the derived table's roles become the INTERSECTION of
 *     every restricted source's role list (a viewer needs a role in that
 *     intersection to be guaranteed to pass every source's own check) —
 *     same "narrows, never widens" idea as the column-level allowlist merge.
 *   - Mixed owner_only + roles sources, or an empty role intersection: there
 *     is no single ACL-row shape that expresses "must satisfy an owner check
 *     AND a role check simultaneously", so this fails closed to DENY_ALL — an
 *     owner_only row pointed at a sentinel id no real user can ever have
 *     (`acl.ts`'s canRead compares by strict equality, so this is "nobody",
 *     not "tenant-wide" the way an empty roles array would otherwise decode
 *     to — see decodeMode's own fallback). An admin who hits this can always
 *     loosen the derived table's ACL by hand afterward.
 */
import { prisma } from "@/lib/db";
import { mergeGovernanceMetadata, parseSchemaJson, combine, restrictionOf, type Restriction } from "./schemaGovernance";
import { referencesTable } from "./sqlAccess";
import { decodeMode, type LakeAclMode } from "./acl";
import type { LakeColumn } from "./tables";

/** Not a real cuid `LakeTable.ownerUserId` will ever equal — acl.ts's canRead
 *  is a strict-equality owner check, so this denies every real viewer. */
export const TABLE_ACL_DENY_ALL_SENTINEL = "__no_viewer_satisfies_every_source__";

export type SourceTable = {
  name: string;
  columns: LakeColumn[];
  ownerUserId: string | null;
  visibleToRolesJson: string;
};

function restrict(col: LakeColumn, by: Restriction): LakeColumn {
  const merged = combine(restrictionOf(col), by)!;
  return { ...col, sensitivity: merged.sensitivity, unredactedForRoles: merged.roles };
}

/**
 * Apply R1 + R2 (see the header) to `columns`, which must already carry the
 * derived table's own tags. Pure. Never loosens a column.
 */
export function inheritSourceGovernance(opts: {
  columns: LakeColumn[];
  sources: SourceTable[];
  sql: string;
  /** Column names the derived table had before this write; R2 skips these. */
  priorColumnNames: Iterable<string>;
}): LakeColumn[] {
  const sourceColumns = opts.sources.flatMap((s) => s.columns);
  const tagged = sourceColumns.filter((c) => c.sensitivity);
  if (tagged.length === 0) return opts.columns;

  const sourceByName = new Map<string, LakeColumn[]>();
  for (const c of sourceColumns) {
    const key = c.name.toLowerCase();
    sourceByName.set(key, [...(sourceByName.get(key) ?? []), c]);
  }
  // R2 pool: tagged source columns whose name the SQL spells out (same
  // word-boundary token match the read path uses for table names).
  const mentioned = tagged
    .filter((c) => referencesTable(opts.sql, c.name))
    .map(restrictionOf)
    .reduce<Restriction | null>(combine, null);
  const prior = new Set([...opts.priorColumnNames].map((n) => n.toLowerCase()));

  return opts.columns.map((col) => {
    const sameName = sourceByName.get(col.name.toLowerCase());
    if (sameName) {
      const inherited = sameName.map(restrictionOf).reduce<Restriction | null>(combine, null);
      return inherited ? restrict(col, inherited) : col;
    }
    if (mentioned && !prior.has(col.name.toLowerCase())) return restrict(col, mentioned);
    return col;
  });
}

/**
 * The tenant's lake tables `sql` references, with their catalog schemas.
 * Tenant-scoped; a lookup failure throws (a caller that swallowed it would write
 * untagged columns — redaction failing open).
 */
export async function loadDerivationSources(tenantId: string, sql: string): Promise<SourceTable[]> {
  const rows = await prisma.lakeTable.findMany({
    where: { tenantId },
    select: { name: true, schemaJson: true, ownerUserId: true, visibleToRolesJson: true },
  });
  return rows
    .filter((t) => referencesTable(sql, t.name))
    .map((t) => ({
      name: t.name,
      columns: parseSchemaJson(t.schemaJson),
      ownerUserId: t.ownerUserId,
      visibleToRolesJson: t.visibleToRolesJson,
    }));
}

/** A source's own decoded ACL, or null for the unrestricted ("tenant") mode
 *  — null so callers can filter to "only the restricted ones" with a plain
 *  truthy check. */
function restrictionModeOf(s: SourceTable): Exclude<LakeAclMode, { mode: "tenant" }> | null {
  const decoded = decodeMode(s);
  return decoded.mode === "tenant" ? null : decoded;
}

/**
 * Compute the table-level ACL a derived table should inherit from `sources`
 * (see this file's header for the full rule). Pure. Returns null when there
 * is nothing to inherit (no restricted source) — the caller leaves the
 * derived table's own ACL exactly as it is either way.
 */
export function inheritTableAcl(sources: SourceTable[]): { ownerUserId: string | null; visibleToRolesJson: string } | null {
  const restricted = sources.map(restrictionModeOf).filter((m): m is Exclude<LakeAclMode, { mode: "tenant" }> => m !== null);
  if (restricted.length === 0) return null;

  const owners = new Set(restricted.filter((m) => m.mode === "owner_only").map((m) => m.ownerUserId));
  const roleLists = restricted.filter((m) => m.mode === "roles").map((m) => m.roles);

  if (owners.size > 0 && roleLists.length > 0) {
    // Mixed owner_only + roles — no single row can express "both", see header.
    return { ownerUserId: TABLE_ACL_DENY_ALL_SENTINEL, visibleToRolesJson: "[]" };
  }
  if (owners.size > 0) {
    if (owners.size > 1) return { ownerUserId: TABLE_ACL_DENY_ALL_SENTINEL, visibleToRolesJson: "[]" };
    return { ownerUserId: [...owners][0], visibleToRolesJson: "[]" };
  }
  // roleLists.length > 0 — intersect every restricted source's role list.
  const intersection = roleLists.reduce((acc, roles) => acc.filter((r) => roles.includes(r)));
  if (intersection.length === 0) {
    // Empty intersection would decode back to "tenant" (open) per decodeMode's
    // own fallback — that's the opposite of what an empty result here means
    // (nobody satisfies every source), so this needs the same deny-all
    // sentinel rather than an empty roles array.
    return { ownerUserId: TABLE_ACL_DENY_ALL_SENTINEL, visibleToRolesJson: "[]" };
  }
  return { ownerUserId: null, visibleToRolesJson: JSON.stringify(intersection) };
}

/**
 * Apply table-level ACL inheritance to a derived table, ONLY while it's
 * currently open (no restriction of its own — see this file's header for
 * why this never fights an admin's explicit choice). Returns the fields to
 * write, or null when nothing should change (the caller omits them from its
 * upsert `data` entirely, rather than writing null/[] over a real setting).
 */
export async function governDerivedTableAcl(opts: {
  tenantId: string;
  tableName: string;
  sources: SourceTable[];
}): Promise<{ ownerUserId: string | null; visibleToRolesJson: string } | null> {
  const priorRow = await prisma.lakeTable.findUnique({
    where: { tenantId_name: { tenantId: opts.tenantId, name: opts.tableName } },
    select: { ownerUserId: true, visibleToRolesJson: true },
  });
  if (priorRow && decodeMode(priorRow).mode !== "tenant") return null; // already restricted — sticky, don't touch
  return inheritTableAcl(opts.sources);
}

/**
 * The catalog `schemaJson` for a derived table being (re)written from `sql`:
 * `columns` (freshly inferred, so bare) with the table's own existing tags
 * carried over and the tags of its sources inherited on top. Call after the
 * physical write and before the catalog upsert, so the previous catalog row is
 * still the one read here.
 */
export async function governDerivedColumns(opts: {
  tenantId: string;
  tableName: string;
  sql: string;
  columns: LakeColumn[];
}): Promise<LakeColumn[]> {
  const [priorRow, sources] = await Promise.all([
    prisma.lakeTable.findUnique({
      where: { tenantId_name: { tenantId: opts.tenantId, name: opts.tableName } },
      select: { schemaJson: true },
    }),
    loadDerivationSources(opts.tenantId, opts.sql),
  ]);
  const prior = parseSchemaJson(priorRow?.schemaJson);
  return inheritSourceGovernance({
    columns: mergeGovernanceMetadata(prior, opts.columns),
    sources,
    sql: opts.sql,
    priorColumnNames: prior.map((c) => c.name),
  });
}
