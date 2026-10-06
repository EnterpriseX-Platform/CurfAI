"use client";
import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import { ToastHost } from "@/lib/toast";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";
import type { Locale } from "@/lib/i18n/locales";
import type { Era } from "@/lib/i18n/formatDate";

export function Providers({
  children,
  initialLocale,
  messageVersions,
  seedLocaleCookie,
  initialEra,
  seedEraCookie,
  session,
}: {
  children: React.ReactNode;
  initialLocale?: Locale;
  /** Each language's current /i18n version (app/layout.tsx), for switching language. */
  messageVersions?: Partial<Record<Locale, string>>;
  /** initialLocale came from the user's saved preference, not the cookie — write it to the cookie. */
  seedLocaleCookie?: boolean;
  /** Buddhist-era or Gregorian years for Thai dates (rd_era cookie / saved preference). */
  initialEra?: Era;
  /** initialEra came from the saved preference, not the cookie — write it to the cookie. */
  seedEraCookie?: boolean;
  // Server-fetched in app/layout.tsx (RootLayout) and passed straight
  // through as SessionProvider's `session` prop. Given an initial session,
  // next-auth seeds useSession() with it synchronously on both the server
  // render and the first client render — status is "authenticated" (or
  // "unauthenticated" for a null session) immediately instead of "loading"
  // until its own client-side fetch resolves. That's what fixes the sidebar
  // rendering the viewer-level nav for ~1-3s before popping to the real one
  // on every cold load — see lib/useResilientSession.ts.
  session?: Session | null;
}) {
  return (
    <LocaleProvider initialLocale={initialLocale} versions={messageVersions} seedCookie={seedLocaleCookie} initialEra={initialEra} seedEraCookie={seedEraCookie}>
      <SessionProvider session={session}>
        <ToastHost>{children}</ToastHost>
      </SessionProvider>
    </LocaleProvider>
  );
}
