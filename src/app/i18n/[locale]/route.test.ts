/**
 * GET /i18n/<locale> — one language's words as a script the browser keeps,
 * left to Next to compress (Next 15.5.29 drops a route handler's own
 * Content-Encoding, so a body the route compressed itself is unreadable).
 */
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { DICT, messagesVersion } from "@/lib/i18n/dict";

const get = (locale: string, query = "", acceptEncoding?: string) =>
  GET(new NextRequest(`http://localhost/i18n/${locale}${query}`, { headers: acceptEncoding ? { "accept-encoding": acceptEncoding } : {} }), { params: Promise.resolve({ locale }) });
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

  it("is the plain script whatever the browser accepts: compression is Next's", async () => {
    const plain = await bytes(await get("th"));
    const res = await get("th", "", "gzip, deflate, br, zstd");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect((await bytes(res)).equals(plain)).toBe(true);
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
