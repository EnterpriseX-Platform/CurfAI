/**
 * Carry a column's governance metadata across a rewrite of
 * LakeTable.schemaJson.
 *
 * schemaJson is the authoritative home of column-level redaction tags
 * (`sensitivity` / `unredactedForRoles` — see redaction.ts, and the note in
 * api/lake/tables/[name]/route.ts that the catalog row "has the
 * authoritative sensitivity tags") and of Master Builder's `syntheticHint`
 * join hints. None of these can be re-derived from row data, so a caller
 * that rebuilds the array from `inferColumns(sample)` and writes it back
 * silently drops them — for a `pii` column that means a non-admin viewer
 * starts seeing raw values (redaction fails OPEN). Every code path that
 * rewrites schemaJson from freshly inferred columns has to merge through
 * here.
 */
import type { LakeColumn } from "./tables";
import { compileFormula } from "./formula/compile";

const GOVERNANCE_FIELDS = ["sensitivity", "unredactedForRoles", "syntheticHint"] as const;

type Sensitivity = NonNullable<LakeColumn["sensitivity"]>;

/** Least to most severe. Only selects the mask text; the allowlist gates access. */
const SEVERITY: readonly Sensitivity[] = ["pii", "financial", "health", "secret"];

export type Restriction = { sensitivity: Sensitivity; roles: string[] };

export function restrictionOf(col: LakeColumn): Restriction | null {
  return col.sensitivity ? { sensitivity: col.sensitivity, roles: col.unredactedForRoles ?? [] } : null;
}

/** The tighter of two restrictions: most severe label, intersection of allowlists. */
export function combine(a: Restriction | null, b: Restriction | null): Restriction | null {
  if (!a || !b) return a ?? b;
  return {
    sensitivity: SEVERITY.indexOf(a.sensitivity) >= SEVERITY.indexOf(b.sensitivity) ? a.sensitivity : b.sensitivity,
    roles: [...new Set(a.roles.filter((r) => b.roles.includes(r)))],
  };
}

/**
 * A formula column shows what it's worked out from, so it must be masked
 * wherever those columns are: `LEFT(customer_email, 3)` can't hand a viewer
 * the start of an email they may not see. Every masking check reads a
 * column's own tags (redaction.ts), so a formula column's tags are derived
 * and kept in the stored schema itself — the tightest of every column it
 * reads, through any formula columns in between, by the rule derived tables
 * follow (sourceGovernance.ts): the most severe label, only the roles
 * allowed on all of them.
 *
 * Never set by hand (the sensitivity route refuses a formula column), and
 * re-derived on every schema write through mergeGovernanceMetadata and the
 * sensitivity route — so tagging a source column later reaches the formula
 * columns built on it.
 */
export function withFormulaGovernance(schema: LakeColumn[]): LakeColumn[] {
  if (!schema.some((c) => c.formula)) return schema;
  const byName = new Map(schema.map((c) => [c.name, c]));
  const memo = new Map<string, Restriction | null>();

  /** The restriction a column effectively carries: its own, or — for a formula column — its inputs'. */
  function restriction(name: string, seen: Set<string>): Restriction | null {
    const col = byName.get(name);
    if (!col) return null;
    if (!col.formula) return restrictionOf(col);
    if (memo.has(name)) return memo.get(name)!;
    // A cycle can't compile, so it's caught below; this only stops the walk.
    if (seen.has(name)) return null;
    seen.add(name);
    let out: Restriction | null = null;
    try {
      const { uses } = compileFormula(col.formula, { columns: schema.filter((c) => c.name !== name), dialect: "sqlite" });
      for (const u of uses) out = combine(out, restriction(u, seen));
    } catch {
      // A formula that no longer checks out can't be read as safe: masked for everyone but admins.
      out = { sensitivity: "secret", roles: [] };
    }
    memo.set(name, out);
    return out;
  }

  return schema.map((c) => {
    if (!c.formula) return c;
    const r = restriction(c.name, new Set());
    const { sensitivity: _s, unredactedForRoles: _r, ...rest } = c;
    return r ? { ...rest, sensitivity: r.sensitivity, unredactedForRoles: r.roles } : rest;
  });
}

/**
 * A catalog schemaJson as columns. Formula columns come back with their tags
 * derived from what they read (withFormulaGovernance) whatever was stored, so
 * a reader that masks by these tags is right even if a writer wasn't.
 */
export function parseSchemaJson(raw: string | null | undefined): LakeColumn[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? withFormulaGovernance(parsed as LakeColumn[]) : [];
  } catch {
    return [];
  }
}

/**
 * Return `fresh` with each column's governance fields restored from
 * `existing`. `renamedFrom` maps a NEW column name to the OLD one it was
 * renamed from, so a tag follows its column through a rename instead of
 * being orphaned under a name that no longer exists. A column with no
 * prior counterpart (newly added) comes back exactly as it was in `fresh`.
 * Formula columns (those `fresh` gives a `formula`) get their tags derived
 * from their inputs instead — withFormulaGovernance. Never mutates its inputs.
 */
export function mergeGovernanceMetadata(
  existing: LakeColumn[],
  fresh: LakeColumn[],
  renamedFrom: Record<string, string> = {},
): LakeColumn[] {
  const priorByName = new Map(existing.map((c) => [c.name, c]));
  return withFormulaGovernance(fresh.map((col) => {
    const prior = priorByName.get(renamedFrom[col.name] ?? col.name);
    if (!prior) return col;
    const merged: LakeColumn = { ...col };
    for (const field of GOVERNANCE_FIELDS) {
      const value = prior[field];
      if (value === undefined) continue;
      (merged as Record<string, unknown>)[field] = Array.isArray(value) ? [...value] : value;
    }
    return merged;
  }));
}

function toSampleScalar(v: unknown): string | number | boolean {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return String(v);
}

/**
 * Give each column without a `sample` the first non-empty value found in
 * `rows`. A column that already has one keeps it. Needed after a typed
 * conversion: schemaForTable's DDL-trusting path (which is right to trust
 * the DDL for the TYPE) returns typed columns with no sample at all, and the
 * catalog's `sample` is what the semantic index embeds (`<table> · <column> ·
 * <type> · sample=<sample>`) — without this a converted column would embed as
 * `sample=undefined`. Dates come back as native Date objects on DuckDB, so
 * they're serialised to ISO here rather than left to JSON.stringify's
 * default.
 */
export function attachSamples(columns: LakeColumn[], rows: Array<Record<string, unknown>>): LakeColumn[] {
  return columns.map((col) => {
    if (col.sample !== undefined && col.sample !== null) return col;
    for (const row of rows) {
      const v = row?.[col.name];
      if (v == null || v === "") continue;
      return { ...col, sample: toSampleScalar(v) };
    }
    return col;
  });
}

/**
 * The catalog `schemaJson` to persist after a typed conversion: the columns
 * the conversion resolved (types come from the DDL, never re-inferred from a
 * value sample — a SQLite boolean is a 0/1 INTEGER that a sample would call
 * a "number"), with a sample attached where missing, and every column's
 * governance metadata carried over from what's in the catalog now.
 */
export function buildSchemaAfterConversion(
  existingSchemaJson: string | null | undefined,
  resolvedColumns: LakeColumn[],
  sampleRows: Array<Record<string, unknown>>,
): LakeColumn[] {
  return mergeGovernanceMetadata(parseSchemaJson(existingSchemaJson), attachSamples(resolvedColumns, sampleRows));
}
