import { describe, it, expect } from "vitest";
import { accentInk, accentSoft, accentTint } from "./accent";

describe("accentInk", () => {
  it("picks white ink for a dark accent", () => {
    expect(accentInk("#0A2A1E").fg).toBe("#ffffff");
  });

  it("picks dark ink for a pale accent (luma > 0.6)", () => {
    expect(accentInk("#F5F5F0").fg).toBe("#141413");
  });

  it("falls back to white ink for an unparsable hex", () => {
    expect(accentInk("not-a-color").fg).toBe("#ffffff");
  });

  it("accepts a hex without a leading #", () => {
    expect(accentInk("0A2A1E").fg).toBe("#ffffff");
  });
});

describe("accentSoft", () => {
  it("returns a 12%-alpha rgba of the accent", () => {
    expect(accentSoft("#ff0000")).toBe("rgba(255,0,0,.12)");
  });

  it("falls back to the default indigo tint for an unparsable hex", () => {
    expect(accentSoft("nope")).toBe("rgba(99,102,241,.12)");
  });
});

describe("accentTint", () => {
  it("lightens toward white for a positive pct", () => {
    // #000000 + 50% toward white -> #808080 (rounds 127.5 -> 128 = 0x80)
    expect(accentTint("#000000", 0.5)).toBe("#808080");
  });

  it("fully whitens at pct 1", () => {
    expect(accentTint("#123456", 1)).toBe("#ffffff");
  });

  it("returns the original hex unchanged at pct 0", () => {
    expect(accentTint("#123456", 0)).toBe("#123456");
  });

  it("shades toward #141413 (not pure black) for a negative pct", () => {
    // #ffffff - 100% toward #141413 -> #141413 exactly
    expect(accentTint("#ffffff", -1)).toBe("#141413");
  });

  it("clamps magnitudes past 1 to a full tint/shade", () => {
    expect(accentTint("#123456", 2)).toBe(accentTint("#123456", 1));
    expect(accentTint("#123456", -2)).toBe(accentTint("#123456", -1));
  });

  it("returns the input unchanged for an unparsable hex", () => {
    expect(accentTint("not-a-color", 0.5)).toBe("not-a-color");
  });
});
