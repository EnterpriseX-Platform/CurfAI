/**
 * Locale-aware date helpers for the chrome (greeting lines, "run at", "viewed
 * 2 hours ago"). Pure — safe in server and client components.
 *
 * Thai dates use the Buddhist-era year by default (th-TH's own calendar:
 * 24 กันยายน 2569); `era: "ce"` switches a Thai reader to the Gregorian year
 * (User.preferencesJson.era). Other locales ignore `era`.
 *
 * Moved here from private copies in the viewer portal so the member Home
 * and the portal format dates the same way.
 */
export type Era = "be" | "ce";

export function intlLocale(locale: string, era?: Era): string {
  if (locale === "th") return era === "ce" ? "th-TH-u-ca-gregory" : "th-TH-u-ca-buddhist";
  return locale === "zh" ? "zh-CN" : "en-GB";
}

/** "Thursday 24 September" · "วันพฤหัสบดีที่ 24 กันยายน 2569" (Thai shows the year: it's how the era is visible). */
export function longDate(d: Date, locale: string, era?: Era): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: "long", day: "numeric", month: "long" };
  if (locale === "th") opts.year = "numeric";
  return new Intl.DateTimeFormat(intlLocale(locale, era), opts).format(d);
}

/** "08:44" in the reader's locale, 24-hour. */
export function clock(iso: string | Date, locale: string): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

/** "3 hours ago" / "3 ชั่วโมงที่ผ่านมา" — minutes under an hour, hours under a day, then days. */
export function relative(d: Date | string, locale: string): string {
  const diff = Date.now() - new Date(d).getTime();
  const rtf = new Intl.RelativeTimeFormat(locale === "th" ? "th" : locale === "zh" ? "zh" : "en", { numeric: "auto" });
  const min = Math.round(diff / 60_000);
  if (min < 60) return rtf.format(-Math.max(min, 0), "minute");
  const hr = Math.round(min / 60);
  if (hr < 24) return rtf.format(-hr, "hour");
  return rtf.format(-Math.round(hr / 24), "day");
}

/** Morning / afternoon / evening key suffix for a greeting. */
export function dayPart(now = new Date()): "morning" | "afternoon" | "evening" {
  const h = now.getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}
