import { describe, it, expect } from "vitest";
import { detectTextRepair, repairRow, repairText } from "./textRepair";

// What a Mac/Windows tool produces when it reads UTF-8 bytes as a single-
// byte code page — built the same way here, from real UTF-8 bytes.
function garble(text: string, table: (b: number) => string): string {
  return Array.from(Buffer.from(text, "utf8")).map((b) => (b < 0x80 ? String.fromCharCode(b) : table(b))).join("");
}
const macRoman = (b: number) => new TextDecoder("macintosh").decode(new Uint8Array([b]));
// Real cp1252 for 0x80–0x9F — Node's TextDecoder("windows-1252") is Latin-1 there.
const CP1252_80_9F = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f" +
  "\u0090‘’“”•–—˜™š›œ\u009džŸ";
const cp1252 = (b: number) => (b < 0xa0 ? CP1252_80_9F[b - 0x80] : String.fromCharCode(b));
const latin1 = (b: number) => String.fromCharCode(b);

describe("repairText", () => {
  it("restores Thai that was read as Mac Roman (the real customer export)", () => {
    // Verbatim from Aging__Provision_by_store_2026.xlsx, row 2.
    const stored = "100226 ‡∏≠‡∏≠‡∏õ‡πÇ‡∏õ‡πâ";
    expect(repairText(stored, "mac_roman")).toBe("100226 ออปโป้");
  });

  it("restores Thai that was read as cp1252", () => {
    expect(repairText(garble("ขายดี", cp1252), "cp1252")).toBe("ขายดี");
  });

  it("round-trips any garbled text back to the original", () => {
    for (const original of ["สาขา 17", "บางนา-ตราด กม.3", "零售银行", "naïve café"]) {
      expect(repairText(garble(original, macRoman), "mac_roman")).toBe(original);
      expect(repairText(garble(original, cp1252), "cp1252")).toBe(original);
      // Tools that decode as strict Latin-1 leave C1 control characters instead.
      expect(repairText(garble(original, latin1), "cp1252")).toBe(original);
    }
  });

  it("leaves genuine text alone", () => {
    for (const fine of ["café", "Müller", "ออปโป้", "plain ascii", "零售银行", "€ 1,299"]) {
      expect(repairText(fine, "mac_roman")).toBe(fine);
      expect(repairText(fine, "cp1252")).toBe(fine);
    }
  });
});

describe("detectTextRepair", () => {
  it("names the encoding when nearly every non-ASCII value repairs", () => {
    const rows = ["ออปโป้", "ซานมิก", "ทีซีแอล"].map((n) => ({ id: 1, name: garble(n, macRoman) }));
    expect(detectTextRepair(rows)).toBe("mac_roman");
  });

  it("says nothing for a file whose text is fine", () => {
    expect(detectTextRepair([{ name: "ออปโป้" }, { name: "café" }, { name: "Acme" }])).toBeNull();
  });

  it("says nothing for plain ASCII", () => {
    expect(detectTextRepair([{ a: "x", b: 1 }])).toBeNull();
  });

  it("does not fire on a mostly-fine file with one odd value", () => {
    const rows = [
      ...Array.from({ length: 20 }, () => ({ name: "ออปโป้" })),
      { name: garble("ซานมิก", macRoman) },
    ];
    expect(detectTextRepair(rows)).toBeNull();
  });
});

describe("repairRow", () => {
  it("repairs keys and string values, and passes other values through", () => {
    const row = { [garble("สาขา", macRoman)]: garble("บางนา", macRoman), qty: 3, ok: true, none: null };
    expect(repairRow(row, "mac_roman")).toEqual({ สาขา: "บางนา", qty: 3, ok: true, none: null });
  });
});
