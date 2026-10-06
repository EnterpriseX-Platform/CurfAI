/**
 * Every English string has a Thai and a Chinese one (a missing key silently
 * falls back to English mid-screen), none is empty, and each translation
 * keeps the same {placeholders} — a dropped "{name}" shows a sentence with
 * the person missing, a renamed one leaves a literal "{nom}" on screen.
 * English-only plural suffixes ({plural}, {rowsPlural}…) may be dropped:
 * Thai and Chinese don't inflect.
 */
import { describe, it, expect } from "vitest";
import { DICT, LOCALES } from "./dict";

const holes = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).filter((x) => !/[Pp]lural$/.test(x)))].sort().join(",");

describe("dictionary parity", () => {
  const en = DICT.en;
  for (const loc of LOCALES.filter((l) => l !== "en")) {
    it(`${loc} has every English key, and nothing English doesn't`, () => {
      expect(Object.keys(en).filter((k) => !(k in DICT[loc]))).toEqual([]);
      expect(Object.keys(DICT[loc]).filter((k) => !(k in en))).toEqual([]);
    });
    it(`${loc} strings are non-empty and keep their placeholders`, () => {
      const bad = Object.keys(en).filter((k) => k in DICT[loc] && (!DICT[loc][k]!.trim() || holes(DICT[loc][k]!) !== holes(en[k]!)));
      expect(bad).toEqual([]);
    });
  }
});
