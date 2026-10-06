/**
 * The app's languages, for client and server alike. The words themselves are
 * in messages/<locale>.ts, which only the server loads (dict.ts); a page gets
 * its reader's language from /i18n/<locale> (messageStore.ts).
 */

export const LOCALES = ["en", "th", "zh"] as const;
export type Locale = typeof LOCALES[number];

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  th: "ไทย",
  zh: "中文",
};

/** Short codes for the compact language switcher. Not flags: a language isn't a
 *  country, and Windows draws flag emoji as bare letters anyway. */
export const LOCALE_CODES: Record<Locale, string> = {
  en: "EN",
  th: "TH",
  zh: "ZH",
};

export type Dictionary = Record<string, string>;
