/**
 * The spreadsheet an admin pastes or uploads to set many people's attributes at once: columns email, attribute,
 * value (a header row is optional). Pure and client-safe: it only reads text and says what it found, row by row,
 * with a problem code (not a sentence) so the page can say it in the reader's language. The server checks again.
 */
import { ATTRIBUTE_VALUES_MAX, ATTRIBUTE_VALUE_MAX_LENGTH, isValidAttributeName, normaliseValues } from "./attributeModel";

export const IMPORT_MAX_ROWS = 5000;
const EMAIL_MAX_LENGTH = 320;
const ATTRIBUTE_NAME_LENGTH_MAX = 100;

export type Delimiter = "\t" | "," | ";";

/** A line from the file: where it was in the file (1-based, counting the header) and its cells. */
export type RawRecord = { line: number; cells: string[] };

export type ImportRow = { line: number; email: string; name: string; value: string };

export type ImportProblemCode =
  | "columns" // fewer than three cells
  | "email" // not an email address
  | "name" // attribute name breaks the naming rule
  | "valueMissing" // blank value (it would silently remove access)
  | "valueTooLong"
  | "valueControl" // a control character in the value
  | "tooManyValues"; // one person, one attribute: more than the engine accepts

export type ImportProblem = { line: number; code: ImportProblemCode; params?: Record<string, string | number> };

export type ImportSet = { email: string; name: string; values: string[] };

export type ParsedImport = {
  delimiter: Delimiter;
  headerSkipped: boolean;
  /** Rows that hold something (blank lines are not counted). */
  totalRows: number;
  rows: ImportRow[];
  problems: ImportProblem[];
  tooMany: boolean;
  sets: ImportSet[];
  people: number;
  /** The attribute names in the file, in the order they first appear: these are the ones the import replaces. */
  attributes: string[];
};

/** Which separator the file uses, from its first line outside quotes: tabs (from a spreadsheet paste) first, then commas, then semicolons. */
export function detectDelimiter(text: string): Delimiter {
  const counts: Record<Delimiter, number> = { "\t": 0, ",": 0, ";": 0 };
  let inQuotes = false;
  let seenContent = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { inQuotes = !inQuotes; seenContent = true; continue; }
    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (seenContent) break;
      continue;
    }
    if (!inQuotes && (ch === "\t" || ch === "," || ch === ";")) counts[ch] += 1;
    if (ch !== " ") seenContent = true;
  }
  if (counts["\t"] >= counts[","] && counts["\t"] >= counts[";"] && counts["\t"] > 0) return "\t";
  if (counts[","] >= counts[";"] && counts[","] > 0) return ",";
  if (counts[";"] > 0) return ";";
  return ",";
}

/** Splits text into records of cells: quoted fields (with "" for a quote and line breaks inside), a BOM, CRLF, LF or CR. Blank lines are dropped. */
export function parseDelimited(input: string, delimiter: Delimiter): RawRecord[] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: RawRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let quoted = false; // the cell had quotes, so an empty string is a real (empty) cell
  let line = 1;
  let startLine = 1;

  const endCell = () => { cells.push(cell); cell = ""; quoted = false; };
  const endRecord = () => {
    endCell();
    const blank = cells.length === 1 && cells[0].trim() === "";
    if (!blank) records.push({ line: startLine, cells });
    cells = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "" && !quoted) { inQuotes = true; quoted = true; continue; }
    if (ch === delimiter) { endCell(); continue; }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      startLine = line;
      continue;
    }
    cell += ch;
  }
  if (cell !== "" || cells.length > 0 || quoted) endRecord();
  return records;
}

/** The first row is a header when its first cell says "email" and is not itself an address. */
export function looksLikeHeader(record: RawRecord | undefined): boolean {
  if (!record) return false;
  const first = record.cells[0]?.trim().toLowerCase() ?? "";
  return first.includes("email") && !first.includes("@");
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function isEmail(value: string): boolean {
  return value.length <= EMAIL_MAX_LENGTH && /^[^\s@]+@[^\s@]+$/.test(value);
}

/** Reads the whole pasted or uploaded text: what is usable, what is wrong (by line), and what it would change. */
export function parseAttributeImport(text: string): ParsedImport {
  const delimiter = detectDelimiter(text);
  let records = parseDelimited(text, delimiter);
  const headerSkipped = looksLikeHeader(records[0]);
  if (headerSkipped) records = records.slice(1);

  const problems: ImportProblem[] = [];
  const rows: ImportRow[] = [];
  for (const record of records) {
    const [rawEmail = "", rawName = "", rawValue = ""] = record.cells;
    const email = rawEmail.trim().toLowerCase();
    const name = rawName.trim();
    const value = rawValue.trim();
    if (record.cells.length < 3) { problems.push({ line: record.line, code: "columns" }); continue; }
    if (!isEmail(email)) { problems.push({ line: record.line, code: "email" }); continue; }
    if (name.length > ATTRIBUTE_NAME_LENGTH_MAX || !isValidAttributeName(name)) { problems.push({ line: record.line, code: "name" }); continue; }
    if (!value) { problems.push({ line: record.line, code: "valueMissing" }); continue; }
    if (value.length > ATTRIBUTE_VALUE_MAX_LENGTH) { problems.push({ line: record.line, code: "valueTooLong", params: { max: ATTRIBUTE_VALUE_MAX_LENGTH } }); continue; }
    if (CONTROL.test(value)) { problems.push({ line: record.line, code: "valueControl" }); continue; }
    rows.push({ line: record.line, email, name, value });
  }

  const sets = new Map<string, ImportSet & { firstLine: number }>();
  for (const row of rows) {
    const key = `${row.email}\u0000${row.name}`;
    const set = sets.get(key) ?? { email: row.email, name: row.name, values: [], firstLine: row.line };
    if (!set.values.includes(row.value)) set.values.push(row.value);
    sets.set(key, set);
  }
  const outSets: ImportSet[] = [];
  for (const set of sets.values()) {
    const normal = normaliseValues(set.values);
    if (!normal.ok) {
      problems.push({ line: set.firstLine, code: "tooManyValues", params: { email: set.email, name: set.name, max: ATTRIBUTE_VALUES_MAX } });
      continue;
    }
    outSets.push({ email: set.email, name: set.name, values: normal.values });
  }
  problems.sort((a, b) => a.line - b.line);

  const attributes: string[] = [];
  for (const set of outSets) if (!attributes.includes(set.name)) attributes.push(set.name);

  return {
    delimiter,
    headerSkipped,
    totalRows: records.length,
    rows,
    problems,
    tooMany: records.length > IMPORT_MAX_ROWS,
    sets: outSets,
    people: new Set(outSets.map((s) => s.email)).size,
    attributes,
  };
}

/** Can this be sent? Only when it holds rows, every row is good, and it fits. */
export function importIsSendable(parsed: ParsedImport): boolean {
  return parsed.rows.length > 0 && parsed.problems.length === 0 && !parsed.tooMany;
}

/** What goes to the server: one entry per good row. */
export function importPayload(parsed: ParsedImport): Array<{ email: string; name: string; value: string }> {
  return parsed.rows.map((r) => ({ email: r.email, name: r.name, value: r.value }));
}
