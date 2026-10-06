/**
 * Bytes -> rows, for anything that lands data in a Curf Tables lake table:
 * the file-upload route (app/api/lake/tables/route.ts) and the SFTP pull
 * (lib/lake/restPull.ts). Extracted from the upload route (previously
 * inline, unshared, untested) so a second real consumer doesn't duplicate
 * the CSV/XLSX/JSON sniffing logic.
 *
 * Two entry points over the same parsers:
 *   - parseUploadWithMeta / parseUpload: a Buffer already in memory (the
 *     direct upload route, the SFTP pull), all rows at once.
 *   - openUploadRows: a file on disk (a staged large upload), rows streamed
 *     one at a time so a million-row workbook never sits in memory.
 *
 * Deps: xlsxStream.ts (unzipper + saxes, both already installed with
 * exceljs) for .xlsx, papaparse for .csv/.tsv — avoids adding `xlsx`
 * (SheetJS) just for this.
 */
import fs from "node:fs";
import Papa from "papaparse";
import { openXlsx } from "./xlsxStream";

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
    // Excel's "CSV UTF-8" starts with a byte-order mark, which would
    // otherwise become part of the first column's name.
    const text = buf.toString("utf8").replace(/^﻿/, "");
    const out = Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      delimiter: ext === "tsv" ? "\t" : "",   // empty = auto-detect
      dynamicTyping: false,                    // keep everything as strings; lake infers later
    });
    // PapaParse's own delimiter sniffer can't tell "," from "\t" from ";"
    // when the file has none of them anywhere — a perfectly ordinary
    // single-column CSV (one value per line: a list of emails, IDs, tags).
    // It still parses correctly by defaulting to ",", and says so via a
    // non-fatal "Delimiter"/"UndetectableDelimiter" entry in `errors`
    // rather than leaving `data` empty or malformed — confirmed against
    // Papa directly: `out.data` for a single-column file is exactly right.
    // Treating every entry in `errors` as fatal (found live via a Tables
    // 2.0 edge-case pass) meant every single-column upload was rejected
    // outright with a confusing "CSV parse error", even though nothing
    // was actually wrong with the file.
    const fatalErrors = (out.errors ?? []).filter((e) => e.code !== "UndetectableDelimiter");
    if (fatalErrors.length > 0) {
      const first = fatalErrors[0];
      throw new Error(`CSV parse error on row ${first.row}: ${first.message}`);
    }
    const rows = (out.data as any[]).filter((r) => r && typeof r === "object");
    return { rows: nameBlankColumns(rows, out.meta?.fields), sheets: [], sheet: null };
  }
  // XLSX — the same streaming reader a staged large upload uses, collected.
  const wb = await openXlsx({ buffer: buf });
  const sheet = wb.resolveSheet(opts?.sheet);
  const rows: Array<Record<string, unknown>> = [];
  for await (const row of wb.rows(sheet)) rows.push(row);
  return { rows, sheets: wb.sheets, sheet };
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

// ---------------------------------------------------------------------------
// Streaming, from a file on disk
// ---------------------------------------------------------------------------

export type UploadRowStream = {
  /** Sheet names in workbook order. Empty for CSV/TSV/JSON. */
  sheets: string[];
  /** Which sheet `rows` reads. Null for CSV/TSV/JSON. */
  sheet: string | null;
  rows: AsyncGenerator<Record<string, unknown>>;
  /**
   * Data rows (header excluded) the file says it holds before it is read:
   * an XLSX sheet's <dimension>, or a CSV's line count. An estimate — a
   * trailing blank row or a quoted newline moves it — but good enough for
   * progress, and read without parsing a single row.
   */
  expectedRows(): Promise<number | null>;
};

/** File types a staged upload can import. */
export const UPLOAD_EXTENSIONS = ["csv", "tsv", "txt", "xlsx", "json"] as const;

/** JSON has no streaming form here — it is parsed whole, so it keeps the direct upload's cap. */
export const MAX_JSON_UPLOAD_BYTES = 50 * 1024 * 1024;

export function uploadExtension(filename: string): string {
  return (filename.split(".").pop() ?? "").toLowerCase();
}

export async function openUploadRows(
  path: string,
  filename: string,
  opts?: { sheet?: string },
): Promise<UploadRowStream> {
  const ext = uploadExtension(filename);
  if (ext === "csv" || ext === "tsv" || ext === "txt") {
    return {
      sheets: [],
      sheet: null,
      rows: csvRows(path, ext === "tsv" ? "\t" : ""),
      expectedRows: async () => Math.max(0, (await countLines(path)) - 1),
    };
  }
  if (ext === "xlsx") {
    const wb = await openXlsx({ path });
    const sheet = wb.resolveSheet(opts?.sheet);
    return {
      sheets: wb.sheets,
      sheet,
      rows: wb.rows(sheet),
      expectedRows: async () => {
        const n = await wb.declaredRowCount(sheet);
        return n == null ? null : Math.max(0, n - 1);
      },
    };
  }
  if (ext === "json") {
    const { size } = await fs.promises.stat(path);
    if (size > MAX_JSON_UPLOAD_BYTES) {
      throw new Error(`JSON files can be at most ${MAX_JSON_UPLOAD_BYTES / 1024 / 1024} MB — save larger data as .csv or .xlsx.`);
    }
    const { rows } = await parseUploadWithMeta(await fs.promises.readFile(path), filename);
    return {
      sheets: [],
      sheet: null,
      rows: (async function* () { yield* rows; })(),
      expectedRows: async () => rows.length,
    };
  }
  throw new Error(`.${ext || "?"} files can't be imported — upload a .xlsx, .csv or .json file.`);
}

/**
 * CSV rows through Papa's step mode, paused whenever the consumer falls
 * behind, so the file streams instead of loading. Same header handling and
 * error rules as the in-memory path above.
 */
async function* csvRows(path: string, delimiter: string): AsyncGenerator<Record<string, unknown>> {
  const queue: Array<Record<string, unknown>> = [];
  let finished = false;
  let failure: Error | null = null;
  let paused = false;
  let parser: Papa.Parser | null = null;
  let wake: (() => void) | null = null;
  const notify = () => { const w = wake; wake = null; w?.(); };

  const input = fs.createReadStream(path, { encoding: "utf8" });
  Papa.parse(input as any, {
    header: true,
    skipEmptyLines: true,
    delimiter,
    dynamicTyping: false,
    transformHeader: (h: string, i: number) => {
      const name = i === 0 ? h.replace(/^﻿/, "") : h;
      return name.trim() === "" ? `column_${i + 1}` : name;
    },
    step: (res: Papa.ParseStepResult<Record<string, unknown>>, p: Papa.Parser) => {
      parser = p;
      const fatal = (res.errors ?? []).filter((e) => e.code !== "UndetectableDelimiter");
      if (fatal.length > 0) {
        failure = new Error(`CSV parse error on row ${fatal[0].row}: ${fatal[0].message}`);
        p.abort();
        return;
      }
      if (res.data && typeof res.data === "object") queue.push(res.data);
      if (queue.length >= 2_000 && !paused) { paused = true; p.pause(); }
      notify();
    },
    complete: () => { finished = true; notify(); },
    error: (e: Error) => { failure = e; finished = true; notify(); },
  } as any);

  try {
    let i = 0;
    for (;;) {
      if (i < queue.length) {
        yield queue[i++];
        if (i === queue.length) { queue.length = 0; i = 0; }
        if (paused && queue.length - i < 500) { paused = false; (parser as Papa.Parser | null)?.resume(); }
        continue;
      }
      if (failure) throw failure;
      if (finished) return;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  } finally {
    if (!finished) (parser as Papa.Parser | null)?.abort();
    input.destroy();
  }
}

async function countLines(path: string): Promise<number> {
  let lines = 0;
  let last = 0x0a;
  for await (const chunk of fs.createReadStream(path)) {
    const buf = chunk as Buffer;
    for (let i = buf.indexOf(0x0a); i !== -1; i = buf.indexOf(0x0a, i + 1)) lines++;
    if (buf.length > 0) last = buf[buf.length - 1];
  }
  return last === 0x0a ? lines : lines + 1;
}
