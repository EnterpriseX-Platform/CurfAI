/**
 * Drawing the last, still-running period of a time chart differently (see
 * lib/reporting/partialPeriod.ts for how it is found). A line can't change
 * dash halfway, so the final segment moves to its own `<field>__partial` key:
 * the solid series stops one point early and a dashed one draws the last
 * step — the same split buildForecastFields does for a projection, on the
 * same single array the axis reads. Bars just draw the last bar lighter with
 * a dashed outline (barRenderer / renderComboChart).
 */

export const PARTIAL_SUFFIX = "__partial";

/** The tooltip entries a split series would show twice (the shared point) collapse to one. */
export function partialUniqKey(entry: { dataKey?: unknown; name?: unknown }): string {
  return typeof entry.dataKey === "string" ? entry.dataKey.replace(PARTIAL_SUFFIX, "") : String(entry.name ?? "");
}

/**
 * Rows with each of `fields`' last step (index-1 → index) moved onto
 * `<field>__partial`. Returns the rows untouched when there is nothing to
 * split (no partial index, or it is the only point).
 */
export function splitPartialFields<T extends Record<string, unknown>>(
  rows: T[],
  fields: string[],
  index: number | undefined,
): Array<T & Record<string, unknown>> {
  if (index == null || index < 1 || index >= rows.length || fields.length === 0) return rows;
  return rows.map((row, i) => {
    if (i !== index && i !== index - 1) return row;
    const next: Record<string, unknown> = { ...row };
    for (const f of fields) {
      next[f + PARTIAL_SUFFIX] = row[f];
      if (i === index) next[f] = undefined;
    }
    return next as T;
  });
}
