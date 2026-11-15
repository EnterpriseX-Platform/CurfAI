/**
 * A quick profile of each column from the rows a table page already shows (the reader's own preview, so redaction and
 * access are already applied): how many of them are filled and how many different values they hold. It says so on the page,
 * as a read of the first rows and not of the whole table, because a full profile is a scan the page does not run.
 * Pure and client-safe.
 */
export type ColumnProfile = { rows: number; filled: number; distinct: number };

export function profilePreview(rows: Array<Record<string, unknown>>, columns: string[]): Map<string, ColumnProfile> {
  const out = new Map<string, ColumnProfile>();
  for (const name of columns) {
    const seen = new Set<string>();
    let filled = 0;
    for (const row of rows) {
      const v = row[name];
      if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) continue;
      filled++;
      seen.add(typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    out.set(name, { rows: rows.length, filled, distinct: seen.size });
  }
  return out;
}

/** "92%" of the rows read; "–" when there were none. */
export function filledPercent(p: ColumnProfile | undefined): string {
  if (!p || p.rows === 0) return "–";
  return `${Math.round((p.filled / p.rows) * 100)}%`;
}
