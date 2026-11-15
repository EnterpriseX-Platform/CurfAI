/**
 * GET /i18n/<locale>?v=<version> — one language's words, as a script that
 * puts them where useT() looks (lib/i18n/messageStore.ts). The root layout
 * loads the reader's language before the page hydrates; a language switch
 * loads the next one.
 *
 * Public: it's the app's own copy, the same for everyone, and signed-out
 * pages (sign-in, share links, kiosks) need it too. Asked for with the
 * current version, it's kept for a year: new words mean a new version, and
 * so a new address. Any other version (a page opened before a deploy) gets
 * today's words, not kept.
 *
 * Production pages link the compressed file the build writes instead
 * (lib/i18n/messageFiles.ts); this route serves `next dev`, words changed
 * since the build, and a language switch on a page opened before a deploy.
 * It answers uncompressed: Next doesn't compress a route handler's response,
 * and since 15.5.29 it drops a route handler's own Content-Encoding, so a
 * body compressed here reaches the browser as bytes it can't read.
 */
import { NextRequest } from "next/server";
import { LOCALES, messagesVersion, type Locale } from "@/lib/i18n/dict";
import { messagesScript } from "@/lib/i18n/messageFiles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, props: { params: Promise<{ locale: string }> }) {
  const params = await props.params;
  if (!(LOCALES as readonly string[]).includes(params.locale)) return new Response("Not found", { status: 404 });
  const locale = params.locale as Locale;
  const current = req.nextUrl.searchParams.get("v") === messagesVersion(locale);
  return new Response(messagesScript(locale), {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": current ? "public, max-age=31536000, immutable" : "no-cache",
    },
  });
}
