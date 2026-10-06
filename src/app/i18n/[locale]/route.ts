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
 * Compressed here: Next compresses pages and static files but not a route
 * handler's response, and Thai is 758 KB as it stands (116 KB in Brotli).
 * Each language is compressed once per encoding and kept.
 */
import { NextRequest } from "next/server";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import { DICT, LOCALES, messagesVersion, type Locale } from "@/lib/i18n/dict";
import { MESSAGES_GLOBAL } from "@/lib/i18n/messageStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Encoding = "br" | "gzip" | "identity";

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);
const bodies = new Map<string, Promise<Buffer>>();

function scriptFor(locale: Locale): Buffer {
  return Buffer.from(`(self.${MESSAGES_GLOBAL}=self.${MESSAGES_GLOBAL}||{})[${JSON.stringify(locale)}]=${JSON.stringify(DICT[locale])};`, "utf8");
}

function bodyFor(locale: Locale, encoding: Encoding): Promise<Buffer> {
  const key = `${locale}:${encoding}`;
  let body = bodies.get(key);
  if (!body) {
    const raw = scriptFor(locale);
    body = encoding === "br"
      ? brotli(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
      : encoding === "gzip" ? gz(raw, { level: 9 }) : Promise.resolve(raw);
    bodies.set(key, body);
    // A failed compression isn't kept: the next request tries again.
    body.catch(() => bodies.delete(key));
  }
  return body;
}

function encodingFor(accept: string | null): Encoding {
  const a = (accept ?? "").toLowerCase();
  return /\bbr\b/.test(a) ? "br" : /\bgzip\b/.test(a) ? "gzip" : "identity";
}

export async function GET(req: NextRequest, { params }: { params: { locale: string } }) {
  if (!(LOCALES as readonly string[]).includes(params.locale)) return new Response("Not found", { status: 404 });
  const locale = params.locale as Locale;
  const current = req.nextUrl.searchParams.get("v") === messagesVersion(locale);
  let encoding = encodingFor(req.headers.get("accept-encoding"));
  const body = await bodyFor(locale, encoding).catch(() => { encoding = "identity"; return bodyFor(locale, "identity"); });
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Content-Length": String(body.length),
      "Cache-Control": current ? "public, max-age=31536000, immutable" : "no-cache",
      Vary: "Accept-Encoding",
      ...(encoding === "identity" ? {} : { "Content-Encoding": encoding }),
    },
  });
}
