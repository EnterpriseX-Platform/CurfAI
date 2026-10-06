import type { Metadata, Viewport } from "next";
import { Instrument_Sans, IBM_Plex_Mono, Prompt } from "next/font/google";
import { cookies } from "next/headers";
import Script from "next/script";
import "./globals.css";
import { Providers } from "./providers";
import { cn } from "@/lib/utils";
import { PwaShell } from "@/components/pwa/PwaShell";
import { LOCALES, messagesVersion, type Locale } from "@/lib/i18n/dict";
import { messagesSrc } from "@/lib/i18n/messageStore";
import { readSession } from "@/lib/auth";
import { savedDatePrefs } from "@/lib/i18n/userLocale";
import type { Era } from "@/lib/i18n/formatDate";

// All three families are self-hosted by next/font at build time — the CSP
// is `font-src 'self'`, so nothing here may reach a font CDN at runtime.

// Instrument Sans is a variable font (wght 400–700); no `weight` key on
// purpose — passing a weight array would fetch static instances instead.
// It carries both UI and display roles; KPI values etc. set their own weight.
const sans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

// IBM Plex Mono for provenance — hashes, run times, row counts, IDs. Static
// weights only (no variable axis on Google Fonts); 600 is loaded because a
// few call sites pair `font-mono` with `font-semibold`.
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

// Prompt covers Thai glyphs. It sits after Instrument Sans / Plex Mono in
// every stack (tailwind.config.ts), so Latin stays in the primary face and
// Thai characters fall through to Prompt in every role.
const prompt = Prompt({
  subsets: ["latin", "thai"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-prompt",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Curf — Reports that think, act, and remember",
    template: "%s · Curf",
  },
  description:
    "Curf is the living-reports platform. Design beautiful reports, trust every number, and act on insight without leaving the page.",
  applicationName: "Curf",
  icons: { icon: "/icon.svg", apple: "/apple-icon.svg" },
  // PWA — Next 14 picks up the manifest path here and emits the
  // <link rel="manifest" /> tag. Apple-specific tags get explicit
  // entries below since iOS Safari only honours its own subset.
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Curf",
  },
};

// Round 12 PWA: theme color drives the address-bar color on Chrome
// (mobile) and the splash background on iOS once installed. Match it
// to the manifest's theme_color so install + browse are consistent.
export const viewport: Viewport = {
  themeColor: "#F6F7FB",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read the locale cookie server-side so the LocaleProvider's initial state
  // matches between server and client → no hydration mismatch in the
  // LanguageSwitcher or any locale-dependent copy.
  const cookieLocale = cookies().get("rd_locale")?.value;
  let initialLocale: Locale | undefined =
    cookieLocale && (LOCALES as readonly string[]).includes(cookieLocale)
      ? (cookieLocale as Locale)
      : undefined;
  // Fetched once here and handed to <SessionProvider session=...> so
  // useSession() (and useResilientSession()) already carry the real role
  // and memberships on the server render AND the very first client paint —
  // no post-mount flip from a "viewer" placeholder to the real nav once
  // next-auth's own client-side session fetch resolves. See providers.tsx
  // and lib/useResilientSession.ts for the client half of this.
  const session = await readSession();
  // No cookie yet (new device, fresh SSO sign-in): fall back to the language
  // the user saved, and let the client write it back into the cookie.
  const userId = (session?.user as any)?.id as string | undefined;
  // Same for the year style of Thai dates (rd_era). Always seeded once —
  // Buddhist era when nothing was chosen — so this lookup runs once per
  // device, not on every page.
  const cookieEra = cookies().get("rd_era")?.value;
  let initialEra: Era = cookieEra === "ce" ? "ce" : "be";
  let seedLocaleCookie = false;
  let seedEraCookie = false;
  if (userId && (!initialLocale || !cookieEra)) {
    const saved = await savedDatePrefs(userId);
    if (!initialLocale) {
      initialLocale = saved.locale;
      seedLocaleCookie = !!initialLocale;
    }
    if (!cookieEra) {
      initialEra = saved.era ?? "be";
      seedEraCookie = true;
    }
  }
  // The reader's language only, as a script the browser keeps until the
  // words change; it runs before the page hydrates (lib/i18n/messageStore.ts).
  const versions = Object.fromEntries(LOCALES.map((l) => [l, messagesVersion(l)])) as Record<Locale, string>;
  const locale = initialLocale ?? "en";
  return (
    <html lang={locale} className={cn(sans.variable, mono.variable, prompt.variable)} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <Script src={messagesSrc(locale, versions[locale])} strategy="beforeInteractive" />
        <Providers initialLocale={initialLocale} messageVersions={versions} seedLocaleCookie={seedLocaleCookie} initialEra={initialEra} seedEraCookie={seedEraCookie} session={session}>
          {children}
          {/* PwaShell registers the service worker, listens for the
              beforeinstallprompt event, and renders the offline banner
              + install button. Mounted at the root so it's available on
              every route, and inside Providers so it speaks the reader's language. */}
          <PwaShell />
        </Providers>
      </body>
    </html>
  );
}
