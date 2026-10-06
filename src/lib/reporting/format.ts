/**
 * Shared formatting helpers. Used by HTML viewer, PDF (inherits HTML),
 * XLSX, and DOCX so numbers/dates look consistent across outputs.
 */
import { format as formatDate, parseISO } from "date-fns";
import { th as thLocale } from "date-fns/locale/th";
import { currencyDisplay, currencySymbol, DEFAULT_CURRENCY } from "@/lib/reporting/currency";
import { intlLocale, type Era } from "@/lib/i18n/formatDate";

/**
 * True when a KPI/value label reads as a year, code, or id rather than a
 * magnitude — e.g. "Latest Fiscal Year", "ปีการศึกษาล่าสุด". Callers that
 * compact large numbers for a headline display (2,568 -> "2.6K") should
 * skip that for these: a year isn't a count that benefits from K/M/B
 * abbreviation, and there's no way to tell "count" from "identifier" from
 * the number alone (2568 is a completely ordinary count too, e.g. of
 * students) — only the label distinguishes them.
 */
export function isIdentifierLabel(label: string): boolean {
  return /\b(year|code|id)\b|ปี|รหัส|เลขที่/i.test(label);
}

export function formatNumber(value: unknown, decimals = 0): string {
  if (value == null || value === "") return ""; // absent is not zero (see formatDecimal)
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Number formatting that keeps whatever precision the value actually has.
 *
 * Integers print clean (3500 -> "3,500"); fractions survive (0.06 -> "0.06").
 * Use this wherever the column's decimal count isn't known up front —
 * formatNumber's `decimals = 0` default silently rounded every rate, ratio
 * and cents value to a whole number, on screen and in exports alike.
 */
export function formatDecimal(value: unknown, maxDecimals = 4): string {
  // Number(null) and Number("") are both 0, so a missing measure would
  // otherwise print as a confident "0". Absent is not zero.
  if (value == null || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-US", { maximumFractionDigits: maxDecimals });
}

export function formatCurrency(value: unknown, currency = DEFAULT_CURRENCY): string {
  if (value == null || value === "") return ""; // absent is not zero (see formatDecimal)
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency,
    currencyDisplay: currencyDisplay(currency),
    minimumFractionDigits: 2,
  });
}

export function formatPercent(value: unknown, decimals = 1): string {
  if (value == null || value === "") return ""; // absent is not zero (see formatDecimal)
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return `${(n * 100).toFixed(decimals)}%`;
}

/**
 * Who a date is shown to. A Thai reader gets Thai month names and, unless
 * they (or the report, Report.dateEra) chose Gregorian, Buddhist-era years
 * (พ.ศ. = year + 543). Every other locale — and a caller that passes no
 * style — gets exactly the pattern's output, as before.
 */
export type DateStyle = { locale?: string; era?: Era };

const isThai = (style?: DateStyle) => style?.locale === "th";

/** The report's locked era (Report.dateEra) wins over the reader's own. */
export function resolveDateStyle(locale: string | undefined, readerEra: Era | undefined, reportEra?: Era | null): DateStyle {
  return { locale, era: reportEra ?? readerEra ?? "be" };
}

/**
 * A date-fns pattern with its year tokens (y, yy, yyyy — outside quoted
 * literals) replaced by the Buddhist-era year as a literal. date-fns has
 * no Buddhist calendar; its Thai locale only translates the month names.
 */
export function buddhistYearPattern(pattern: string, gregorianYear: number): string {
  const be = String(gregorianYear + 543);
  let out = "";
  let quoted = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "'") { quoted = !quoted; out += ch; continue; }
    if (!quoted && ch === "y") {
      let n = 1;
      while (pattern[i + n] === "y") n++;
      out += `'${n === 2 ? be.slice(-2) : be}'`;
      i += n - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function toDate(value: unknown): Date | null {
  if (value == null || value === "") return null;
  const d = typeof value === "string" ? parseISO(value) : value instanceof Date ? value : new Date(value as any);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * A date or datetime cell. `pattern` is the author's date-fns pattern
 * (column.format); without one, Thai readers get "26 ก.ย. 2569" and
 * everyone else the ISO-style "2026-09-26".
 */
export function formatDateValue(value: unknown, pattern?: string, style?: DateStyle, withTime = false): string {
  if (!value) return "";
  const d = toDate(value);
  if (!d) return String(value);
  if (isThai(style)) {
    if (!pattern) {
      return new Intl.DateTimeFormat(intlLocale("th", style!.era), {
        day: "numeric", month: "short", year: "numeric",
        ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const } : {}),
      }).format(d);
    }
    const p = style!.era === "ce" ? pattern : buddhistYearPattern(pattern, d.getFullYear());
    return formatDate(d, p, { locale: thLocale });
  }
  return formatDate(d, pattern ?? (withTime ? "yyyy-MM-dd HH:mm" : "yyyy-MM-dd"));
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/**
 * A date that arrives as a raw ISO string where no column type says it's a
 * date — a chart's x value, a parameter dropped into text, a heatmap day —
 * shown for a Thai reader ("26 ก.ย. 2569", or "1 ก.ย. 69" on an axis;
 * "2026-09" → "ก.ย. 2569"). Returns null when the value isn't an ISO date
 * or the reader isn't Thai, so callers keep showing it as they always have.
 */
/**
 * True when a run of values is months kept as dates: every one "2025-09" or
 * the first of a month ("2025-09-01"). A lone "-01" date could be any day,
 * so a single one only counts in the "YYYY-MM" form.
 */
export function isMonthStartSeries(values: unknown[]): boolean {
  const s = values.filter((v) => v != null && v !== "");
  return s.length > 0 && s.every((v) => typeof v === "string" && /^\d{4}-\d{2}(-01)?$/.test(v))
    && (s.length >= 2 || ISO_MONTH.test(s[0] as string));
}

/**
 * An ISO date, or a month, shown to any reader — Thai via thaiDateLabel,
 * everyone else in their own language: "1 Sep 25" on an axis, "1 Sep 2025"
 * in full, and a month as "Sep 25" / "Sep 2025" ("25年9月" in Chinese).
 * `monthly` reads a first-of-month date as its month (see
 * isMonthStartSeries). Null when the value isn't an ISO date; a date with a
 * time is labelled for Thai readers only, as before.
 */
export function dateValueLabel(value: unknown, style: DateStyle | undefined, form: "full" | "axis" = "full", monthly = false): string | null {
  if (typeof value !== "string") return null;
  const asMonth = ISO_MONTH.test(value) || (monthly && ISO_DAY.test(value));
  if (isThai(style)) return thaiDateLabel(asMonth ? value.slice(0, 7) : value, style, form);
  if (!asMonth && !ISO_DAY.test(value)) return null;
  const d = parseISO(asMonth ? value.slice(0, 7) : value);
  if (isNaN(d.getTime())) return null;
  if (style?.locale === "zh") {
    return new Intl.DateTimeFormat("zh-CN", {
      ...(asMonth ? {} : { day: "numeric" as const }), month: "short", year: form === "axis" ? "2-digit" : "numeric",
    }).format(d);
  }
  // date-fns, not Intl: en-GB's short month is "Sept" on some runtimes and "Sep" on others.
  return formatDate(d, `${asMonth ? "" : "d "}MMM ${form === "axis" ? "yy" : "yyyy"}`);
}

export function thaiDateLabel(value: unknown, style: DateStyle | undefined, form: "full" | "axis" = "full"): string | null {
  if (!isThai(style) || typeof value !== "string") return null;
  const month = ISO_MONTH.test(value);
  const withTime = !month && !ISO_DAY.test(value) && ISO_DATETIME.test(value);
  if (!month && !withTime && !ISO_DAY.test(value)) return null;
  const d = parseISO(value);
  if (isNaN(d.getTime())) return null;
  const year = form === "axis" ? "2-digit" : "numeric";
  return new Intl.DateTimeFormat(intlLocale("th", style!.era), {
    ...(month ? {} : { day: "numeric" as const }), month: "short", year,
    ...(withTime && form === "full" ? { hour: "2-digit" as const, minute: "2-digit" as const, hourCycle: "h23" as const } : {}),
  }).format(d);
}

export function formatCell(value: unknown, type: string, override?: string, currency?: string, dateStyle?: DateStyle): string {
  switch (type) {
    case "currency":
      return formatCurrency(value, currency);
    case "percent":
      return formatPercent(value);
    case "number":
      // An explicit digit count on the column wins ("2" -> always 2 dp);
      // otherwise keep the value's own precision rather than rounding to 0.
      return /^\d+$/.test(override ?? "")
        ? formatNumber(value, Number(override))
        : formatDecimal(value);
    case "date":
      return formatDateValue(value, override, dateStyle);
    case "datetime":
      return formatDateValue(value, override, dateStyle, true);
    default:
      return value == null ? "—" : String(value);
  }
}

/**
 * Reconcile a capped table heading with an export that lifted the cap.
 *
 * The generator titles a truncated detail table "Rows · first 500 of 722".
 * Exports now carry every row, so that heading would contradict the file it
 * sits on. Only our own generated phrasing is rewritten — any other title is
 * the author's words and is returned untouched.
 */
export function uncappedTableTitle(title: string | undefined, rowCount: number): string | undefined {
  if (!title || !/^Rows · first [\d,]+ of [\d,]+$/.test(title)) return title;
  return `Rows · all ${rowCount.toLocaleString()}`;
}

export function aggregate(rows: Array<Record<string, unknown>>, key: string, op: string): number | null {
  // A blank cell is absent, not 0 — or a column with no values at all would total "0".
  const values = rows.map((r) => r[key]).filter((v) => v != null && v !== "").map(Number).filter((n) => Number.isFinite(n));
  if (values.length === 0) return null;
  switch (op) {
    case "sum":   return values.reduce((a, b) => a + b, 0);
    case "avg":   return values.reduce((a, b) => a + b, 0) / values.length;
    case "count": return rows.length;
    case "min":   return Math.min(...values);
    case "max":   return Math.max(...values);
    default:      return null;
  }
}

/** Baht for a Thai reader reads in Thai units, the way a Thai budget document does. */
export function readsThaiMoney(currency: string | undefined, locale: string | undefined): boolean {
  return locale === "th" && (currency ?? DEFAULT_CURRENCY) === "THB";
}

/**
 * Baht in Thai units — what the prototype and a Thai budget document read
 * in, not "฿20.4B". Long form for a number standing on its own (a KPI, a
 * tooltip): "20.35 พันล้านบาท", "368.2 ล้านบาท", "5,400 บาท". Short form for an
 * axis tick or a label beside a bar: "20.4 พันล.", "368 ล.", "5.4 พัน" —
 * number and unit joined by a no-break space, or a waterfall label wraps
 * "−2.5" and "พันล." onto two lines.
 */
export function thaiMoney(n: number, short: boolean): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  const num = (v: number, digits: number) => v.toLocaleString("en-US", { maximumFractionDigits: digits });
  if (abs >= 1e9) return sign + (short ? `${num(abs / 1e9, 1)}\u00a0พันล.` : `${num(abs / 1e9, 2)} พันล้านบาท`);
  if (abs >= 1e6) return sign + (short ? `${num(abs / 1e6, abs >= 1e8 ? 0 : 1)}\u00a0ล.` : `${num(abs / 1e6, 1)} ล้านบาท`);
  if (short && abs >= 1e3) return sign + `${num(abs / 1e3, 1)}\u00a0พัน`;
  return sign + `${num(abs, 0)}${short ? "" : " บาท"}`;
}

/**
 * Compact metric formatter for narrative surfaces (Brief KPI cards, chart
 * captions) — "1.2M" beats "1,234,567" where space is tight. This was
 * hand-rolled in brief.ts and chartCaption.ts with subtly different currency
 * policies; one implementation means one policy.
 *
 * Sign leads the currency symbol - "$" + format(-4.6e6) rendered as
 * "$-4.6M", which reads as a typo on a metric card.
 */
export function formatMetricCompact(
  n: number | null | undefined,
  fmt?: "number" | "currency" | "percent" | "compact",
  currency: string = DEFAULT_CURRENCY,
  /** The reader's language: baht read in Thai units for a Thai reader (thaiMoney). */
  locale?: string,
): string {
  if (n == null || !Number.isFinite(n)) return "-";
  if (fmt === "currency" && readsThaiMoney(currency, locale)) return thaiMoney(n, true);
  if (fmt === "currency") {
    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    return sign + currencySymbol(currency) + (abs >= 1000
      ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(abs)
      : abs.toFixed(0));
  }
  if (fmt === "percent") return (n * 100).toFixed(1) + "%";
  return Math.abs(n) >= 1000
    ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n)
    : String(Math.round(n));
}

/**
 * Render an arbitrary unknown value for human display (Slack notifications,
 * "why" explanations). Numbers get thousands separators, booleans read as
 * yes/no, objects are truncated JSON. Previously duplicated in
 * operate/slack-notify.ts and operate/why.ts.
 */
export function formatUnknown(v: unknown, opts?: { maxLen?: number }): string {
  if (typeof v === "number") return Number.isFinite(v) && Math.abs(v) >= 1000 ? v.toLocaleString() : String(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (v && typeof v === "object") return JSON.stringify(v).slice(0, 80);
  const s = String(v);
  const max = opts?.maxLen ?? 0;
  return max > 0 && s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Which way a fractional change moved, for arrows and colour. Anything
 * within ±0.1% reads as flat, so a rounding wobble never shows as "▲ 0.0%"
 * or gets coloured as good or bad news.
 */
export function deltaDir(deltaPct: number | null | undefined): "up" | "down" | "flat" {
  return deltaPct == null ? "flat" : deltaPct > 0.001 ? "up" : deltaPct < -0.001 ? "down" : "flat";
}

/**
 * A KPI's change the way a reader should see it. A rate (format "percent")
 * moves in points — 1.0% → 1.8% is "0.8 pts", where a relative change would
 * say "80%", and 1.786% → 1.8% would say "▲ 0.8%" about a rate that didn't
 * visibly move. Every other number moves relative to where it was. Flat
 * when the shown text would round to zero. `pts` is the unit word in the
 * reader's language. Null when there's nothing to compare with.
 */
export function kpiChange(
  k: { format?: string | null; currentValue?: number | null; previousValue?: number | null; deltaPct?: number | null },
  pts = "pts",
): { dir: "up" | "down" | "flat"; text: string } | null {
  if (k.format === "percent" && k.currentValue != null && k.previousValue != null) {
    const d = (k.currentValue - k.previousValue) * 100;
    const dir = d >= 0.05 ? "up" : d <= -0.05 ? "down" : "flat";
    return { dir, text: `${Math.abs(d).toFixed(1)} ${pts}` };
  }
  if (k.deltaPct == null) return null;
  return { dir: deltaDir(k.deltaPct), text: `${Math.abs(k.deltaPct * 100).toFixed(1)}%` };
}

/**
 * A decision's predicted change, signed: "+$28K", or for a rate "−1.1 pts"
 * (the metric's format says which) — a rate predicted to fall from 4.1%
 * to 3.0% falls 1.1 points, not 1.1%.
 */
export function predictedChange(delta: number | null | undefined, formatted: string | null | undefined, format: string | null | undefined, pts = "pts"): string {
  if (format === "percent" && delta != null) {
    return `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${Math.abs(delta * 100).toFixed(1)} ${pts}`;
  }
  return signedChange(delta, formatted ?? "");
}

/** A formatted change with its sign, for a prediction: "+$28K", "-1.1%". */
export function signedChange(delta: number | null | undefined, text: string): string {
  return delta != null && delta > 0 && !/^[+-]/.test(text) ? `+${text}` : text;
}
