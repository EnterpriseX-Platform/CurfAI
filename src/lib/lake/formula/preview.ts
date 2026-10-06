/**
 * What a formula gives before it's a column — for the editor, as the person
 * types. The first few rows side by side with the columns the formula reads,
 * and how many of a sample of rows come out blank (a formula that reads a
 * mostly-empty column, or divides by a column of zeros, says so before it's
 * added). The sample is capped, so a million-row table answers as fast as a
 * hundred-row one.
 *
 * Reads raw: the caller masks what the viewer may not see (the formula route
 * — the inputs by their own tags, the result by the tags it would carry).
 */
import { compileFormula, quoteIdent, type CompiledFormula, type FormulaType } from "./compile";
import { getTable, queryLake, toSafeTableName, type LakeColumn } from "../tables";
import { unusedKey } from "../resultKey";

export const PREVIEW_ROWS = 6;
export const PREVIEW_SAMPLE_ROWS = 10_000;
/** The result's key in a preview row — unless the table has a column called that (see `valueKey`). */
export const PREVIEW_VALUE_KEY = "formula value";

export type FormulaPreview = {
  type: FormulaType;
  uses: string[];
  /** The result's key in `rows`: PREVIEW_VALUE_KEY, or a variant of it if a column of the table is called that (resultKey.ts). */
  valueKey: string;
  /** The columns the formula reads, and what it gives, for the table's first rows. */
  rows: Array<Record<string, unknown>>;
  /** Rows looked at (at most PREVIEW_SAMPLE_ROWS), and how many of them it leaves blank. */
  sampled: number;
  blank: number;
  /** The table's columns, formula columns marked — for the caller's masking. */
  columns: LakeColumn[];
};

export async function previewFormula(opts: {
  tenantId: string;
  tableName: string;
  formula: string;
  /** The formula column being changed, when it's an edit — it can't read itself. */
  columnName?: string;
}): Promise<FormulaPreview> {
  const table = await getTable(opts.tenantId, opts.tableName);
  if (!table) throw new Error(`Table "${opts.tableName}" not found`);
  const compile = (dialect: "sqlite" | "duckdb") =>
    compileFormula(opts.formula, { columns: table.columns, dialect, self: opts.columnName });
  // Compiled for both engines: queryLake runs whichever the tenant is on.
  const sqlite = compile("sqlite");
  const duckdb = compile("duckdb");
  const from = quoteIdent(toSafeTableName(opts.tableName));
  const both = (sql: (c: CompiledFormula) => string) => ({ sqlite: sql(sqlite), duckdb: sql(duckdb) });
  const valueKey = unusedKey(PREVIEW_VALUE_KEY, table.columns.map((c) => c.name));

  const rows = await queryLake(opts.tenantId, both((c) =>
    `SELECT ${[...c.uses.map(quoteIdent), `(${c.sql}) AS ${quoteIdent(valueKey)}`].join(", ")} FROM ${from} LIMIT ${PREVIEW_ROWS}`));
  const [stats] = await queryLake(opts.tenantId, both((c) =>
    `SELECT COUNT(*) AS n, COUNT(v) AS filled FROM (SELECT (${c.sql}) AS v FROM ${from} LIMIT ${PREVIEW_SAMPLE_ROWS}) s`));
  const sampled = Number(stats?.n ?? 0);

  return {
    type: sqlite.type,
    uses: sqlite.uses,
    valueKey,
    rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v, k === valueKey ? sqlite.type : undefined)]))),
    sampled,
    blank: sampled - Number(stats?.filled ?? 0),
    columns: table.columns,
  };
}

/** One shape for both engines: SQLite gives a yes/no as 0/1, DuckDB counts as bigints. */
function plain(v: unknown, type: FormulaType | undefined): unknown {
  if (typeof v === "bigint") v = Number(v);
  if (type === "boolean" && typeof v === "number") return v !== 0;
  return v;
}
