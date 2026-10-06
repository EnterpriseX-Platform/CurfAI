/**
 * Where useT() finds the words for a language: the same place in the browser
 * and on the server, so a page renders the same text in both.
 *
 * In the browser, /i18n/<locale> (src/app/i18n/[locale]/route.ts) is a
 * script that puts one language's words here. The root layout loads the
 * reader's language before the page hydrates (next/script beforeInteractive);
 * a language switch loads the next one with loadMessages(). A page gets one
 * language, in a file the browser keeps until the words change. It used to
 * get all three inside every page's JavaScript, when LocaleContext imported
 * dict.ts: 1.6 MB, fetched again after every deploy.
 *
 * On the server, dict.ts puts every language here when it loads (the root
 * layout imports it), for the server render of client components.
 */
import type { Dictionary, Locale } from "./locales";

/** The global the /i18n script writes to. */
export const MESSAGES_GLOBAL = "__CURF_I18N__";

type Store = Partial<Record<Locale, Dictionary>>;

function store(): Store {
  const g = globalThis as unknown as Record<string, Store | undefined>;
  return (g[MESSAGES_GLOBAL] ??= {});
}

/** The server's languages (dict.ts). */
export function provideMessages(all: Store): void {
  Object.assign(store(), all);
}

export function loadedMessages(locale: Locale): Dictionary | undefined {
  return store()[locale];
}

/** The /i18n script's address. `version` changes with the words, so the browser can keep the file. */
export function messagesSrc(locale: Locale, version: string): string {
  return `/i18n/${locale}?v=${encodeURIComponent(version)}`;
}

/** A language's words in the browser, loading its script if this page doesn't have it yet. */
export function loadMessages(locale: Locale, version: string): Promise<Dictionary> {
  const have = loadedMessages(locale);
  if (have) return Promise.resolve(have);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = messagesSrc(locale, version);
    script.async = true;
    script.onload = () => {
      const loaded = loadedMessages(locale);
      if (loaded) resolve(loaded);
      else reject(new Error(`/i18n/${locale} held no words`));
    };
    script.onerror = () => reject(new Error(`couldn't load /i18n/${locale}`));
    document.head.appendChild(script);
  });
}
