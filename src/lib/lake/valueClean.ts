/**
 * Cell-level type detection and cleaning for lake ingestion.
 *
 * Split out from tables.ts because it's used from two directions: the type
 * VOTE (what type does this column look like?) and the value CLEAN (given a
 * decided column type, what should this raw cell actually be stored as?).
 * Both need the exact same parsing rules or a column could be classified
 * "number" by inferColumns and then have its own cells fail to clean — the
 * two functions drifting apart is how you get a column labelled correctly
 * with unusable values in it.
 *
 * The problem this exists for: inferColumns() used to call a cell "number"
 * only if it matched `/^-?\d+(\.\d+)?$/` exactly, so "$1,299.00", "45%",
 * "1,234" and "01/15/2024" all fell through to "text" — a single stray
 * "N/A" among 50,000 clean numbers poisoned the whole column the same way.
 * Downstream, every generated chart and KPI filters columns by exactly this
 * type field (autoCurf.ts, autoCurfMulti.ts), so a mistyped column can't be
 * charted at all — the data is fine, the label is wrong.
 *
 * There's a second, more serious layer underneath: every lake column is
 * stored as TEXT (see tables.ts's own header comment), and every generated
 * aggregate does `SUM(CAST(col AS REAL))`. SQLite's CAST-to-REAL returns 0
 * for a string that doesn't start with a digit — so even a column correctly
 * LABELLED "number" would silently sum to 0 if the stored text still reads
 * "$1,299.00". Fixing the label alone is cosmetic; the raw values written to
 * disk have to be cleaned too. That's why cleanForType() exists as a
 * standalone export — tables.ts calls it at write time, not just at
 * classification time.
 */

/**
 * Tokens that mean "no value" in a spreadsheet, case-insensitively. Any of
 * these, alone in a cell (surrounding whitespace ignored), is treated as
 * null — never counted as a text vote, never counted as a broken number.
 * A single "N/A" among clean numbers used to poison the whole column to
 * "text"; this is the fix for that specific failure.
 */
const NULL_TOKENS = new Set([
  "", "n/a", "na", "n.a.", "#n/a", "#n/a n/a", "-", "--", "—", "–",
  "null", "none", "nil", "nan", "tbd", "unknown", "?",
]);

export function isNullToken(raw: string): boolean {
  return NULL_TOKENS.has(raw.trim().toLowerCase());
}

/**
 * Does this raw cell mean "no value" for a column of THIS type?
 *
 * The null-token denylist above exists so a single "N/A" among clean
 * numbers can't poison a column to "text". Applied to a TEXT column it
 * destroys data instead: "nan" is Nan province, "na" is Namibia's ISO-2
 * code, and "none"/"unknown"/"tbd"/"-" are real category labels — a
 * distinct value, not a missing one.
 *
 * It also did so invisibly: inferColumns skips these same tokens when
 * voting, so the column still reports type "text" with a healthy sample
 * while the cell has already been nulled. Found on a 77-row province
 * upload where exactly one row — Nan, slug "nan" — came back null and the
 * map silently rendered 76 provinces with no error anywhere.
 *
 * In a text column only a genuinely empty cell is null. Shared by the
 * SQLite and DuckDB write paths so the two engines can't drift on it.
 */
export function meansNull(raw: string, type: CellType): boolean {
  return type === "text" ? raw.trim() === "" : isNullToken(raw);
}

// Currency symbols worth stripping before the numeric test. Includes ฿
// (Thai Baht) alongside the usual set — Curf's primary market ships THB
// figures through this exact path constantly (see currency.ts's own
// default-currency handling).
const CURRENCY_SYMBOLS = /[$€£¥₹฿₩₫]/g;

// The baht written out rather than as ฿ — "1,200 บาท", "THB 1,200",
// "1,200 Baht" — as Thai POS and accounting exports print it. A symbol
// alone was stripped; the word left the whole column as text.
const BAHT_PREFIX = /^(?:thb|baht)\s*/i;
const BAHT_SUFFIX = /\s*(?:บาท|thb|baht)$/i;

/**
 * Thai digits (๐-๙) as ASCII. Some Thai government and POS exports print
 * them; without this a column of "๑,๒๐๐" is text and a date "๑๕/๐๑/๒๕๖๗"
 * is no date at all.
 */
function asciiDigits(s: string): string {
  return /[๐-๙]/.test(s) ? s.replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0e50)) : s;
}

/**
 * Attempt to read `raw` as a number, tolerant of the formatting a human
 * actually types into a spreadsheet: currency symbols, thousands
 * separators, a trailing percent sign, and accounting-style parens for a
 * negative ("(1,234.56)" → "-1234.56"). Returns the cleaned numeric string
 * (still text — the lake stores everything as TEXT) or null if the cell
 * isn't a number once that formatting is stripped.
 *
 * A percent sign is stripped, not divided by 100: "45%" becomes "45", not
 * "0.45". That matches how a plain "45" typed with no symbol would already
 * be stored, and lines up with autoCurf.ts's percentStoredAsPoints() —
 * which already detects point-scaled (0-100) vs fraction-scaled (0-1)
 * percent columns from the data rather than assuming one convention, so a
 * bare-number result here reads correctly either way.
 */
export function cleanNumericToken(raw: string): string | null {
  let s = asciiDigits(raw.trim());
  if (s === "") return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (s.startsWith("-")) { negative = true; s = s.slice(1); }
  else if (s.startsWith("+")) { s = s.slice(1); }
  s = s.replace(CURRENCY_SYMBOLS, "").replace(BAHT_PREFIX, "").replace(BAHT_SUFFIX, "").trim();
  // "1,200.-" is how a Thai price tag writes a whole-baht amount.
  if (s.endsWith(".-")) s = s.slice(0, -2);
  if (s.endsWith("%")) s = s.slice(0, -1).trim();
  // Commas are only stripped when they're genuine thousands-grouping
  // ("1,234", "12,345,678.90") — validated BEFORE stripping. A blanket
  // strip-then-test would turn "1,2,3" (a malformed list, not a number)
  // into "123", silently fabricating a value nobody typed.
  if (s.includes(",")) {
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return null;
    s = s.replace(/,/g, "");
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  // A leading zero on a multi-digit integer ("00501", "007") is almost
  // always an identifier — a ZIP code, a member number — not a quantity;
  // real quantities don't get typed with padding. Refuse to classify these
  // as numbers at all rather than round-trip them through Number() and
  // silently drop the leading zero on write (turning a ZIP "00501" into a
  // stored "501" would be actively worse than the old code's behaviour,
  // which at least left the original text on disk even when it mislabelled
  // the column). A genuine decimal like "0.5" is unaffected.
  if (/^0\d/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return (negative && n !== 0 ? -n : n).toString();
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

// Thai month names, full and abbreviated, keyed with dots and spaces
// removed ("ม.ค." → "มค") so every way people punctuate them matches.
const THAI_MONTHS: Record<string, number> = {
  มกราคม: 1, มค: 1, กุมภาพันธ์: 2, กพ: 2, มีนาคม: 3, มีค: 3, เมษายน: 4, เมย: 4,
  พฤษภาคม: 5, พค: 5, มิถุนายน: 6, มิย: 6, กรกฎาคม: 7, กค: 7, สิงหาคม: 8, สค: 8,
  กันยายน: 9, กย: 9, ตุลาคม: 10, ตค: 10, พฤศจิกายน: 11, พย: 11, ธันวาคม: 12, ธค: 12,
};

// "15 ม.ค. 2567", "15 มกราคม พ.ศ. 2567", "15-ม.ค.-67".
const THAI_MONTH_DATE = /^(\d{1,2})[\s/-]*([ก-๎.]+?)[\s/-]*(?:(พ\.?\s?ศ\.?|ค\.?\s?ศ\.?)\s*)?(\d{2}|\d{4})$/;

/**
 * A Buddhist-era year (พ.ศ., CE + 543) as the Common-Era year the lake
 * stores. Thai systems print พ.ศ. — "15/01/2567" is 15 January 2024 — and
 * reading it literally stored the year 2567, 543 years off, where every
 * date filter, trend and comparison silently missed it. A year in
 * 2400-2700 can only be พ.ศ. in business data (CE 1857-2157); anything
 * outside is left as it is, including sentinels like 9999-12-31.
 */
function commonEraYear(y: number): number {
  return y >= 2400 && y <= 2700 ? y - 543 : y;
}

function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }

/** True if y/m/d name a real calendar date — rejects "13/45/2024" style
 *  garbage that would otherwise slip past the individual range checks. */
function isValidYMD(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(y, m, 0).getDate();
  return d <= daysInMonth;
}

export type DateOrder = "mdy" | "dmy";

const SLASH_DATE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;

/**
 * Attempt to read `raw` as a date, returning canonical `YYYY-MM-DD` (or
 * null). Recognizes the formats a spreadsheet export actually produces:
 * ISO already, slash/dash dates, and the two common orderings of a written
 * month name ("Jan 15, 2024", "15 Jan 2024").
 *
 * A bare "03/04/2024" is genuinely ambiguous — it is a valid date under
 * both conventions, so no amount of looking at THIS cell decides it. The
 * order therefore comes from the caller, and callers get it from
 * detectDateOrder() over the whole column, where "13/04/2024" one row down
 * settles it with certainty.
 *
 * The previous behaviour was to always read month-first and let anything
 * else fail. That looks conservative and isn't: a day-first column is
 * mostly days 13-31, each of which failed to parse, so the column lost the
 * type vote and landed as text. Non-US dates didn't become wrong dates —
 * they stopped being dates at all.
 */
export function cleanDateToken(raw: string, order: DateOrder = "mdy"): string | null {
  const s = asciiDigits(raw.trim());
  if (s === "") return null;
  const ymd = (y: number, m: number, d: number) => {
    const year = commonEraYear(y);
    return isValidYMD(year, m, d) ? `${year}-${pad2(m)}-${pad2(d)}` : null;
  };

  // Already ISO (date or datetime) — keep the date part (a พ.ศ. year
  // becomes its Common-Era year, see commonEraYear()).
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/.exec(s);
  if (iso) return ymd(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const slash = SLASH_DATE.exec(s);
  if (slash) {
    const first = Number(slash[1]), second = Number(slash[2]), y = Number(slash[3]);
    const m = order === "dmy" ? second : first;
    const d = order === "dmy" ? first : second;
    return ymd(y, m, d);
  }

  // "Jan 15, 2024" / "January 15 2024"
  const monFirst = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (monFirst) {
    const mon = MONTHS[monFirst[1].toLowerCase()];
    const out = mon ? ymd(Number(monFirst[3]), mon, Number(monFirst[2])) : null;
    if (out) return out;
  }

  // "15 Jan 2024" / "15 January 2024"
  const dayFirst = /^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(s);
  if (dayFirst) {
    const mon = MONTHS[dayFirst[2].toLowerCase()];
    const out = mon ? ymd(Number(dayFirst[3]), mon, Number(dayFirst[1])) : null;
    if (out) return out;
  }

  // "15 ม.ค. 2567" / "15 มกราคม พ.ศ. 2567" / "15 ม.ค. 67". A Thai month
  // name dates the year in พ.ศ. unless the cell says ค.ศ.; a two-digit
  // year is the short พ.ศ. form ("67" = 2567).
  const thai = THAI_MONTH_DATE.exec(s);
  if (thai) {
    const mon = THAI_MONTHS[thai[2].replace(/[.\s]/g, "")];
    const commonEra = !!thai[3] && thai[3].startsWith("ค");
    let y = Number(thai[4]);
    if (thai[4].length === 2) y += commonEra ? 2000 : 2500;
    if (!commonEra && y >= 2400) y -= 543;
    if (mon && isValidYMD(y, mon, Number(thai[1]))) return `${y}-${pad2(mon)}-${pad2(Number(thai[1]))}`;
  }

  return null;
}

/**
 * Decide slash-date order for a WHOLE column. One cell can't settle it;
 * a column almost always can, because a day above 12 can only be a day.
 *
 * `ambiguous` means the column HAS slash-style values (SLASH_DATE-shaped)
 * but offered no proof either way — every value had both components ≤ 12
 * (rare beyond a handful of rows), or the column contains proof of BOTH
 * orders and so disagrees with itself. Callers with a user present should
 * ask; unattended callers take `order` and move on.
 *
 * A column with NO slash-style values at all — pure ISO (YYYY-MM-DD),
 * "Jan 15 2024", or empty — is never ambiguous: `order` doesn't apply to
 * those formats in the first place (cleanDateToken's ISO and month-name
 * branches above don't consult it), so there's nothing to ask about. Found
 * live via an A3 Verify upload E2E pass (2026-09-20): a plain ISO-dated CSV
 * column was flagged "ambiguous" and shown a date-order toggle that had no
 * effect on how the column would actually be parsed.
 */
export function detectDateOrder(values: Iterable<string>): { order: DateOrder; ambiguous: boolean } {
  let dmyProof = false;   // first component > 12 — can only be a day
  let mdyProof = false;   // second component > 12 — can only be a day
  let sawSlashDate = false;
  for (const v of values) {
    if (typeof v !== "string") continue;
    const m = SLASH_DATE.exec(asciiDigits(v.trim()));
    if (!m) continue;
    sawSlashDate = true;
    if (Number(m[1]) > 12) dmyProof = true;
    if (Number(m[2]) > 12) mdyProof = true;
    if (dmyProof && mdyProof) break;
  }
  if (dmyProof && !mdyProof) return { order: "dmy", ambiguous: false };
  if (mdyProof && !dmyProof) return { order: "mdy", ambiguous: false };
  if (!sawSlashDate) return { order: "mdy", ambiguous: false };
  // Slash-dates ARE present but every one had both components ≤ 12, or the
  // column disagrees with itself. Month-first is the fallback because it's
  // what this parser has always done — changing the silent default would
  // retroactively reinterpret every unattended webhook/pull feed that's
  // been landing correctly. The preview surfaces this case so an upload
  // with a human present never rides on the fallback.
  return { order: "mdy", ambiguous: true };
}

export type CellType = "text" | "number" | "boolean" | "date" | "unknown";

/**
 * Classify one raw cell. Order matters: number is tried before date (a bare
 * "2024" or "20240115" is far more likely a number than a date), and
 * boolean only matches the literal tokens "true"/"false" — deliberately not
 * "yes"/"no"/"1"/"0", which are common non-boolean categorical values
 * ("Active"/"Inactive" surveys, binary flags meant to stay numeric) and
 * would produce more false positives than the type is worth detecting
 * automatically. A column that's genuinely boolean-but-"yes"/"no" can still
 * be retyped explicitly (retypeColumn in tables.ts), which trusts the
 * user's stated intent rather than guessing from the data alone.
 */
export function detectCellType(raw: string): CellType {
  if (cleanNumericToken(raw) !== null) return "number";
  const lower = raw.trim().toLowerCase();
  if (lower === "true" || lower === "false") return "boolean";
  // Either order counts as a date for VOTING purposes. Which order it
  // actually is gets settled per-column by detectDateOrder; asking that
  // here would fail "13/04/2024" for being month-13 and hand the column's
  // vote to text, which is how day-first columns used to stop being dates.
  if (cleanDateToken(raw, "mdy") !== null || cleanDateToken(raw, "dmy") !== null) return "date";
  return "text";
}

/**
 * Given a column's DECIDED type (from majority vote, or an explicit user
 * retype) and one raw cell, produce the value to store. A cell that can't
 * be cleaned to the column's type is left as its original raw text rather
 * than nulled out or dropped — an unparseable "Pending" in an otherwise-
 * numeric column is real data; forcing it to null would silently discard
 * something the user typed, and CAST(... AS REAL) on that one row already
 * degrades gracefully (0/NULL) without help from this layer.
 */
export function cleanForType(raw: string, type: CellType, opts?: { dateOrder?: DateOrder }): string {
  if (type === "number") return cleanNumericToken(raw) ?? raw;
  if (type === "date") return cleanDateToken(raw, opts?.dateOrder ?? "mdy") ?? raw;
  if (type === "boolean") {
    const lower = raw.trim().toLowerCase();
    if (lower === "true" || lower === "false") return lower;
    return raw;
  }
  return raw;
}
