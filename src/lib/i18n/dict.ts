/**
 * The app's words in every language, for the server: server components and
 * route handlers translate with t(locale, key). The words are in
 * messages/<locale>.ts, each key in all three (dict.test.ts).
 *
 * The browser never loads this file (dict.clientBundle.test.ts keeps it out
 * of client modules). A page gets its reader's language from /i18n/<locale>,
 * and useT() reads it from messageStore.ts, where this file also puts every
 * language for the server render of client components.
 */
import { en } from "./messages/en";
import { th } from "./messages/th";
import { zh } from "./messages/zh";
import type { Dictionary, Locale } from "./locales";
import { provideMessages } from "./messageStore";

export * from "./locales";

export const DICT: Record<Locale, Dictionary> = { en, th, zh };
provideMessages(DICT);

export function t(locale: Locale, key: string): string {
  return DICT[locale]?.[key] ?? DICT.en[key] ?? key;
}

const versions = new Map<Locale, string>();

/** Changes whenever a language's words do: the cache key in the /i18n/<locale> script's address. */
export function messagesVersion(locale: Locale): string {
  let v = versions.get(locale);
  if (!v) {
    const words = JSON.stringify(DICT[locale]);
    v = `${fnv1a(words)}${words.length.toString(36)}`;
    versions.set(locale, v);
  }
  return v;
}

/** 32-bit FNV-1a in base 36: a cache key, not a secret. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
