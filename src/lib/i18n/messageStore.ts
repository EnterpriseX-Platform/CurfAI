/**
 * Where useT() finds the words for a language: the same place in the browser
 * and on the server, so a page renders the same text in both.
 *
 * In the browser, a script puts one language's words here: the file the
 * build writes to public/_i18n/, or the /i18n/<locale> route that builds the
 * same script on request (messageFiles.ts picks which). The root layout loads the
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

/** The built file's name under public/_i18n/. `version` changes with the words, so the browser can keep the file. */
export function messagesStaticName(locale: Locale, version: string): string {
  return `${locale}.${version}.js`;
}

/** The built file's address (compressed by Next). */
export function messagesStaticSrc(locale: Locale, version: string): string {
  return `/_i18n/${messagesStaticName(locale, version)}`;
}

/** The route's address: the same script, built on request (dev, or a page opened before a deploy). */
export function messagesRouteSrc(locale: Locale, version: string): string {
  return `/i18n/${locale}?v=${encodeURIComponent(version)}`;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { script.remove(); reject(new Error(`couldn't load ${src}`)); };
    document.head.appendChild(script);
  });
}

/**
 * A language's words in the browser, loading its script if this page doesn't
 * have it yet: the built file first, the route when that file isn't there
 * (`next dev`, or a page opened before a deploy that replaced the files).
 */
export async function loadMessages(locale: Locale, version: string): Promise<Dictionary> {
  const have = loadedMessages(locale);
  if (have) return have;
  await loadScript(messagesStaticSrc(locale, version)).catch(() => loadScript(messagesRouteSrc(locale, version)));
  const loaded = loadedMessages(locale);
  if (!loaded) throw new Error(`the ${locale} script held no words`);
  return loaded;
}
