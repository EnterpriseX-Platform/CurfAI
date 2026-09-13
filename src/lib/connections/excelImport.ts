/**
 * Excel → SQLite import primitive.
 *
 * Given an .xlsx buffer and a target file path, this writes a SQLite database
 * containing one table per worksheet. Sheet names and column headers are
 * sanitized into SQL-safe identifiers; column types are inferred from the
 * first INFER_SAMPLE_ROWS non-empty values per column.
 *
 * The output is then queryable through the existing kind=sqlite runner — the
 * Excel "data source" is just SQLite under the hood, transparent to drilldown,
 * AI Generate, watcher, and the proof layer downstream.
 *
 * v1 design choices (locked with the user before implementation):
 *   - File size cap:       MAX_FILE_BYTES (25 MB)
 *   - Per-sheet row cap:   MAX_ROWS_PER_SHEET (100 000) — anything more, we
 *                          recommend the Postgres connector instead
 *   - Type inference:      first INFER_SAMPLE_ROWS (100) non-empty values
 *                          per column
 *   - Multi-row headers:   v1 takes the first non-empty row as the header
 *                          and warns if merged cells appear in the first
 *                          MERGED_HEADER_SCAN (3) rows. (Letting users pick
 *                          the header row is a v2 enhancement.)
 *
 * Pure module: no auth, no tenant, no HTTP. Callers (the upload API route)
 * own those concerns.
 */
import path from "path";
import fs from "fs";
import ExcelJS from "exceljs";
import Database from "better-sqlite3";

export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
export const MAX_ROWS_PER_SHEET = 100_000;
export const INFER_SAMPLE_ROWS = 100;
const MERGED_HEADER_SCAN = 3;

/** Logical column type. Stored in metadata; SQL type is derived (see sqlTypeFor). */
export type LogicalType = "INTEGER" | "REAL" | "TEXT" | "BOOLEAN" | "DATE";

export type ImportedColumn = {
  /** Sanitized, SQL-safe column name (also used as the SQLite column name). */
  name: string;
  /** Original header text from the spreadsheet, for display. */
  originalHeader: string;
  type: LogicalType;
  /** A representative sample value, for the AI Generate prompt + inventory. */
  sample: unknown;
};

export type ImportedTable = {
  /** Sanitized, SQL-safe table name. */
  name: string;
  /** Original sheet name from the workbook, for display. */
  originalSheetName: string;
  columns: ImportedColumn[];
  rowCount: number;
};

export type ExcelImportSchema = {
  source: "excel";
  importedAt: string;
  originalFilename: string;
  fileSize: number;
  tables: ImportedTable[];
  warnings: string[];
};

export type ImportResult =
  | { ok: true; schema: ExcelImportSchema }
  | { ok: false; error: string };

/** Public entrypoint. Buffer in, SQLite file out, schema metadata returned. */
export async function parseExcelToSqlite(
  buf: Buffer,
  dbPath: string,
  originalFilename: string,
): Promise<ImportResult> {
  if (buf.byteLength > MAX_FILE_BYTES) {
    return {
      ok: false,
      error: `File is ${formatBytes(buf.byteLength)} — exceeds the ${formatBytes(MAX_FILE_BYTES)} cap. For larger datasets, use the Postgres connector.`,
    };
  }

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as any);
  } catch (e: any) {
    return { ok: false, error: `Could not parse .xlsx: ${e?.message ?? "unknown error"}` };
  }

  // Make sure the parent dir exists, then start fresh — re-imports overwrite.
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const db = new Database(dbPath);
  // Pragmas tuned for bulk insert. We close on either path so the file is
  // flushed and the WAL collapsed before the API returns.
  db.pragma("journal_mode = MEMORY");
  db.pragma("synchronous = OFF");

  const warnings: string[] = [];
  const tables: ImportedTable[] = [];
  const usedTableNames = new Set<string>();

  try {
    // ExcelJS uses 1-indexed sheets; we walk in workbook order so the first
    // sheet ends up first in our metadata too.
    let sheetIndex = 0;
    for (const ws of wb.worksheets) {
      sheetIndex++;
      if (ws.state === "hidden" || ws.state === "veryHidden") {
        warnings.push(`Skipped hidden sheet "${ws.name}".`);
        continue;
      }

      const tableName = uniqueIdent(sanitizeIdent(ws.name) || `sheet_${sheetIndex}`, usedTableNames);
      usedTableNames.add(tableName);

      const imported = importSheet(ws, tableName, db, warnings);
      if (imported) tables.push(imported);
    }
  } finally {
    db.close();
  }

  if (tables.length === 0) {
    // Roll back the empty .db file so refreshes don't leave a stub.
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    return { ok: false, error: "No data found in the workbook (every sheet was empty or hidden)." };
  }

  return {
    ok: true,
    schema: {
      source: "excel",
      importedAt: new Date().toISOString(),
      originalFilename,
      fileSize: buf.byteLength,
      tables,
      warnings,
    },
  };
}

/**
 * Import one worksheet into one SQLite table. Returns null if the sheet is
 * effectively empty (no header row or no data rows).
 */
function importSheet(
  ws: ExcelJS.Worksheet,
  tableName: string,
  // better-sqlite3 v11 exports the type as the default itself; the older
  // `Database.Database` namespaced form was removed. InstanceType keeps
  // typing portable across both v10 and v11 of the package.
  db: InstanceType<typeof Database>,
  warnings: string[],
): ImportedTable | null {
  // Heuristic: pick the first non-empty row as the header. Walk forward up
  // to MERGED_HEADER_SCAN rows to detect merged cells (a common "title row"
  // pattern that v1 doesn't try to interpret).
  if (hasMergedCellsInFirstRows(ws, MERGED_HEADER_SCAN)) {
    warnings.push(
      `Sheet "${ws.name}": detected merged cells in the first ${MERGED_HEADER_SCAN} rows. ` +
      `Treating row 1 as the header — if your headers are below a title row, ` +
      `move them up before re-importing.`,
    );
  }

  const headerRowIdx = firstNonEmptyRowIndex(ws);
  if (headerRowIdx == null) {
    warnings.push(`Sheet "${ws.name}" was empty — skipped.`);
    return null;
  }

  const headerRow = ws.getRow(headerRowIdx);
  const usedColNames = new Set<string>();
  const columns: { col: number; name: string; originalHeader: string }[] = [];
  // ExcelJS's eachCell skips empty cells unless asked to include them. We
  // walk to the row's actualCellCount to capture every header position.
  const colCount = ws.actualColumnCount ?? headerRow.actualCellCount ?? 0;
  for (let c = 1; c <= colCount; c++) {
    const cell = headerRow.getCell(c);
    const headerText = stringifyCell(cell.value).trim();
    const ident = sanitizeIdent(headerText) || `col_${c}`;
    const unique = uniqueIdent(ident, usedColNames);
    usedColNames.add(unique);
    columns.push({ col: c, name: unique, originalHeader: headerText || `Column ${c}` });
  }

  if (columns.length === 0) {
    warnings.push(`Sheet "${ws.name}" had no detectable columns — skipped.`);
    return null;
  }

  // Pass 1 — sample first INFER_SAMPLE_ROWS data rows to infer per-column type.
  const samples: unknown[][] = columns.map(() => []);
  let dataRowCount = 0;
  let truncated = false;
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRowIdx) return;
    if (dataRowCount >= MAX_ROWS_PER_SHEET) { truncated = true; return; }
    dataRowCount++;
    if (dataRowCount > INFER_SAMPLE_ROWS) return;
    columns.forEach((c, i) => {
      const v = coerceCellValue(row.getCell(c.col).value);
      if (v != null) samples[i].push(v);
    });
  });

  if (dataRowCount === 0) {
    warnings.push(`Sheet "${ws.name}" had a header but no data — skipped.`);
    return null;
  }
  if (truncated) {
    warnings.push(
      `Sheet "${ws.name}" was truncated at ${MAX_ROWS_PER_SHEET.toLocaleString()} rows. ` +
      `For larger datasets, switch to a real database connection.`,
    );
  }

  const inferredTypes: LogicalType[] = samples.map(inferTypeFromSamples);
  const importedColumns: ImportedColumn[] = columns.map((c, i) => ({
    name: c.name,
    originalHeader: c.originalHeader,
    type: inferredTypes[i],
    sample: samples[i].find((v) => v != null) ?? null,
  }));

  // Pass 2 — create the table and insert. We re-walk the sheet because pass 1
  // only kept samples (cheap), and most workbooks fit comfortably in memory
  // anyway. If this becomes a hot path for large files, we can accumulate
  // rows during pass 1 instead.
  const createSql =
    `CREATE TABLE "${tableName}" (` +
    importedColumns.map((c) => `"${c.name}" ${sqlTypeFor(c.type)}`).join(", ") +
    `)`;
  db.exec(createSql);
  const insertSql =
    `INSERT INTO "${tableName}" (` +
    importedColumns.map((c) => `"${c.name}"`).join(", ") +
    `) VALUES (` +
    importedColumns.map(() => "?").join(", ") +
    `)`;
  const insert = db.prepare(insertSql);
  const insertMany = db.transaction((rows: unknown[][]) => {
    for (const r of rows) insert.run(r);
  });

  const batch: unknown[][] = [];
  const BATCH_SIZE = 1000;
  let inserted = 0;
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRowIdx) return;
    if (inserted >= MAX_ROWS_PER_SHEET) return;
    const values = importedColumns.map((c, i) => {
      const raw = coerceCellValue(row.getCell(columns[i].col).value);
      return toSqlValue(raw, c.type);
    });
    batch.push(values);
    inserted++;
    if (batch.length >= BATCH_SIZE) {
      insertMany(batch);
      batch.length = 0;
    }
  });
  if (batch.length) insertMany(batch);

  return {
    name: tableName,
    originalSheetName: ws.name,
    columns: importedColumns,
    rowCount: inserted,
  };
}

// ---------------- helpers ----------------

/**
 * Sanitize an arbitrary string into a SQL-safe identifier. Lowercase, replace
 * non-alphanumeric runs with single underscores, trim leading/trailing
 * underscores, prefix with `t_` if it would start with a digit. Returns ""
 * for inputs that yield nothing — caller supplies a fallback.
 */
function sanitizeIdent(raw: string): string {
  let s = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!s) return "";
  if (/^[0-9]/.test(s)) s = "t_" + s;
  // SQLite has no real reserved-word problem when we always quote identifiers
  // in our generated SQL (CREATE TABLE / INSERT use "name"), so we don't
  // bother prefixing those.
  return s;
}

/** Append _2, _3, … if the candidate collides with an already-used name. */
function uniqueIdent(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) return candidate;
  let i = 2;
  while (used.has(candidate + "_" + i)) i++;
  return candidate + "_" + i;
}

/** Convert any ExcelJS cell.value into a normalized JS value. */
function coerceCellValue(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    const o = v as any;
    // Formula cell — prefer the computed result, fall through to the formula
    // text if there's no result yet (very rare in real exports).
    if ("result" in o) return coerceCellValue(o.result);
    // Hyperlink: { text, hyperlink } — keep the visible label.
    if ("text" in o && typeof o.text === "string") return o.text;
    // Rich text: { richText: [{ text }, ...] } — concatenate runs.
    if ("richText" in o && Array.isArray(o.richText)) {
      return o.richText.map((r: any) => r?.text ?? "").join("");
    }
    // Error cell ({ error: "#REF!" }) — surface as null so it doesn't poison
    // numeric type inference. Could also be made TEXT with the error code.
    if ("error" in o) return null;
  }
  return String(v);
}

/** Stringify any cell value for header reading and warning messages. */
function stringifyCell(v: unknown): string {
  const c = coerceCellValue(v);
  if (c == null) return "";
  if (c instanceof Date) return c.toISOString();
  return String(c);
}

/** Walk the sheet's first ~20 rows and return the first one that has any value. */
function firstNonEmptyRowIndex(ws: ExcelJS.Worksheet): number | null {
  const limit = Math.min(20, ws.rowCount || 20);
  for (let r = 1; r <= limit; r++) {
    const row = ws.getRow(r);
    if (row.actualCellCount && row.actualCellCount > 0) return r;
  }
  return null;
}

function hasMergedCellsInFirstRows(ws: ExcelJS.Worksheet, rows: number): boolean {
  // ExcelJS exposes merged ranges via _merges (private but stable). When
  // unavailable, fall back to false rather than crash.
  const merges: Record<string, any> = (ws as any)._merges ?? {};
  for (const key of Object.keys(merges)) {
    const range = merges[key];
    const top = range?.top ?? range?.model?.top ?? 999;
    if (top <= rows) return true;
  }
  return false;
}

/**
 * Infer a logical type from a column's sampled non-null values. Order of
 * preference: BOOLEAN ⊂ INTEGER ⊂ REAL ⊂ DATE ⊂ TEXT (most specific that
 * fits all samples wins).
 */
function inferTypeFromSamples(samples: unknown[]): LogicalType {
  if (samples.length === 0) return "TEXT";

  let allBool = true, allInt = true, allReal = true, allDate = true;
  for (const v of samples) {
    if (typeof v !== "boolean") allBool = false;
    if (!isIntegerLike(v)) allInt = false;
    if (!isNumberLike(v)) allReal = false;
    if (!isDateLike(v)) allDate = false;
    if (!allBool && !allInt && !allReal && !allDate) break;
  }
  if (allBool) return "BOOLEAN";
  if (allInt) return "INTEGER";
  if (allReal) return "REAL";
  if (allDate) return "DATE";
  return "TEXT";
}

function isIntegerLike(v: unknown): boolean {
  if (typeof v === "number") return Number.isInteger(v);
  if (typeof v === "string") {
    const t = v.trim();
    return /^-?\d+$/.test(t);
  }
  return false;
}
function isNumberLike(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") {
    const t = v.trim().replace(/,/g, ""); // permit "1,234.56"
    if (!t) return false;
    return Number.isFinite(Number(t));
  }
  return false;
}
function isDateLike(v: unknown): boolean {
  if (v instanceof Date) return !Number.isNaN(v.getTime());
  // Strict ISO-ish date or datetime detection. We don't try to parse arbitrary
  // strings like "Mar 5 2024" — too many false positives.
  if (typeof v === "string") {
    return /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(v.trim());
  }
  return false;
}

/** Map a logical type to its SQLite affinity. */
function sqlTypeFor(t: LogicalType): string {
  switch (t) {
    case "INTEGER": return "INTEGER";
    case "REAL":    return "REAL";
    case "BOOLEAN": return "INTEGER"; // 0/1
    case "DATE":    return "TEXT";    // ISO strings, sortable lexically
    case "TEXT":
    default:        return "TEXT";
  }
}

/**
 * Coerce a JS value into the SQL-bindable shape required by its column type.
 * Returns null when coercion fails — better-sqlite3 will store NULL.
 */
function toSqlValue(v: unknown, t: LogicalType): unknown {
  if (v == null) return null;
  switch (t) {
    case "BOOLEAN":
      if (typeof v === "boolean") return v ? 1 : 0;
      if (typeof v === "number") return v ? 1 : 0;
      if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        if (s === "true" || s === "yes" || s === "1") return 1;
        if (s === "false" || s === "no" || s === "0") return 0;
      }
      return null;
    case "INTEGER": {
      if (typeof v === "number" && Number.isInteger(v)) return v;
      if (typeof v === "string") {
        const t2 = v.trim().replace(/,/g, "");
        if (/^-?\d+$/.test(t2)) return Number(t2);
      }
      return null;
    }
    case "REAL": {
      if (typeof v === "number") return v;
      if (typeof v === "string") {
        const t2 = v.trim().replace(/,/g, "");
        const n = Number(t2);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    }
    case "DATE": {
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
      if (typeof v === "string") {
        // Pass through if it already looks ISO-ish; otherwise attempt Date.parse
        // and normalize.
        const trimmed = v.trim();
        if (isDateLike(trimmed)) {
          const d = new Date(trimmed);
          return Number.isNaN(d.getTime()) ? trimmed : d.toISOString();
        }
        return trimmed;
      }
      return String(v);
    }
    case "TEXT":
    default:
      if (v instanceof Date) return v.toISOString();
      return typeof v === "string" ? v : String(v);
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
