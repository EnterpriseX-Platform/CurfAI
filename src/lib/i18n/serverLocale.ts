import { cookies } from "next/headers";
import { LOCALES, type Locale } from "./dict";

/**
 * The viewer's content locale, read from the `rd_locale` cookie in a Server
 * Component.
 *
 * This is the CONTENT-locale axis — which language a report's own nameI18n
 * and per-block i18n render in — as opposed to the chrome locale that
 * LocaleContext gives client components. Server-rendered pages that call
 * ReportDocument directly have no ambient context to read, so they need
 * this.
 *
 * Unknown or missing values resolve to "en", matching what every field
 * falls back to when a locale has no override.
 *
 * There are ~58 hand-rolled copies of this three-line function across the
 * app today (grep `function readLocale`). New callers should use this one;
 * the sweep to collapse the rest is deliberately not bundled here.
 */
export function serverLocale(): Locale {
  const v = cookies().get("rd_locale")?.value;
  return v && (LOCALES as readonly string[]).includes(v) ? (v as Locale) : "en";
}
