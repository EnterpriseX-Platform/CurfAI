/**
 * What the upload dialog shows before anything is written: detected column
 * types, a few sample rows, the row count and any sheet choice. Built the
 * same way for a direct upload (POST /api/lake/tables/preview, every row in
 * memory) and a staged one (POST /api/lake/uploads/[id]/preview, a sample
 * streamed off disk), so both dialogs are typed by one set of rules.
 */
import { inferColumns, type LakeColumn } from "./tables";
import { detectDateOrder } from "./valueClean";
import type { TextRepair } from "./textRepair";

/** Rows in a full Excel sheet — 1,048,576 including the header. */
export const EXCEL_MAX_DATA_ROWS = 1_048_575;

const SAMPLE_ROWS = 20;

export type UploadPreview = {
  suggestedName: string;
  columns: LakeColumn[];
  sampleRows: Array<Record<string, unknown>>;
  rowCount: number;
  /** True when rowCount came from the file's own header info, not from reading every row. */
  rowCountIsEstimate: boolean;
  sheets: string[];
  sheet: string | null;
  /** Date columns whose values don't say whether they're day- or month-first. */
  ambiguousDateColumns: string[];
  /**
   * Exactly as many rows as an Excel sheet can hold. An export that hit the
   * limit was almost certainly cut off, and the missing rows can't be
   * recovered from this file — worth saying before it becomes a table whose
   * totals quietly come up short.
   */
  hitsExcelRowLimit: boolean;
  /** Garbled-text repair: what the sample looked like it needed, and what was applied to it. */
  textRepair: { detected: TextRepair | null; applied: TextRepair | null };
};

export function buildUploadPreview(opts: {
  filename: string;
  /** Every row (direct upload) or a leading sample (staged upload). */
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  rowCountIsEstimate: boolean;
  sheets: string[];
  sheet: string | null;
  textRepair?: UploadPreview["textRepair"];
}): UploadPreview {
  const { rows, sheets, sheet } = opts;
  const columns = inferColumns(rows);

  // Date columns whose values prove nothing about day/month order. The
  // detected order on those is a fallback, not a reading of the data, so
  // the dialog asks rather than letting it ride.
  const ambiguousDateColumns = columns
    .filter((c) => c.type === "date")
    .filter((c) => detectDateOrder(rows.map((r) => r[c.name]).filter((v): v is string => typeof v === "string")).ambiguous)
    .map((c) => c.name);

  const base = opts.filename.replace(/\.[^.]+$/, "");
  // One table per sheet, so a multi-sheet workbook needs the sheet in the
  // name — otherwise importing a second sheet proposes a name that already
  // exists and silently replaces the first import.
  const suggestedName = sheets.length > 1 && sheet ? `${base}_${sheet}` : base;

  return {
    suggestedName,
    columns,
    sampleRows: rows.slice(0, SAMPLE_ROWS),
    rowCount: opts.rowCount,
    rowCountIsEstimate: opts.rowCountIsEstimate,
    sheets,
    sheet,
    ambiguousDateColumns,
    hitsExcelRowLimit: opts.rowCount === EXCEL_MAX_DATA_ROWS,
    textRepair: opts.textRepair ?? { detected: null, applied: null },
  };
}
