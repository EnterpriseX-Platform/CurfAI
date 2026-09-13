/**
 * Bytes -> rows, for anything that lands data in a Curf Tables lake table:
 * the file-upload route (app/api/lake/tables/route.ts) and the SFTP pull
 * (lib/lake/restPull.ts). Extracted from the upload route (previously
 * inline, unshared, untested) so a second real consumer doesn't duplicate
 * the CSV/XLSX/JSON sniffing logic.
 *
 * Deps: exceljs for .xlsx/.xls (lib/connections/excelImport.ts already uses
 * it), papaparse for .csv/.tsv (already in package.json) — avoids adding
 * `xlsx` (SheetJS) just for this.
 */
import ExcelJS from "exceljs";
import Papa from "papaparse";

export type ParsedUpload = {
  rows: Array<Record<string, unknown>>;
  /** Sheet names in workbook order. Empty for CSV/TSV/JSON. */
  sheets: string[];
  /** Which sheet `rows` came from. Null for CSV/TSV/JSON. */
  sheet: string | null;
};

/**
 * Rows plus workbook metadata. The upload preview needs both: a workbook
 * has more than one sheet far more often than not, and reading only the
 * first one silently threw the rest away — the user's only clue was a row
 * count that looked wrong. Callers that just want rows use parseUpload.
 */
export async function parseUploadWithMeta(
  buf: Buffer,
  filename: string,
  opts?: { sheet?: string },
): Promise<ParsedUpload> {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  if (ext === "json" || buf[0] === 0x7b /* { */ || buf[0] === 0x5b /* [ */) {
    const parsed = JSON.parse(buf.toString("utf8"));
    if (Array.isArray(parsed)) return { rows: parsed, sheets: [], sheet: null };
    // Common API shape: {data: [...]} or {items: [...]}. Try the first
    // array-valued field at the top level.
    if (parsed && typeof parsed === "object") {
      for (const v of Object.values(parsed)) {
        if (Array.isArray(v)) return { rows: v as any[], sheets: [], sheet: null };
      }
    }
    throw new Error("JSON must be an array of objects, or an object containing one.");
  }
  if (ext === "csv" || ext === "tsv" || ext === "txt") {
    const text = buf.toString("utf8");
    const out = Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      delimiter: ext === "tsv" ? "\t" : "",   // empty = auto-detect
      dynamicTyping: false,                    // keep everything as strings; lake infers later
    });
    if (out.errors && out.errors.length > 0) {
      const first = out.errors[0];
      throw new Error(`CSV parse error on row ${first.row}: ${first.message}`);
    }
    const rows = (out.data as any[]).filter((r) => r && typeof r === "object");
    return { rows: nameBlankColumns(rows, out.meta?.fields), sheets: [], sheet: null };
  }
  // XLSX / XLS via exceljs (already a project dep — see excelImport.ts).
  const wb = new ExcelJS.Workbook();
  // Node 20's `Buffer<ArrayBufferLike>` and exceljs's own bundled `Buffer`
  // type are structurally distinct, and casting through `Buffer` doesn't
  // help (the global IS the Node 20 generic). `any` is the pragmatic escape.
  await wb.xlsx.load(buf as any);
  const sheets = wb.worksheets.map((w) => w.name);
  if (wb.worksheets.length === 0) throw new Error("Spreadsheet had no sheets");

  let ws;
  if (opts?.sheet != null) {
    ws = wb.worksheets.find((w) => w.name === opts.sheet);
    // Naming a sheet that isn't there is a caller bug (a stale sheet list,
    // a renamed tab). Falling back to sheet 1 would import the wrong data
    // under the right-looking name — the exact silent-substitution failure
    // this function exists to end.
    if (!ws) {
      throw new Error(`Sheet "${opts.sheet}" not found. This workbook has: ${sheets.join(", ")}`);
    }
  } else {
    ws = wb.worksheets[0];
  }

  return { rows: sheetToRows(ws), sheets, sheet: ws.name };
}

export async function parseUpload(
  buf: Buffer,
  filename: string,
  opts?: { sheet?: string },
): Promise<Array<Record<string, unknown>>> {
  return (await parseUploadWithMeta(buf, filename, opts)).rows;
}

/**
 * A trailing comma or a spacer column gives Papa a header of "", so every
 * such column lands under the same empty key — they collide with each
 * other and produce a nameless column in the table. Give them positional
 * names, the way the XLSX path already does with `col_N`.
 */
function nameBlankColumns(
  rows: Array<Record<string, unknown>>,
  fields: string[] | undefined,
): Array<Record<string, unknown>> {
  if (!fields?.some((f) => f.trim() === "")) return rows;
  const renamed = new Map<string, string>();
  fields.forEach((f, i) => { if (f.trim() === "") renamed.set(f, `column_${i + 1}`); });
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) out[renamed.get(k) ?? k] = v;
    return out;
  });
}

function sheetToRows(ws: ExcelJS.Worksheet): Array<Record<string, unknown>> {
  // Row 1 is the header; subsequent rows become objects keyed by header.
  const headers: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber - 1] = String(cell.value ?? `col_${colNumber}`).trim();
  });
  if (headers.length === 0) throw new Error(`Sheet "${ws.name}" has no header row`);
  const rows: Array<Record<string, unknown>> = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const obj: Record<string, unknown> = {};
    let hasAny = false;
    for (let c = 1; c <= headers.length; c++) {
      const cell = row.getCell(c);
      const v = cell.value;
      // exceljs returns rich objects for formulas, dates, hyperlinks. We
      // flatten to a primitive: prefer .result (formula output), then .text
      // for hyperlinks, then the raw value.
      const flat = v == null
        ? null
        : typeof v === "object" && "result" in (v as any) ? (v as any).result
        : typeof v === "object" && "text" in (v as any)   ? (v as any).text
        : v instanceof Date                                ? v.toISOString()
        : v;
      obj[headers[c - 1]] = flat as any;
      if (flat != null && flat !== "") hasAny = true;
    }
    if (hasAny) rows.push(obj);
  }
  return rows;
}
