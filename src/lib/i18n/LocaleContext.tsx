"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { DICT, LOCALES, type Locale } from "./dict";

type Ctx = { locale: Locale; setLocale: (l: Locale) => void; t: (key: string) => string };
const LocaleCtx = React.createContext<Ctx | null>(null);
const COOKIE = "rd_locale";

function readCookie(): Locale {
  if (typeof document === "undefined") return "en";
  const m = document.cookie.match(/(?:^|; )rd_locale=([^;]+)/);
  const v = m ? decodeURIComponent(m[1]) : "en";
  return (LOCALES as readonly string[]).includes(v) ? (v as Locale) : "en";
}

export function LocaleProvider({
  children,
  initialLocale,
}: {
  children: React.ReactNode;
  initialLocale?: Locale;
}) {
  // initialLocale comes from the server (read from the rd_locale cookie in
  // RootLayout via next/headers). Without it we'd fall back to "en" on the
  // server and read the cookie on the client, which produced a hydration
  // mismatch on any user with a non-en locale cookie. Threading the locale
  // through the server render keeps the first paint deterministic.
  const [locale, setLocaleState] = React.useState<Locale>(initialLocale ?? "en");
  const router = useRouter();
  // Belt-and-suspenders: if the server didn't pass a locale (older callers)
  // we still resync from the cookie after mount.
  React.useEffect(() => {
    if (initialLocale === undefined) setLocaleState(readCookie());
  }, [initialLocale]);

  const setLocale = React.useCallback((l: Locale) => {
    setLocaleState(l);
    document.cookie = `${COOKIE}=${l}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    // Client components (useT()) re-render instantly from the state change
    // above, but every page's SERVER components (page.tsx calling
    // t(locale, key) from the rd_locale cookie) only re-render on
    // navigation — router.refresh() re-runs the current route's server
    // render with the new cookie value without losing client state or
    // scroll position. Without this, switching locale looked like most
    // page titles/breadcrumbs/subtitles were "still untranslated" when
    // they were actually just frozen at the previous locale's render.
    router.refresh();
  }, [router]);

  const t = React.useCallback((key: string) => DICT[locale]?.[key] ?? DICT.en[key] ?? key, [locale]);

  return <LocaleCtx.Provider value={{ locale, setLocale, t }}>{children}</LocaleCtx.Provider>;
}

export function useT() {
  const ctx = React.useContext(LocaleCtx);
  if (!ctx) throw new Error("useT must be used inside <LocaleProvider>");
  return ctx;
}
