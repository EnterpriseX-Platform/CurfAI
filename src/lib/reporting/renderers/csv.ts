/**
 * CSV renderer. CSV is inherently tabular so we export the *first* Table block
 * by default (or a named block via ?block=id). Multi-table reports should use XLSX.
 *
 * Two things distinguish this from what the viewer shows:
 *
 *   1. It runs with `forExport`, which lifts the generator's display cap so
 *      the file holds the whole table rather than the first page of it.
 *   2. It writes machine-readable values, not display strings. A CSV is data
 *      headed for a spreadsheet or a script — "3,500" is a string to most
 *      importers, and a column of them sums to nothing.
 */
import Papa from "papaparse";
import { runReport } from "@/lib/reporting/runner";
import type { Report } from "@/lib/reporting/schema";

/**
 * Coerce one cell to its machine-readable form.
 *
 * Numbers stay numbers, at full precision and without separators. Dates go
 * out as ISO so they sort and parse everywhere. Everything else passes
 * through as text. Null and empty become an empty field — absent is not
 * zero, and not the string "null".
 */
function csvCell(value: unknown, type: string): string | number | boolean | null {
  if (value == null || value === "") return null;

  if (type === "number" || type === "currency" || type === "percent") {
    const n = Number(value);
    return Number.isFinite(n) ? n : String(value);
  }

  if (type === "date" || type === "datetime") {
    // Pass through anything already ISO-shaped; the lake stores dates as
    // text and re-parsing them only risks a timezone shift.
    const s = String(value);
    if (/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(s)) return s;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return type === "date"
      ? d.toISOString().slice(0, 10)
      : d.toISOString().slice(0, 19).replace("T", " ");
  }

  if (typeof value === "boolean") return value;
  return String(value);
}

export async function renderCsv(
  report: Report,
  params: Record<string, unknown>,
  blockId?: string
): Promise<string> {
  const dataset = await runReport({ report, params, forExport: true });

  const tableBlock = report.pages
    .flatMap((p) => p.blocks)
    .find((b) => b.type === "table" && (!blockId || b.id === blockId));

  if (!tableBlock || tableBlock.type !== "table") {
    throw new Error("No table block to export as CSV");
  }

  const rows = dataset[tableBlock.config.queryId] ?? [];
  const columns = tableBlock.config.columns;

  const out = rows.map((r) => {
    const rec: Record<string, unknown> = {};
    for (const c of columns) rec[c.label] = csvCell(r[c.key], c.type);
    return rec;
  });

  return Papa.unparse(out, { columns: columns.map((c) => c.label) });
}
