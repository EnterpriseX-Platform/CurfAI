/**
 * Time buckets on a chart's x axis, and whether the last one is still running.
 *
 * A weekly chart drawn on a Wednesday ends in a week with three days of data:
 * drawn like the others it reads as a crash. `partialLastPeriod` finds that
 * bucket so the chart can draw it dashed and say why. Pure, UTC throughout —
 * a bucket is a calendar range, not an instant.
 *
 * Weeks: "2026-W29" is read the way this platform's own SQL writes it,
 * strftime('%Y-W%W') in SQLite and DuckDB (see lib/reporting/duckdbDialect.ts):
 * Monday-first, week 01 starting on the year's first Monday, week 00 the days
 * of January before it. Not ISO 8601 (that week 29 is a week earlier in 2026);
 * pass `weekScheme: "iso"` for a source that writes ISO weeks (Postgres IYYY-IW).
 */

export type Grain = "day" | "week" | "month" | "quarter" | "year";
export type WeekScheme = "strftime" | "iso";
/** [start, end) as UTC midnights. */
export type Bucket = { grain: Grain; start: Date; end: Date };

const DAY_MS = 86_400_000;
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);

const RE_WEEK = /^(\d{4})-?W(\d{1,2})$/i;
const RE_QUARTER = /^(\d{4})-?Q([1-4])$/i;
const RE_MONTH = /^(\d{4})-(\d{2})$/;
const RE_DAY = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const RE_YEAR = /^\d{4}$/;

/** Monday that starts week `w` of `year`, and the day after its last day. */
export function weekRange(year: number, w: number, scheme: WeekScheme = "strftime"): { start: Date; end: Date } | null {
  if (scheme === "iso") {
    if (w < 1 || w > 53) return null;
    const jan4 = utc(year, 0, 4);
    const monday1 = addDays(jan4, -((jan4.getUTCDay() + 6) % 7));
    const start = addDays(monday1, (w - 1) * 7);
    return { start, end: addDays(start, 7) };
  }
  if (w < 0 || w > 53) return null;
  const jan1 = utc(year, 0, 1);
  const nextJan1 = utc(year + 1, 0, 1);
  // %W: week 01 begins on the first Monday; the days before it are week 00.
  const firstMonday = addDays(jan1, (8 - jan1.getUTCDay()) % 7);
  const start = w === 0 ? jan1 : addDays(firstMonday, (w - 1) * 7);
  if (start >= nextJan1) return null;
  const end = w === 0 ? firstMonday : addDays(start, 7);
  // The year's last week stops at 31 December — the next year restarts at 00.
  return { start, end: end > nextJan1 ? nextJan1 : end };
}

function isoDay(value: string): Date | null {
  const m = value.match(RE_DAY);
  if (!m) return null;
  const d = utc(+m[1]!, +m[2]! - 1, +m[3]!);
  return d.getUTCMonth() === +m[2]! - 1 ? d : null;
}

/**
 * A single x value as a calendar bucket. Self-describing formats (week,
 * quarter, month, year) carry their own grain; an ISO date needs `grain` to
 * say how long its bucket is (see inferGrain) and starts on that date.
 */
export function parseBucket(value: unknown, grain?: Grain, weekScheme: WeekScheme = "strftime"): Bucket | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1900 && value <= 2200) value = String(value);
  if (typeof value !== "string") return null;
  const v = value.trim();
  let m: RegExpMatchArray | null;
  if ((m = v.match(RE_WEEK))) {
    const r = weekRange(+m[1]!, +m[2]!, weekScheme);
    return r ? { grain: "week", ...r } : null;
  }
  if ((m = v.match(RE_QUARTER))) {
    const y = +m[1]!, q = +m[2]!;
    return { grain: "quarter", start: utc(y, (q - 1) * 3, 1), end: utc(y, q * 3, 1) };
  }
  if ((m = v.match(RE_MONTH))) {
    const y = +m[1]!, mo = +m[2]!;
    if (mo < 1 || mo > 12) return null;
    return { grain: "month", start: utc(y, mo - 1, 1), end: utc(y, mo, 1) };
  }
  if (RE_YEAR.test(v)) {
    const y = +v;
    if (y < 1900 || y > 2200) return null;
    return { grain: "year", start: utc(y, 0, 1), end: utc(y + 1, 0, 1) };
  }
  const d = isoDay(v);
  if (!d || !grain) return null;
  const start = d;
  const end = grain === "day" ? addDays(d, 1)
    : grain === "week" ? addDays(d, 7)
    : grain === "month" ? utc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
    : grain === "quarter" ? utc(d.getUTCFullYear(), d.getUTCMonth() + 3, d.getUTCDate())
    : utc(d.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate());
  return { grain, start, end };
}

/**
 * The grain of a whole x axis: the shared grain of self-describing values,
 * or — for ISO dates — the typical gap between consecutive dates (1 day,
 * 7, ~30, ~91, ~365). Null when the values aren't one kind of time bucket.
 */
export function inferGrain(values: unknown[]): Grain | null {
  const vals = values.filter((v) => v != null && v !== "");
  if (vals.length === 0) return null;
  const selfGrains = vals.map((v) => parseBucket(v)?.grain ?? null);
  if (selfGrains.every((g) => g != null)) {
    const g = selfGrains[0]!;
    return selfGrains.every((x) => x === g) ? g : null;
  }
  const days = vals.map((v) => (typeof v === "string" ? isoDay(v.trim()) : null));
  if (days.some((d) => d == null) || days.length < 2) return null;
  const sorted = (days as Date[]).map((d) => d.getTime()).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const g = Math.round((sorted[i]! - sorted[i - 1]!) / DAY_MS);
    if (g > 0) gaps.push(g);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const gap = gaps[Math.floor(gaps.length / 2)]!;
  if (gap === 1) return "day";
  if (gap === 7) return "week";
  if (gap >= 28 && gap <= 31) return "month";
  if (gap >= 89 && gap <= 92) return "quarter";
  if (gap >= 365 && gap <= 366) return "year";
  return null;
}

/** Midnight UTC of the reader's local calendar day, so "today" is the date on their wall. */
function localToday(now: Date): Date {
  return utc(now.getFullYear(), now.getMonth(), now.getDate());
}

export type PartialPeriod = { index: number; grain: Grain; bucket: Bucket };

/**
 * The last x bucket when it hasn't finished yet: today falls inside it, or
 * the data itself only runs to `asOf`, a day before the bucket's last one.
 * Only for an axis in ascending time order — a chart sorted by value has no
 * "last period" — and only the final bucket is ever marked.
 */
export function partialLastPeriod(
  values: unknown[],
  opts: { now?: Date; asOf?: Date | null; grain?: Grain; weekScheme?: WeekScheme } = {},
): PartialPeriod | null {
  if (values.length === 0) return null;
  const grain = opts.grain ?? inferGrain(values);
  if (!grain) return null;
  const buckets = values.map((v) => parseBucket(v, grain, opts.weekScheme));
  if (buckets.some((b) => b == null)) return null;
  for (let i = 1; i < buckets.length; i++) {
    if (buckets[i]!.start <= buckets[i - 1]!.start) return null;
  }
  const index = buckets.length - 1;
  const bucket = buckets[index]!;
  const today = localToday(opts.now ?? new Date());
  const byToday = bucket.start <= today && today < bucket.end;
  const asOf = opts.asOf ? utc(opts.asOf.getUTCFullYear(), opts.asOf.getUTCMonth(), opts.asOf.getUTCDate()) : null;
  const byData = !!asOf && bucket.start <= asOf && asOf < addDays(bucket.end, -1);
  return byToday || byData ? { index, grain, bucket } : null;
}

/** Column names that say how far a row's data runs ("as_of", "last_day", "data_through"). */
const AS_OF_COLUMN = /(^|_)(as_?of|through|thru|until|latest|last_?(day|date|seen|updated)|max_?(day|date)|updated_?at)($|_)/i;

/**
 * How far the data in the last bucket runs, when a row says so in a column
 * named for it (see AS_OF_COLUMN) — never a bucket-start column like
 * "week_start", which would mark every bucket partial. Null when none.
 */
export function dataAsOf(rows: Array<Record<string, unknown>>, xField: string): Date | null {
  const last = rows[rows.length - 1];
  if (!last) return null;
  let best: Date | null = null;
  for (const [k, v] of Object.entries(last)) {
    if (k === xField || !AS_OF_COLUMN.test(k) || typeof v !== "string") continue;
    const d = isoDay(v.trim());
    if (d && (!best || d > best)) best = d;
  }
  return best;
}
