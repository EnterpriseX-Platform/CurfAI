/**
 * A week bucket ("2026-W29") read as the date its week starts, in the
 * reader's language: "20 Jul" / "20 ก.ค." / "7月20日" on an axis, with the
 * year in a tooltip header ("20 Jul 2026" / "20 ก.ค. 2569" / "2026年7月20日").
 * A reader can't count weeks from January; they can read a date.
 *
 * Thai years follow the reader's era (Buddhist unless they or the report
 * chose Gregorian), the same DateStyle every other date in a report uses
 * (lib/reporting/format.ts). Pure — no React, safe in the PDF capture too.
 */
import { format as formatDate } from "date-fns";
import { intlLocale } from "@/lib/i18n/formatDate";
import type { DateStyle } from "@/lib/reporting/format";
import { parseBucket, type WeekScheme } from "@/lib/reporting/partialPeriod";

/** The week's first day in the reader's words; null for anything that isn't a "YYYY-Www" value. */
export function weekStartLabel(
  value: unknown,
  style: DateStyle | undefined,
  form: "axis" | "full" = "axis",
  weekScheme: WeekScheme = "strftime",
): string | null {
  if (typeof value !== "string" || !/^\d{4}-?W\d{1,2}$/i.test(value.trim())) return null;
  const b = parseBucket(value, undefined, weekScheme);
  if (!b || b.grain !== "week") return null;
  const s = b.start;
  const withYear = form === "full";
  const locale = style?.locale;
  if (locale === "th" || locale === "zh") {
    return new Intl.DateTimeFormat(intlLocale(locale, style?.era), {
      day: "numeric", month: "short", ...(withYear ? { year: "numeric" as const } : {}), timeZone: "UTC",
    }).format(s);
  }
  // date-fns, not Intl, for English: en-GB's short month is "Sept" on some
  // runtimes and "Sep" on others (same reason as dateValueLabel). date-fns
  // reads local time, so rebuild the UTC calendar day as a local one.
  const local = new Date(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
  return formatDate(local, withYear ? "d MMM yyyy" : "d MMM");
}
