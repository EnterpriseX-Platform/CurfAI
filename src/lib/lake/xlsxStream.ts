/**
 * Streaming XLSX reader for Curf Tables uploads.
 *
 * exceljs's Workbook.xlsx.load() builds the whole workbook in memory. That
 * is fine for a few MB and fatal for what customers actually export from
 * their ERP: a 127 MB workbook whose one sheet is 771 MB of XML and
 * 1,048,575 rows needs several GB of heap, far past the pod's 1 Gi. exceljs
 * has a streaming reader too, but it walks the zip front to back — and when
 * the sheet is stored before sharedStrings.xml (Excel does this) it copies
 * the entire sheet to a temp file before it can emit a single row: minutes
 * before a preview can show anything, and hundreds of MB of ephemeral disk.
 *
 * This reader opens the zip by its central directory (random access), loads
 * the small parts first — workbook, relationships, styles, shared strings —
 * then streams just the requested sheet through a SAX parser, one row at a
 * time. Memory is the shared-string table plus the row being built.
 *
 * Output matches what the exceljs path produced, so type inference and
 * cleaning downstream see the same values: the first non-empty row is the
 * header, blank header cells become col_N, numbers stay numbers, date-
 * formatted numbers become ISO strings, formulas give their cached result,
 * and rows with no values are skipped.
 */
import { Open, type CentralDirectory, type CentralDirectoryFile } from "unzipper";
import { SaxesParser } from "saxes";

export type XlsxWorkbook = {
  /** Worksheet names in workbook order. */
  sheets: string[];
  /** Header-keyed rows of one sheet (the first sheet when unnamed), streamed. */
  rows(sheet?: string): AsyncGenerator<Record<string, unknown>>;
  /**
   * The sheet's row count from its <dimension> element, header included —
   * read from the first few KB of the sheet, not by scanning it. Null when
   * the writer left the element out.
   */
  declaredRowCount(sheet?: string): Promise<number | null>;
  /** The resolved name of `sheet` (the first sheet when unnamed). */
  resolveSheet(sheet?: string): string;
};

type SheetRef = { name: string; path: string };

export async function openXlsx(source: { path: string } | { buffer: Buffer }): Promise<XlsxWorkbook> {
  let dir: CentralDirectory;
  try {
    dir = "path" in source ? await Open.file(source.path) : await Open.buffer(source.buffer);
  } catch {
    throw new Error("This file isn't a valid .xlsx workbook (it could not be opened as a zip archive).");
  }
  const byPath = new Map<string, CentralDirectoryFile>();
  for (const f of dir.files) if (f.type === "File") byPath.set(f.path.replace(/^\/+/, "").toLowerCase(), f);
  const entry = (p: string) => byPath.get(p.replace(/^\/+/, "").toLowerCase()) ?? null;

  const workbookPath = (await relTargets(entry, "_rels/.rels", ""))
    .find((r) => r.type.endsWith("/officeDocument"))?.target ?? "xl/workbook.xml";
  const workbookDir = workbookPath.includes("/") ? workbookPath.slice(0, workbookPath.lastIndexOf("/") + 1) : "";
  const workbookRels = await relTargets(
    entry,
    `${workbookDir}_rels/${workbookPath.slice(workbookDir.length)}.rels`,
    workbookDir,
  );
  const { sheetRefs: rawSheets, date1904 } = await readWorkbook(entry(workbookPath));
  const relById = new Map(workbookRels.map((r) => [r.id, r]));
  const sheets: SheetRef[] = [];
  for (const s of rawSheets) {
    const rel = relById.get(s.relId);
    // Chart sheets and anything else that isn't a grid of cells are skipped,
    // the same set exceljs exposed as wb.worksheets.
    if (rel && rel.type.endsWith("/worksheet")) sheets.push({ name: s.name, path: rel.target });
  }
  if (sheets.length === 0) throw new Error("Spreadsheet had no sheets");

  const sharedStringsPath = workbookRels.find((r) => r.type.endsWith("/sharedStrings"))?.target ?? `${workbookDir}sharedStrings.xml`;
  const stylesPath = workbookRels.find((r) => r.type.endsWith("/styles"))?.target ?? `${workbookDir}styles.xml`;

  let shared: Promise<string[]> | null = null;
  let dateStyles: Promise<Set<number>> | null = null;

  function sheetRef(name?: string): SheetRef {
    if (name == null) return sheets[0];
    const found = sheets.find((s) => s.name === name);
    // Naming a sheet that isn't there is a caller bug (a stale sheet list, a
    // renamed tab). Falling back to sheet 1 would import the wrong data under
    // the right-looking name.
    if (!found) throw new Error(`Sheet "${name}" not found. This workbook has: ${sheets.map((s) => s.name).join(", ")}`);
    return found;
  }

  return {
    sheets: sheets.map((s) => s.name),
    resolveSheet: (name) => sheetRef(name).name,
    async declaredRowCount(name) {
      const file = entry(sheetRef(name).path);
      return file ? readDimensionRows(file) : null;
    },
    async *rows(name) {
      const ref = sheetRef(name);
      const file = entry(ref.path);
      if (!file) throw new Error(`Sheet "${ref.name}" is missing from the workbook file.`);
      shared ??= readSharedStrings(entry(sharedStringsPath));
      dateStyles ??= readDateStyles(entry(stylesPath));
      yield* sheetRows(file, ref.name, await shared, await dateStyles, date1904);
    },
  };
}

// ---------------------------------------------------------------------------
// SAX plumbing
// ---------------------------------------------------------------------------

type Handlers = {
  open?: (name: string, attrs: Record<string, string>) => void;
  text?: (text: string) => void;
  close?: (name: string) => void;
};

/** Local name without a namespace prefix — some writers emit <x:row>, <x:c>. */
function local(name: string): string {
  const i = name.indexOf(":");
  return i === -1 ? name : name.slice(i + 1);
}

function newParser(h: Handlers): SaxesParser {
  const p = new SaxesParser({ position: false });
  if (h.open) p.on("opentag", (tag) => h.open!(local(tag.name), tag.attributes as Record<string, string>));
  if (h.text) p.on("text", h.text);
  if (h.close) p.on("closetag", (tag) => h.close!(local(tag.name)));
  return p;
}

/**
 * Feed a zip entry to a SAX parser, calling `drain` after every chunk so a
 * generator can hand over what that chunk produced. `stop()` from a handler
 * ends the read early (the rest of the entry is never decompressed).
 */
async function* parseEntry<T>(
  file: CentralDirectoryFile,
  h: Handlers,
  drain: () => T[],
  isDone: () => boolean = () => false,
): AsyncGenerator<T> {
  const parser = newParser(h);
  const stream = file.stream();
  stream.setEncoding("utf8");
  try {
    for await (const chunk of stream) {
      parser.write(chunk as string);
      for (const item of drain()) yield item;
      if (isDone()) return;
    }
    parser.close();
    for (const item of drain()) yield item;
  } finally {
    stream.destroy();
  }
}

async function readAll(file: CentralDirectoryFile | null, h: Handlers, isDone?: () => boolean): Promise<void> {
  if (!file) return;
  for await (const _ of parseEntry<never>(file, h, () => [], isDone)) { /* handlers do the work */ }
}

// ---------------------------------------------------------------------------
// Workbook parts
// ---------------------------------------------------------------------------

type Rel = { id: string; type: string; target: string };

async function relTargets(
  entry: (p: string) => CentralDirectoryFile | null,
  relsPath: string,
  baseDir: string,
): Promise<Rel[]> {
  const rels: Rel[] = [];
  await readAll(entry(relsPath), {
    open(name, a) {
      if (name !== "Relationship" || !a.Target || a.TargetMode === "External") return;
      rels.push({ id: a.Id ?? "", type: a.Type ?? "", target: resolveTarget(baseDir, a.Target) });
    },
  });
  return rels;
}

/** "worksheets/sheet1.xml" relative to "xl/", or an absolute "/xl/…" path. */
function resolveTarget(baseDir: string, target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : baseDir + target).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== "." && p !== "") out.push(p);
  }
  return out.join("/");
}

async function readWorkbook(file: CentralDirectoryFile | null): Promise<{
  sheetRefs: Array<{ name: string; relId: string }>;
  date1904: boolean;
}> {
  if (!file) throw new Error("This file isn't a valid .xlsx workbook (workbook.xml is missing).");
  const sheetRefs: Array<{ name: string; relId: string }> = [];
  let date1904 = false;
  await readAll(file, {
    open(name, a) {
      if (name === "workbookPr") date1904 = a.date1904 === "1" || a.date1904 === "true";
      if (name === "sheet") {
        // The relationship id is r:id, but the prefix is whatever the writer
        // bound the relationships namespace to.
        const relKey = Object.keys(a).find((k) => k === "id" || k.endsWith(":id"));
        sheetRefs.push({ name: a.name ?? "", relId: relKey ? a[relKey] : "" });
      }
    },
  });
  return { sheetRefs, date1904 };
}

async function readSharedStrings(file: CentralDirectoryFile | null): Promise<string[]> {
  const strings: string[] = [];
  let cur = "";
  let inT = false;
  let phoneticDepth = 0;
  await readAll(file, {
    open(name) {
      if (name === "si") cur = "";
      else if (name === "rPh") phoneticDepth++;
      else if (name === "t") inT = true;
    },
    text(t) { if (inT && phoneticDepth === 0) cur += t; },
    close(name) {
      if (name === "t") inT = false;
      else if (name === "rPh") phoneticDepth--;
      else if (name === "si") strings.push(cur);
    },
  });
  return strings;
}

// Built-in number formats that are dates or times: the standard 14–22 and
// 45–47, the East Asian 27–36 and 50–58, and the Thai 71–81.
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81,
]);

export function isDateFormatCode(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, "")        // quoted literals
    .replace(/\\./g, "")            // escaped characters
    .replace(/\[[^\]]*\]/g, "")     // colours, conditions, locale tags ([$-th-TH])
    .replace(/_.|\*./g, "");         // padding / fill directives
  return /[dmyhsb]/i.test(stripped) && !/^general$/i.test(stripped.trim());
}

async function readDateStyles(file: CentralDirectoryFile | null): Promise<Set<number>> {
  const customFormats = new Map<number, string>();
  const xfFormats: number[] = [];
  let inCellXfs = false;
  await readAll(file, {
    open(name, a) {
      if (name === "numFmt") customFormats.set(Number(a.numFmtId), a.formatCode ?? "");
      else if (name === "cellXfs") inCellXfs = true;
      else if (name === "xf" && inCellXfs) xfFormats.push(Number(a.numFmtId ?? 0));
    },
    close(name) { if (name === "cellXfs") inCellXfs = false; },
  });
  const dates = new Set<number>();
  xfFormats.forEach((fmt, styleIndex) => {
    const custom = customFormats.get(fmt);
    if (custom != null ? isDateFormatCode(custom) : BUILTIN_DATE_FORMATS.has(fmt)) dates.add(styleIndex);
  });
  return dates;
}

async function readDimensionRows(file: CentralDirectoryFile): Promise<number | null> {
  let rows: number | null = null;
  let done = false;
  await readAll(file, {
    open(name, a) {
      if (name === "dimension" && a.ref) {
        const last = a.ref.split(":").pop() ?? "";
        const n = Number(last.replace(/^[A-Za-z$]+/, "").replace(/\$/g, ""));
        rows = Number.isFinite(n) && n > 0 ? n : null;
        done = true;
      } else if (name === "sheetData") {
        done = true; // <dimension> always precedes the data; absent means none.
      }
    },
  }, () => done);
  return rows;
}

// ---------------------------------------------------------------------------
// Sheet rows
// ---------------------------------------------------------------------------

/** "AB12" → 27 (0-based column index), or -1 when the ref has no letters. */
export function columnIndex(ref: string): number {
  let n = 0;
  let i = 0;
  for (; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
    else break;
  }
  return i === 0 ? -1 : n - 1;
}

export function excelSerialToIso(serial: number, date1904: boolean): string | number {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(Math.round(epoch + serial * 86_400_000));
  return Number.isNaN(d.getTime()) ? serial : d.toISOString();
}

async function* sheetRows(
  file: CentralDirectoryFile,
  sheetName: string,
  shared: string[],
  dateStyles: Set<number>,
  date1904: boolean,
): AsyncGenerator<Record<string, unknown>> {
  let headers: string[] | null = null;
  const ready: Array<Record<string, unknown>> = [];

  let cells: unknown[] = [];
  let col = -1;
  let type = "n";
  let style = 0;
  let v: string | null = null;
  let inline = "";
  let inV = false;
  let inIs = false;
  let inT = false;
  let phoneticDepth = 0;

  function cellValue(): unknown {
    switch (type) {
      case "s": {
        const s = v == null ? undefined : shared[Number(v)];
        return s ?? null;
      }
      case "inlineStr": return inline;
      case "str": return v ?? "";
      case "b": return v == null ? null : v === "1" || v === "true";
      case "e": return null; // #N/A, #DIV/0! … carry no value.
      case "d": return v ? new Date(v).toISOString() : null;
      default: {
        if (v == null || v === "") return null;
        const n = Number(v);
        if (!Number.isFinite(n)) return v;
        return dateStyles.has(style) ? excelSerialToIso(n, date1904) : n;
      }
    }
  }

  function endRow() {
    if (!cells.some((x) => x != null && x !== "")) return;
    if (!headers) {
      // Array.from, not .map: a blank header cell has no <c> element, so
      // `cells` has a hole there, and .map would leave the hole unnamed.
      headers = Array.from(cells, (h, i) => {
        const s = h == null ? "" : String(h).trim();
        return s === "" ? `col_${i + 1}` : s;
      });
      return;
    }
    const obj: Record<string, unknown> = {};
    let hasAny = false;
    for (let i = 0; i < headers.length; i++) {
      const value = cells[i] ?? null;
      obj[headers[i]] = value;
      if (value != null && value !== "") hasAny = true;
    }
    if (hasAny) ready.push(obj);
  }

  const handlers: Handlers = {
    open(name, a) {
      switch (name) {
        case "row": cells = []; col = -1; break;
        case "c": {
          const at = a.r ? columnIndex(a.r) : -1;
          col = at >= 0 ? at : col + 1;
          type = a.t ?? "n";
          style = a.s ? Number(a.s) : 0;
          v = null;
          inline = "";
          break;
        }
        case "v": inV = true; v = ""; break;
        case "is": inIs = true; break;
        case "rPh": phoneticDepth++; break;
        case "t": inT = true; break;
      }
    },
    text(t) {
      if (inV) v += t;
      else if (inIs && inT && phoneticDepth === 0) inline += t;
    },
    close(name) {
      switch (name) {
        case "v": inV = false; break;
        case "t": inT = false; break;
        case "rPh": phoneticDepth--; break;
        case "is": inIs = false; break;
        case "c": cells[col] = cellValue(); break;
        case "row": endRow(); break;
      }
    },
  };

  yield* parseEntry(file, handlers, () => ready.splice(0, ready.length));
  if (!headers) throw new Error(`Sheet "${sheetName}" has no header row`);
}
