/**
 * Which way a bar chart's bars run when the author didn't say.
 *
 * Past ~8 named categories, upright bars meant slanted, clipped labels
 * ("Northeast Regi…" at 35 degrees) — a ranking nobody could read. Lying the
 * bars down gives every name a full line. An axis that is a sequence (dates,
 * weeks, months, years, numbers, month names) stays upright: time reads left
 * to right. The rows keep the order they came in.
 */
import { inferGrain } from "@/lib/reporting/partialPeriod";
import { THAI_MONTHS_ABBR } from "@/lib/reporting/forecast";

/** More named categories than this lie down. */
export const MAX_UPRIGHT_CATEGORIES = 8;

const MONTH_NAME = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(\s+'?\d{2,4})?$/i;
const THAI_MONTH = new RegExp(`^(${THAI_MONTHS_ABBR.map((m) => m.replace(/\./g, "\\.")).join("|")})(\\s*\\d{2,4})?$`);

/** True when the x values are an ordered sequence rather than named things. */
export function isSequenceAxis(values: unknown[]): boolean {
  const vals = values.filter((v) => v != null && v !== "");
  if (vals.length === 0) return false;
  if (vals.every((v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))))) return true;
  if (inferGrain(vals) != null) return true;
  // A date-like axis whose gaps are uneven still reads as time.
  if (vals.every((v) => typeof v === "string" && /^\d{4}-\d{2}(-\d{2})?([T ].*)?$|^\d{4}-?[WQ]\d{1,2}$/i.test(v.trim()))) return true;
  return vals.every((v) => typeof v === "string" && (MONTH_NAME.test(v.trim()) || THAI_MONTH.test(v.trim())));
}

/**
 * Horizontal when the author chose it; otherwise only for an unset
 * orientation over more than MAX_UPRIGHT_CATEGORIES named categories.
 */
export function barsHorizontal(orientation: unknown, xValues: unknown[]): boolean {
  if (orientation === "horizontal") return true;
  if (orientation === "vertical") return false;
  return xValues.length > MAX_UPRIGHT_CATEGORIES && !isSequenceAxis(xValues);
}
