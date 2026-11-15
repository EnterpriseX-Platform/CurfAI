/**
 * The language scripts a page loads (messageStore.ts), on the server side:
 * the script itself and the address a page asks for.
 *
 * `npm run build` writes each language to public/_i18n/<locale>.<version>.js
 * (scripts/i18n-static.ts), because Next compresses static files and not a
 * route handler's response: Thai is about 1 MB as a script, about 150 KB
 * gzipped. A page links that file when it exists. Otherwise (`next dev`, or
 * the words changed since the build) it links /i18n/<locale>, the route that
 * builds the same script on request. Server only: it reads the disk.
 */
import fs from "node:fs";
import path from "node:path";
import { DICT, messagesVersion, type Locale } from "./dict";
import { MESSAGES_GLOBAL, messagesRouteSrc, messagesStaticName, messagesStaticSrc } from "./messageStore";

/** Where the build writes the language files, under public/. */
export const MESSAGES_STATIC_DIR = path.join("public", "_i18n");

const scripts = new Map<Locale, string>();

/** One language's words, as a script that puts them where useT() looks. Built once per language. */
export function messagesScript(locale: Locale): string {
  let script = scripts.get(locale);
  if (script === undefined) {
    script = `(self.${MESSAGES_GLOBAL}=self.${MESSAGES_GLOBAL}||{})[${JSON.stringify(locale)}]=${JSON.stringify(DICT[locale])};`;
    scripts.set(locale, script);
  }
  return script;
}

const onDisk = new Map<string, boolean>();

/** The address of a language's script: the built file when there is one for today's words, else the route. */
export function messagesSrcFor(locale: Locale, root = process.cwd()): string {
  const version = messagesVersion(locale);
  const file = path.join(root, MESSAGES_STATIC_DIR, messagesStaticName(locale, version));
  let exists = onDisk.get(file);
  if (exists === undefined) {
    exists = fs.existsSync(file);
    onDisk.set(file, exists);
  }
  return exists ? messagesStaticSrc(locale, version) : messagesRouteSrc(locale, version);
}
