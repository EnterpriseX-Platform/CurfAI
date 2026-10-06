/**
 * GET /i18n/<locale> — one language's words as a script the browser keeps,
 * compressed by the route itself (Next doesn't compress a route handler's
 * response; uncompressed, Thai is 758 KB).
 */
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { GET } from "./route";
import { DICT, messagesVersion } from "@/lib/i18n/dict";

const get = (locale: string, query = "", acceptEncoding?: string) =>
  GET(new NextRequest(`http://localhost/i18n/${locale}${query}`, { headers: acceptEncoding ? { "accept-encoding": acceptEncoding } : {} }), { params: { locale } });
const bytes = async (res: Response) => Buffer.from(await res.arrayBuffer());

describe("GET /i18n/<locale>", () => {
  it("is the language's words, as a script that puts them where useT() looks", async () => {
    const res = await get("th");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("content-encoding")).toBeNull();
    const script = (await bytes(res)).toString("utf8");
    const self: Record<string, any> = {};
    new Function("self", script)(self);
    expect(self.__CURF_I18N__.th).toEqual(DICT.th);
  });

  it("is compressed for a browser that takes Brotli or gzip, and says which", async () => {
    const plain = await bytes(await get("th"));
    const br = await get("th", "", "gzip, deflate, br, zstd");
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("vary")).toBe("Accept-Encoding");
    const brBody = await bytes(br);
    expect(brotliDecompressSync(brBody).equals(plain)).toBe(true);
    expect(brBody.length).toBeLessThan(plain.length / 4);
    expect(br.headers.get("content-length")).toBe(String(brBody.length));

    const gzRes = await get("th", "", "gzip, deflate");
    expect(gzRes.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(await bytes(gzRes)).equals(plain)).toBe(true);
  });

  it("is kept for a year only when asked for with the current version", async () => {
    expect((await get("en", `?v=${messagesVersion("en")}`)).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await get("en", "?v=an-older-build")).headers.get("cache-control")).toBe("no-cache");
    expect((await get("en")).headers.get("cache-control")).toBe("no-cache");
  });

  it("answers 404 for a language the app doesn't have", async () => {
    expect((await get("fr")).status).toBe(404);
  });
});
