/**
 * Writes each language's script to public/_i18n/<locale>.<version>.js, so
 * Next serves it compressed (src/lib/i18n/messageFiles.ts says why). Runs
 * before `next build` (the `prebuild` script); clears the folder first so
 * the image holds only today's words.
 */
import fs from "node:fs";
import path from "node:path";
import { LOCALES, messagesVersion } from "../src/lib/i18n/dict";
import { MESSAGES_STATIC_DIR, messagesScript } from "../src/lib/i18n/messageFiles";
import { messagesStaticName } from "../src/lib/i18n/messageStore";

const dir = path.join(process.cwd(), MESSAGES_STATIC_DIR);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
for (const locale of LOCALES) {
  const name = messagesStaticName(locale, messagesVersion(locale));
  const body = messagesScript(locale);
  fs.writeFileSync(path.join(dir, name), body, "utf8");
  console.log(`i18n: ${path.join(MESSAGES_STATIC_DIR, name)} (${Math.round(Buffer.byteLength(body) / 1024)} KB)`);
}
