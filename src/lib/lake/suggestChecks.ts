/**
 * Data-quality checks worth adding to a table, read off the same column profile the table page shows (the first rows the
 * reader may see). A column that is filled in every row of that sample suggests "never empty"; one that is filled and
 * different in every row, and is named like a key, suggests "no duplicates". These are proposals from a sample, not
 * findings about the whole table, and the page says so. A check the workspace already has is not proposed again. Pure and
 * client-safe.
 */
import type { ColumnProfile } from "./previewProfile";

export type CheckSuggestion =
  | { kind: "not_null"; column: string }
  | { kind: "unique"; column: string }
  | { kind: "row_count_min"; min: number };

export type ExistingCheck = { kind: string; configJson: string };

/** Fewer rows than this say too little about a column to propose a rule for it. */
export const MIN_SAMPLE_ROWS = 10;
const MAX_NOT_NULL = 5;
const KEY_NAME = /(^|[_\s-])(id|code|key|no|number|ref)$|^id[_\s-]|(?<=[a-z])(Id|Code|Key|No)$/;

function columnOf(configJson: string): string {
  try { return String(JSON.parse(configJson || "{}")?.column ?? ""); } catch { return ""; }
}

export function suggestChecks(
  columns: string[],
  profile: Map<string, ColumnProfile>,
  rowCount: number,
  existing: ExistingCheck[],
): CheckSuggestion[] {
  const has = (kind: string, column?: string) =>
    existing.some((c) => c.kind === kind && (column === undefined || columnOf(c.configJson) === column));
  const out: CheckSuggestion[] = [];

  if (rowCount > 0 && !has("row_count_min")) out.push({ kind: "row_count_min", min: Math.max(1, Math.floor(rowCount / 2)) });

  const full = columns.filter((c) => {
    const p = profile.get(c);
    return !!p && p.rows >= MIN_SAMPLE_ROWS && p.filled === p.rows;
  });
  for (const c of full) {
    const p = profile.get(c)!;
    if (p.distinct === p.rows && KEY_NAME.test(c) && !has("unique", c)) out.push({ kind: "unique", column: c });
  }
  // Keys first: an empty key is the one that breaks a join.
  const ordered = [...full].sort((a, b) => Number(KEY_NAME.test(b)) - Number(KEY_NAME.test(a)));
  let added = 0;
  for (const c of ordered) {
    if (added >= MAX_NOT_NULL) break;
    if (has("not_null", c)) continue;
    out.push({ kind: "not_null", column: c });
    added++;
  }
  return out;
}
