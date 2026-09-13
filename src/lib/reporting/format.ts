/**
 * Shared formatting helpers. Used by HTML viewer, PDF (inherits HTML),
 * XLSX, and DOCX so numbers/dates look consistent across outputs.
 */
import { format as formatDate, parseISO } from "date-fns";
import { currencySymbol } from "@/lib/reporting/currency";

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

export function formatCurrency(value: unknown, currency = "USD"): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  });
}

export function formatPercent(value: unknown, decimals = 1): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return `${(n * 100).toFixed(decimals)}%`;
}

export function formatDateValue(value: unknown, pattern = "yyyy-MM-dd"): string {
  if (!value) return "";
  const d = typeof value === "string" ? parseISO(value) : (value as Date);
  if (isNaN(d.getTime())) return String(value);
  return formatDate(d, pattern);
}

export function formatCell(value: unknown, type: string, override?: string, currency?: string): string {
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
      return formatDateValue(value, override ?? "yyyy-MM-dd");
    case "datetime":
      return formatDateValue(value, override ?? "yyyy-MM-dd HH:mm");
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
  const values = rows.map((r) => Number(r[key])).filter((n) => Number.isFinite(n));
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
  currency: string = "USD",
): string {
  if (n == null || !Number.isFinite(n)) return "-";
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
