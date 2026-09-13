import type { Metadata, Viewport } from "next";
import { Instrument_Sans, IBM_Plex_Mono, Prompt } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";
import { Providers } from "./providers";
import { cn } from "@/lib/utils";
import { PwaShell } from "@/components/pwa/PwaShell";
import { LOCALES, type Locale } from "@/lib/i18n/dict";
import { getSession } from "@/lib/auth";

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
  const initialLocale: Locale | undefined =
    cookieLocale && (LOCALES as readonly string[]).includes(cookieLocale)
      ? (cookieLocale as Locale)
      : undefined;
  // Fetched once here and handed to <SessionProvider session=...> so
  // useSession() (and useResilientSession()) already carry the real role
  // and memberships on the server render AND the very first client paint —
  // no post-mount flip from a "viewer" placeholder to the real nav once
  // next-auth's own client-side session fetch resolves. See providers.tsx
  // and lib/useResilientSession.ts for the client half of this.
  const session = await getSession();
  return (
    <html lang={initialLocale ?? "en"} className={cn(sans.variable, mono.variable, prompt.variable)} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <Providers initialLocale={initialLocale} session={session}>{children}</Providers>
        {/* PwaShell registers the service worker, listens for the
            beforeinstallprompt event, and renders the offline banner
            + install button. Mounted at the body root so it's
            available on every route. */}
        <PwaShell />
      </body>
    </html>
  );
}
