/**
 * The language script's address: the file the build wrote when it holds
 * today's words, else the /i18n route (dev, or words changed since the build).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DICT, messagesVersion } from "./dict";
import { MESSAGES_STATIC_DIR, messagesScript, messagesSrcFor } from "./messageFiles";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "curf-i18n-"));
}

describe("messagesSrcFor", () => {
  it("is the built file when there is one for today's words", () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, MESSAGES_STATIC_DIR), { recursive: true });
    fs.writeFileSync(path.join(root, MESSAGES_STATIC_DIR, `th.${messagesVersion("th")}.js`), messagesScript("th"));
    expect(messagesSrcFor("th", root)).toBe(`/_i18n/th.${messagesVersion("th")}.js`);
  });

  it("is the route when the build wrote no file, or one for other words", () => {
    const root = tempRoot();
    expect(messagesSrcFor("en", root)).toBe(`/i18n/en?v=${messagesVersion("en")}`);
    fs.mkdirSync(path.join(root, MESSAGES_STATIC_DIR), { recursive: true });
    fs.writeFileSync(path.join(root, MESSAGES_STATIC_DIR, "zh.an-older-build.js"), "");
    expect(messagesSrcFor("zh", root)).toBe(`/i18n/zh?v=${messagesVersion("zh")}`);
  });
});

describe("messagesScript", () => {
  it("puts the language's words where useT() looks", () => {
    const self: Record<string, any> = {};
    new Function("self", messagesScript("zh"))(self);
    expect(self.__CURF_I18N__.zh).toEqual(DICT.zh);
  });
});
