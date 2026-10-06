/**
 * The name a new lake column may be given — by "Add column", a formula
 * column, or a rename. Imported headers keep whatever they were called
 * (spaces, Thai, "Row ID"); a column made in Curf is held to a name every
 * engine, formula and query reads without quoting surprises.
 *
 * One rule for the engines (tables.ts, duckdbWrite.ts) and the editors that
 * check it before sending (ColumnEditor, TableManagePanel's pattern) — it
 * used to be copied into each (audit 2026-09-30, C6). Pure: the browser
 * imports it.
 */
import { FormulaError } from "./formula/parse";

export const NEW_COLUMN_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** The same rule as an HTML input `pattern` (no slashes, anchored by the browser). */
export const NEW_COLUMN_NAME_PATTERN = "[a-zA-Z_][a-zA-Z0-9_]*";

/** Throws when `name` can't be a new column's name — keyed, so the editor says it in the reader's language. */
export function assertNewColumnName(name: string, which: "column" | "rename" = "column"): void {
  if (!NEW_COLUMN_NAME_RE.test(name)) throw new FormulaError(which === "rename" ? "bad_new_column_name" : "bad_column_name", -1, { pattern: NEW_COLUMN_NAME_PATTERN });
}
