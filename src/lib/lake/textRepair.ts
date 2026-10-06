/**
 * Undo "mojibake": UTF-8 text that was decoded with a single-byte code page
 * somewhere upstream and saved that way. A workbook exported on a Mac can
 * store "ออปโป้" as "‡∏≠‡∏≠‡∏õ‡πÇ‡∏õ‡πâ" (UTF-8 bytes read as Mac Roman); the
 * Windows equivalent reads them as cp1252 ("à¸­à¸­..."). Every cell is
 * already broken inside the file, so there is nothing the parser can decode
 * differently — the only fix is to reverse the wrong decode.
 *
 * The repair is exact, not a guess: each character maps back to the one
 * byte the wrong code page produced it from, and the result must be valid
 * UTF-8 (TextDecoder fatal mode) or the value is left untouched. Genuine
 * text almost never survives that round trip — "café" becomes the bytes
 * 63 61 66 8E, which is not valid UTF-8 — so an ordinary value is never
 * altered. Detection only decides whether to offer the repair; the user
 * still confirms it in the upload preview.
 */

export type TextRepair = "mac_roman" | "cp1252";

// Bytes 0x80–0xFF as Mac Roman decodes them (generated from Python's
// mac_roman codec, not typed from memory).
const MAC_ROMAN_HIGH =
  "\u00c4\u00c5\u00c7\u00c9\u00d1\u00d6\u00dc\u00e1\u00e0\u00e2\u00e4\u00e3\u00e5\u00e7\u00e9\u00e8" +
  "\u00ea\u00eb\u00ed\u00ec\u00ee\u00ef\u00f1\u00f3\u00f2\u00f4\u00f6\u00f5\u00fa\u00f9\u00fb\u00fc" +
  "\u2020\u00b0\u00a2\u00a3\u00a7\u2022\u00b6\u00df\u00ae\u00a9\u2122\u00b4\u00a8\u2260\u00c6\u00d8" +
  "\u221e\u00b1\u2264\u2265\u00a5\u00b5\u2202\u2211\u220f\u03c0\u222b\u00aa\u00ba\u03a9\u00e6\u00f8" +
  "\u00bf\u00a1\u00ac\u221a\u0192\u2248\u2206\u00ab\u00bb\u2026\u00a0\u00c0\u00c3\u00d5\u0152\u0153" +
  "\u2013\u2014\u201c\u201d\u2018\u2019\u00f7\u25ca\u00ff\u0178\u2044\u20ac\u2039\u203a\ufb01\ufb02" +
  "\u2021\u00b7\u201a\u201e\u2030\u00c2\u00ca\u00c1\u00cb\u00c8\u00cd\u00ce\u00cf\u00cc\u00d3\u00d4" +
  "\uf8ff\u00d2\u00da\u00db\u00d9\u0131\u02c6\u02dc\u00af\u02d8\u02d9\u02da\u00b8\u02dd\u02db\u02c7";

// Bytes 0x80–0x9F as cp1252 decodes them. The five bytes cp1252 leaves
// undefined (81 8D 8F 90 9D) come through as the matching C1 control
// character, which is what Windows tools actually emit for them. 0xA0–0xFF
// are Latin-1, i.e. the byte value itself.
//
// Plenty of tools decode as strict Latin-1 instead (Node's own
// TextDecoder("windows-1252") among them), turning 0x80–0x9F into C1
// control characters rather than € ‚ ƒ …. Those characters never appear in
// genuine cp1252 output, so the reverse table accepts both spellings.
const CP1252_C1 =
  "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f" +
  "\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";

function reverseTable(high: string): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < high.length; i++) m.set(high.charCodeAt(i), 0x80 + i);
  return m;
}

const TO_BYTE: Record<TextRepair, Map<number, number>> = {
  mac_roman: reverseTable(MAC_ROMAN_HIGH),
  cp1252: new Map([
    ...Array.from({ length: 0x20 }, (_, i) => [0x80 + i, 0x80 + i] as [number, number]),
    ...reverseTable(CP1252_C1 + Array.from({ length: 0x60 }, (_, i) => String.fromCharCode(0xa0 + i)).join("")),
  ]),
};

const utf8 = new TextDecoder("utf-8", { fatal: true });
const NON_ASCII = /[^\x00-\x7f]/;

/** The repaired text, or the input unchanged when it isn't this kind of mojibake. */
export function repairText(value: string, encoding: TextRepair): string {
  if (!NON_ASCII.test(value)) return value;
  const toByte = TO_BYTE[encoding];
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) { bytes[i] = code; continue; }
    const b = toByte.get(code);
    if (b === undefined) return value;
    bytes[i] = b;
  }
  try {
    return utf8.decode(bytes);
  } catch {
    return value;
  }
}

/** Every string value (and key) of a row, repaired. Non-strings pass through. */
export function repairRow(row: Record<string, unknown>, encoding: TextRepair): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[repairText(k, encoding)] = typeof v === "string" ? repairText(v, encoding) : v;
  }
  return out;
}

/**
 * Which repair, if any, the sampled text needs. Looks only at values with
 * non-ASCII characters (plain ASCII can't be mojibake) and says yes only
 * when nearly all of them repair — a file that is mostly fine with a few
 * odd cells is not what this is for.
 */
export function detectTextRepair(rows: Array<Record<string, unknown>>): TextRepair | null {
  const candidates: string[] = [];
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (NON_ASCII.test(k)) candidates.push(k);
      if (typeof v === "string" && NON_ASCII.test(v)) candidates.push(v);
    }
    if (candidates.length >= 500) break;
  }
  if (candidates.length === 0) return null;
  let best: TextRepair | null = null;
  let bestShare = 0;
  for (const encoding of ["mac_roman", "cp1252"] as const) {
    const repaired = candidates.filter((s) => repairText(s, encoding) !== s).length;
    const share = repaired / candidates.length;
    if (share > bestShare) { best = encoding; bestShare = share; }
  }
  return bestShare >= 0.9 ? best : null;
}
