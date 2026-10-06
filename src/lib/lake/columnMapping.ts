/**
 * Map a file's own columns onto a standard dataset (standardDatasets.ts):
 * suggest which column is which, check a mapping is complete, and turn each
 * row of the file into a row of the standard table.
 *
 * Suggestions come from header names (a Thai + English synonym list per
 * field) and are only offered when the column's actual values fit the
 * field — a "Day" column of weekday names is not a date, a "Total" column
 * of text is not an amount. They are suggestions: the user confirms the
 * mapping before anything is imported, and a file whose layout was
 * confirmed before is recognised by its headers (headerSignature) and
 * mapped the same way again.
 */
import { createHash } from "node:crypto";
import { cleanDateToken, cleanNumericToken, detectDateOrder, isNullToken, type DateOrder } from "./valueClean";
import {
  SOURCE_FILE_COLUMN,
  type StandardDataset,
  type StandardField,
} from "./standardDatasets";

/** Where one standard field's value comes from: a column of the file, or one value typed for every row. */
export type FieldSource = { column: string } | { value: string };
/** Standard field key → its source. A field left out is not in this file. */
export type ColumnMapping = Record<string, FieldSource>;

export type SuggestionOrigin = "saved" | "name" | "filename";
export type MappingSuggestion = {
  mapping: ColumnMapping;
  origin: Record<string, SuggestionOrigin>;
};

/** What the sampled values of one file column look like. */
export type ColumnProfile = {
  name: string;
  /** Share of non-empty sample values that read as each kind (0–1). */
  numeric: number;
  date: number;
  /** 20260921-style whole numbers — an ERP's date key. */
  ymd: number;
  nonEmpty: number;
};

const FIT = 0.8;

export function normalizeHeader(h: string): string {
  return h.normalize("NFC").toLowerCase().replace(/[\s_\-./()#:\[\]'",]+/g, "");
}

/** Header words: "Items_location" → items, location; "ItemName" → item, name. */
function headerTokens(h: string): string[] {
  return h
    .normalize("NFC")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_\-./()#:\[\]'",]+/)
    .filter(Boolean);
}

/**
 * How strongly `header` names `field` — 0 for not at all. An exact synonym
 * beats a whole-word match beats a substring; synonyms earlier in the list
 * are the more specific ones and win a tie; every extra synonym that also
 * matches adds a little (inv_soh_qty matches "soh" AND "sohqty", so it is
 * the on-hand quantity rather than inv_soh_cost_amt, which only has "soh").
 */
export function headerScore(header: string, field: StandardField): number {
  const norm = normalizeHeader(header);
  const tokens = headerTokens(header);
  let best = 0;
  let matches = 0;
  field.synonyms.forEach((raw, i) => {
    const exactOnly = raw.startsWith("=");
    const syn = exactOnly ? raw.slice(1) : raw;
    let s = 0;
    if (norm === syn) s = 3;
    else if (!exactOnly && tokens.includes(syn)) s = 2.5;
    else if (!exactOnly && syn.length >= 4 && norm.includes(syn)) s = 2;
    if (s > 0) {
      matches += 1;
      best = Math.max(best, s - i * 0.001);
    }
  });
  return best === 0 ? 0 : best + 0.05 * (matches - 1);
}

function isYmdNumber(v: unknown): boolean {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  return /^\d{8}$/.test(s) && ymdToIso(s) !== null;
}

function ymdToIso(s: string): string | null {
  const y = Number(s.slice(0, 4)), m = Number(s.slice(4, 6)), d = Number(s.slice(6, 8));
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  if (d > new Date(y, m, 0).getDate()) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

const NAME_DATE = /(?<!\d)(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})(?!\d)/g;

/**
 * The one day a file's name says it is for, or null. A POS names a day's
 * summary after the day ("item-sales-summary-2025-03-27-2025-03-27.csv",
 * "stock_20260921.xlsx") and puts no date column inside. A name with two
 * different dates is a range, which has no single date to give every row.
 */
export function dateFromFilename(filename: string): string | null {
  const found = new Set<string>();
  for (const m of filename.matchAll(NAME_DATE)) {
    const iso = ymdToIso(m[1] + m[2] + m[3]);
    if (iso) found.add(iso);
  }
  return found.size === 1 ? [...found][0] : null;
}

function asText(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" || isNullToken(s) ? null : s;
}

// A POS stamps each line with date AND time ("21/09/2026 14:35", "15 ม.ค.
// 2567 09:05:12 น."). The date field takes the date part — sale_time keeps
// the time (hhmm below). Only here: a generic upload keeps a date-time
// column's full text rather than silently dropping its time.
const TRAILING_TIME = /[\sT]+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*(?:[ap]\.?m\.?|น\.?))?$/i;

function dateOnly(s: string): string {
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s : s.replace(TRAILING_TIME, "");
}

/**
 * Day-first or month-first for one source column, decided over its values
 * with any time of day stripped first — "01/09/2569 10:15" would otherwise
 * not read as a slash date at all, the column would "prove" nothing and
 * fall back to month-first: 1 September imported as 9 January. When the
 * values prove neither order, day-first — how Thai POS systems write dates
 * — flagged `ambiguous` so the mapping step asks.
 */
export function columnDateOrder(values: unknown[]): { order: DateOrder; ambiguous: boolean } {
  const texts = values.map(asText).filter((s): s is string => s !== null).map(dateOnly);
  const d = detectDateOrder(texts);
  if (d.ambiguous) return { order: "dmy", ambiguous: true };
  // No slash dates at all (ISO, month names): the order never applies.
  if (!texts.some((s) => SLASH_DATE_SHAPE.test(s))) return { order: "dmy", ambiguous: false };
  return d;
}

const SLASH_DATE_SHAPE = /^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/;

function readsAsDate(s: string): boolean {
  const d = dateOnly(s);
  return cleanDateToken(d, "dmy") !== null || cleanDateToken(d, "mdy") !== null;
}

/** Profile every column from sample rows (keys of the first row decide the columns). */
export function profileColumns(rows: Array<Record<string, unknown>>): ColumnProfile[] {
  const names = rows.length > 0 ? Object.keys(rows[0]) : [];
  return names.map((name) => {
    let nonEmpty = 0, numeric = 0, date = 0, ymd = 0;
    for (const r of rows) {
      const v = r[name];
      const s = asText(v);
      if (s === null) continue;
      nonEmpty += 1;
      if (typeof v === "number" || cleanNumericToken(s) !== null) numeric += 1;
      if (readsAsDate(s)) date += 1;
      if (isYmdNumber(v)) ymd += 1;
    }
    const share = (n: number) => (nonEmpty === 0 ? 0 : n / nonEmpty);
    return { name, numeric: share(numeric), date: share(date), ymd: share(ymd), nonEmpty };
  });
}

/**
 * Can this column's values fill this field? A column blank all through the
 * sample can't fill a required field (every row would be skipped), but it
 * may fill an optional one: a promotion code or a discount is blank on most
 * lines of a POS export, and in the first few thousand rows of a file
 * sorted by date it can be blank on all of them. Values that turn up later
 * are cleaned per type like any other; a blank stays blank. suggestMapping
 * only offers such a column when its header names the field outright.
 */
export function fits(field: StandardField, col: ColumnProfile): boolean {
  if (col.nonEmpty === 0) return !field.required && !field.requiredGroup;
  if (field.type === "number") return col.numeric >= FIT;
  if (field.type === "date") return col.date >= FIT || col.ymd >= FIT;
  return true;
}

/**
 * Identifies a file layout by its headers, order and case ignored, so next
 * month's export from the same POS is recognised and mapped as before.
 */
export function headerSignature(headers: string[]): string {
  const norm = [...new Set(headers.map(normalizeHeader))].sort();
  return createHash("sha256").update(norm.join("\u0000")).digest("hex").slice(0, 32);
}

/**
 * Suggest a mapping. A saved mapping for this layout wins for every field it
 * covers whose column is still there; the rest are matched by name, best
 * match first, each column used once and only where its values fit.
 */
export function suggestMapping(
  ds: StandardDataset,
  columns: ColumnProfile[],
  saved?: ColumnMapping | null,
  filename?: string,
): MappingSuggestion {
  const mapping: ColumnMapping = {};
  const origin: Record<string, SuggestionOrigin> = {};
  const used = new Set<string>();
  const byName = new Map(columns.map((c) => [c.name, c]));

  for (const f of ds.fields) {
    const src = saved?.[f.key];
    if (!src) continue;
    if ("value" in src) {
      // A date typed for one file is that file's date: the next day's file
      // of the same layout must not inherit it.
      if (f.allowFixed && f.type !== "date") { mapping[f.key] = src; origin[f.key] = "saved"; }
    } else if (byName.has(src.column) && !used.has(src.column)) {
      mapping[f.key] = src;
      origin[f.key] = "saved";
      used.add(src.column);
    }
  }

  const candidates: Array<{ field: StandardField; column: string; score: number }> = [];
  for (const f of ds.fields) {
    if (mapping[f.key]) continue;
    for (const c of columns) {
      if (used.has(c.name) || !fits(f, c)) continue;
      // No values to back a loose match: a blank column needs a header that
      // names the field — a synonym exactly, or as a whole word.
      if (c.nonEmpty === 0 && headerScore(c.name, f) < 2.5) continue;
      const score = headerScore(c.name, f);
      if (score > 0) candidates.push({ field: f, column: c.name, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    if (mapping[c.field.key] || used.has(c.column)) continue;
    mapping[c.field.key] = { column: c.column };
    origin[c.field.key] = "name";
    used.add(c.column);
  }

  // No date column in the file: the file's own name may say the day. Not
  // when some unclaimed column holds dates — then the day is in the file,
  // under a header no synonym knows, and the name is only when it was exported.
  const named = filename ? dateFromFilename(filename) : null;
  if (named) {
    for (const f of ds.fields) {
      if (f.type === "date" && f.allowFixed && !mapping[f.key] && !columns.some((c) => !used.has(c.name) && c.nonEmpty > 0 && fits(f, c))) {
        mapping[f.key] = { value: named };
        origin[f.key] = "filename";
      }
    }
  }
  return { mapping, origin };
}

/** Will this unmapped field be worked out from mapped ones (StandardField.derivedFrom)? */
export function isDerived(field: StandardField, mapping: ColumnMapping): boolean {
  return !!field.derivedFrom && field.derivedFrom.every((k) => !!mapping[k]);
}

/**
 * What stops this mapping from importing — empty when it can. Checked on
 * the server before the import starts and again against the file's real
 * headers when it runs; the dialog shows the same list.
 */
export function mappingProblems(ds: StandardDataset, mapping: ColumnMapping, headers: string[]): string[] {
  const problems: string[] = [];
  const known = new Set(ds.fields.map((f) => f.key));
  for (const key of Object.keys(mapping)) {
    if (!known.has(key)) problems.push(`"${key}" is not a field of ${ds.tableName}.`);
  }
  const usedColumns = new Map<string, string>();
  for (const f of ds.fields) {
    const src = mapping[f.key];
    if (!src) continue;
    if ("value" in src) {
      if (!f.allowFixed) problems.push(`${f.key} has to come from a column of the file.`);
      else if (src.value.trim() === "") problems.push(`${f.key}: type a value or pick a column.`);
      else if (f.type === "date" && cleanDate(src.value, "dmy") === null) problems.push(`${f.key}: "${src.value}" is not a date.`);
      continue;
    }
    if (!headers.includes(src.column)) problems.push(`${f.key}: the file has no column "${src.column}".`);
    const other = usedColumns.get(src.column);
    if (other) problems.push(`"${src.column}" is mapped to both ${other} and ${f.key}.`);
    usedColumns.set(src.column, f.key);
  }
  for (const f of ds.fields) {
    if (f.required && !mapping[f.key] && !isDerived(f, mapping)) {
      problems.push(f.derivedFrom
        ? `${f.key} is needed — map a column for it, or the columns it can be worked out from.`
        : `${f.key} is needed.`);
    }
  }
  const groups = new Set(ds.fields.map((f) => f.requiredGroup).filter((g): g is string => !!g));
  for (const g of groups) {
    const members = ds.fields.filter((f) => f.requiredGroup === g);
    if (!members.some((f) => mapping[f.key])) problems.push(`Map at least one of: ${members.map((f) => f.key).join(", ")}.`);
  }
  return problems;
}

function cleanDate(v: unknown, order: DateOrder): string | null {
  if (isYmdNumber(v)) return ymdToIso(String(v).trim());
  const s = asText(v);
  return s === null ? null : cleanDateToken(dateOnly(s), order);
}

function cleanNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = asText(v);
  if (s === null) return null;
  const n = cleanNumericToken(s);
  return n === null ? null : Number(n);
}

const TIME = /(\d{1,2}):(\d{2})/;

function hhmm(v: unknown): string | null {
  const s = asText(v);
  const m = s ? TIME.exec(s) : null;
  if (!m) return null;
  const h = Number(m[1]);
  return h > 23 ? null : `${String(h).padStart(2, "0")}:${m[2]}`;
}

export type MappedRow = { row: Record<string, unknown> } | { skipped: string };

/**
 * Turn rows of the file into rows of the standard table. A row missing
 * something the table can't do without — no date, no quantity, no item —
 * is skipped with the reason, not imported half-empty: those are usually
 * a POS export's own total and subtotal lines.
 */
export function makeRowMapper(
  ds: StandardDataset,
  mapping: ColumnMapping,
  opts: { dateOrders?: Record<string, DateOrder>; sourceFile: string },
): (raw: Record<string, unknown>) => MappedRow {
  const read = (key: string, raw: Record<string, unknown>): unknown => {
    const src = mapping[key];
    if (!src) return undefined;
    return "value" in src ? src.value : raw[src.column];
  };
  const orderFor = (key: string): DateOrder => {
    const src = mapping[key];
    return (src && "column" in src && opts.dateOrders?.[src.column]) || "dmy";
  };

  return (raw) => {
    const out: Record<string, unknown> = {};
    for (const f of ds.fields) {
      const v = read(f.key, raw);
      out[f.key] = v === undefined ? null
        : f.type === "date" ? cleanDate(v, orderFor(f.key))
        : f.type === "number" ? cleanNumber(v)
        : asText(v);
    }

    if (ds.id === "sales_lines") {
      if (mapping.sale_time) out.sale_time = hhmm(read("sale_time", raw));
      else if (mapping.sale_date) out.sale_time = hhmm(read("sale_date", raw));
      if (!mapping.net_amount && typeof out.qty === "number" && typeof out.unit_price === "number") {
        out.net_amount = out.qty * out.unit_price - (typeof out.discount === "number" ? out.discount : 0);
      }
      // A POS writes 0 in its cost column for an item nobody has entered a
      // cost for. Sold for money at a cost of 0 is "not given", not a 100%
      // margin — the margin reports then list the item as having no cost.
      if (out.cost === 0 && typeof out.net_amount === "number" && out.net_amount > 0) out.cost = null;
    }
    if (ds.id === "inventory") {
      // The same 0 in a stock count: no cost entered, not stock worth nothing.
      if (out.unit_cost === 0) out.unit_cost = null;
      if (!mapping.stock_value && typeof out.on_hand === "number" && typeof out.unit_cost === "number") {
        out.stock_value = out.on_hand * out.unit_cost;
      }
    }

    for (const f of ds.fields) {
      if (f.required && (out[f.key] === null || out[f.key] === undefined)) return { skipped: f.key };
    }
    const groups = new Set(ds.fields.map((f) => f.requiredGroup).filter((g): g is string => !!g));
    for (const g of groups) {
      if (!ds.fields.some((f) => f.requiredGroup === g && out[f.key] != null)) return { skipped: g };
    }
    out[SOURCE_FILE_COLUMN] = opts.sourceFile;
    return { row: out };
  };
}
