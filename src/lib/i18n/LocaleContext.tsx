"use client";
/**
 * The reader's language in client components: useT().t(key).
 *
 * The words come from messageStore.ts: the root layout loads the reader's
 * language there before the page hydrates, and the server render finds every
 * language there. Never import dict.ts here; that would ship all three
 * languages to every page (dict.clientBundle.test.ts).
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import type { Dictionary, Locale } from "./locales";
import { loadMessages, loadedMessages } from "./messageStore";
import type { Era } from "./formatDate";

type Ctx = {
  locale: Locale;
  setLocale: (l: Locale) => void;
  /** Year style for Thai dates — pass to intlLocale()/DateStyle. Other locales ignore it. */
  era: Era;
  /** Update the cookie + state only; the caller saves the preference (AccountForm does). */
  setEra: (e: Era) => void;
  t: (key: string) => string;
};
const LocaleCtx = React.createContext<Ctx | null>(null);
const COOKIE = "rd_locale";

function writeCookie(l: Locale) {
  document.cookie = `${COOKIE}=${l}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

function writeEraCookie(e: Era) {
  document.cookie = `rd_era=${e}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

export function LocaleProvider({
  children,
  initialLocale,
  messages,
  versions,
  seedCookie,
  initialEra = "be",
  seedEraCookie,
}: {
  children: React.ReactNode;
  initialLocale?: Locale;
  /** The words, for a page that renders in its own language rather than the
   *  reader's (a board pack). Otherwise they're the ones the root layout loaded. */
  messages?: Dictionary;
  /** Each language's current /i18n version, for loading another on a switch (the root layout's). */
  versions?: Partial<Record<Locale, string>>;
  seedCookie?: boolean;
  initialEra?: Era;
  seedEraCookie?: boolean;
}) {
  // initialLocale comes from the server (read from the rd_locale cookie in
  // RootLayout via next/headers), so the server render and the first client
  // paint agree — no hydration mismatch for a reader with a non-en cookie.
  const [locale, setLocaleState] = React.useState<Locale>(initialLocale ?? "en");
  const [words, setWords] = React.useState<Dictionary>(() => messages ?? loadedMessages(initialLocale ?? "en") ?? {});
  const router = useRouter();
  React.useEffect(() => {
    if (seedCookie && initialLocale) writeCookie(initialLocale);
  }, [initialLocale, seedCookie]);
  // The script before hydration didn't load (offline, blocked): the page
  // showed keys, so fetch the words and show them once they're here.
  React.useEffect(() => {
    if (messages || Object.keys(words).length) return;
    const version = versions?.[locale];
    if (version) loadMessages(locale, version).then(setWords).catch(() => {});
  }, [messages, words, versions, locale]);

  const [era, setEraState] = React.useState<Era>(initialEra);
  React.useEffect(() => { if (seedEraCookie) writeEraCookie(initialEra); }, [initialEra, seedEraCookie]);
  const setEra = React.useCallback((e: Era) => {
    setEraState(e);
    writeEraCookie(e);
    router.refresh(); // server-rendered dates (serverEra()) re-render too
  }, [router]);

  const setLocale = React.useCallback((l: Locale) => {
    const version = versions?.[l];
    if (!version) return;
    // The new language's words first (a file the browser keeps, or one
    // request): switching without them would leave the page half in each.
    loadMessages(l, version).then((w) => {
      setWords(w);
      setLocaleState(l);
      writeCookie(l);
      // Remember it on the account too, so it follows the user to other
      // devices (app/layout.tsx seeds the cookie from it). Signed-out pages
      // get a 401 here, which is fine to ignore.
      void fetch("/api/user/preferences", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale: l }) }).catch(() => {});
      // Client components (useT()) switch with the state above, but every
      // page's SERVER components (page.tsx calling t(locale, key) from the
      // rd_locale cookie) only re-render on navigation — router.refresh()
      // re-runs the current route's server render with the new cookie
      // without losing client state or scroll position. Without it, page
      // titles, breadcrumbs and subtitles stayed in the old language.
      router.refresh();
    }).catch(() => { /* the words didn't load: stay in this language */ });
  }, [router, versions]);

  const t = React.useCallback((key: string) => words[key] ?? key, [words]);

  return <LocaleCtx.Provider value={{ locale, setLocale, era, setEra, t }}>{children}</LocaleCtx.Provider>;
}

export function useT() {
  const ctx = React.useContext(LocaleCtx);
  if (!ctx) throw new Error("useT must be used inside <LocaleProvider>");
  return ctx;
}
