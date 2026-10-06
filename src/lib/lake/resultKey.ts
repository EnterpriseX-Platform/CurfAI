/**
 * A key for a value a query adds to a table's rows — the rowid, a sort
 * value, a formula's result — that no column of that table is called.
 *
 * A lake column can be called anything an imported header says: "Row ID"
 * is in the Superstore sample, and SQL reads names without regard to case.
 * A fixed key collides with such a column, and the added value silently
 * replaces the real one: the 2026-09-30 audit (Q1) found a "Row ID" column
 * showing internal row numbers in the spreadsheet view, and a "sort value"
 * column vanishing from it. So the key is chosen per table, and the caller
 * hands it on (the rows API's `rowIdKey`, the preview's `valueKey`).
 */
export function unusedKey(base: string, taken: Iterable<string>): string {
  const names = new Set([...taken].map((n) => n.toLowerCase()));
  let key = base;
  for (let i = 2; names.has(key.toLowerCase()); i++) key = `${base} ${i}`;
  return key;
}
