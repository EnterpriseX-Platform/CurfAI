/**
 * loadMessages() in the browser: the built file first, the /i18n route when
 * that file isn't there (dev, or a page opened before a deploy replaced it).
 */
import { afterEach, describe, expect, it } from "vitest";
import { MESSAGES_GLOBAL, loadMessages } from "./messageStore";

type FakeScript = { src: string; async: boolean; onload?: () => void; onerror?: () => void; remove: () => void };

/** A document whose <script> tags "load" only the addresses in `serves`, each putting `words` in the store. */
function fakeDocument(serves: (src: string) => boolean, locale: string, words: Record<string, string>) {
  const asked: string[] = [];
  (globalThis as any).document = {
    createElement: (): FakeScript => ({ src: "", async: false, remove() {} }),
    head: {
      appendChild(s: FakeScript) {
        asked.push(s.src);
        queueMicrotask(() => {
          if (!serves(s.src)) return s.onerror?.();
          ((globalThis as any)[MESSAGES_GLOBAL] ??= {})[locale] = words;
          s.onload?.();
        });
      },
    },
  };
  return asked;
}

afterEach(() => {
  delete (globalThis as any).document;
  delete (globalThis as any)[MESSAGES_GLOBAL];
});

describe("loadMessages", () => {
  it("loads the built file", async () => {
    const asked = fakeDocument(() => true, "th", { hello: "สวัสดี" });
    await expect(loadMessages("th", "v1")).resolves.toEqual({ hello: "สวัสดี" });
    expect(asked).toEqual(["/_i18n/th.v1.js"]);
  });

  it("falls back to the route when the built file isn't there", async () => {
    const asked = fakeDocument((src) => src.startsWith("/i18n/"), "zh", { hello: "你好" });
    await expect(loadMessages("zh", "old")).resolves.toEqual({ hello: "你好" });
    expect(asked).toEqual(["/_i18n/zh.old.js", "/i18n/zh?v=old"]);
  });

  it("fails when neither loads", async () => {
    fakeDocument(() => false, "en", {});
    await expect(loadMessages("en", "v1")).rejects.toThrow("couldn't load /i18n/en?v=v1");
  });
});
