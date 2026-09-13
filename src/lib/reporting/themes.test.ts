/**
 * Theme palette legibility.
 *
 * A chart series is a large filled shape drawn on the `--card` surface, and
 * that surface is white in light mode and near-black in dark. A palette entry
 * therefore has to clear contrast against BOTH, and the failure mode is silent:
 * the chart renders, the bar is simply invisible against its card. Nothing in
 * typechecking or the render path catches it.
 *
 * This bit Boardroom during development. The obvious consulting palette leads
 * with a deep navy, and the first version did — #1B3A6B, which measures 1.44:1
 * on the dark card, far under the 3:1 WCAG asks of non-text content. It looked
 * right in every light-mode screenshot taken while building it.
 */
import { describe, it, expect } from "vitest";
import { THEME_PRESETS } from "./themes";

/** WCAG relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function toRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}
function contrast(a: string, b: [number, number, number]): number {
  const la = luminance(toRgb(a));
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** sRGB → CIE Lab, for perceptual distance between two series colours. */
function toLab(hex: string): [number, number, number] {
  const [r0, g0, b0] = toRgb(hex).map((v) => v / 255);
  const inv = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const [r, g, b] = [inv(r0), inv(g0), inv(b0)];
  const X = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const Z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(X), f(Y), f(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
/** CIE76 ΔE. Roughly: <10 similar, ~20 clearly different, >40 unrelated. */
function deltaE(a: string, b: string): number {
  const la = toLab(a), lb = toLab(b);
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

// --card from globals.css: 0 0% 100% light, 228 26.3% 11.2% dark.
const LIGHT_CARD: [number, number, number] = [255, 255, 255];
const DARK_CARD: [number, number, number] = [21, 23, 30];

/**
 * 3:1 is the WCAG 2.1 threshold for non-text content (1.4.11) — the right bar
 * for a filled shape whose colour is carrying meaning.
 */
const MIN_CONTRAST = 3;

describe("boardroom palette survives both card surfaces", () => {
  const { palette } = THEME_PRESETS.boardroom;

  it.each(palette.map((c, i) => [i, c] as const))(
    "series %i (%s) clears 3:1 on light and dark",
    (_i, colour) => {
      expect(contrast(colour, LIGHT_CARD)).toBeGreaterThanOrEqual(MIN_CONTRAST);
      expect(contrast(colour, DARK_CARD)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    },
  );

  it("does not regress to a deep navy lead", () => {
    // Guards the specific mistake, not just the threshold: a future edit that
    // "makes Boardroom more McKinsey" by darkening series 0 reintroduces an
    // invisible bar in dark mode. If a deep navy is ever genuinely wanted, it
    // belongs in ramps.primary, where a dark end is the point.
    expect(contrast(palette[0], DARK_CARD)).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it("keeps every pair perceptually distinct, not just adjacent ones", () => {
    // Measured in Lab, deliberately: an earlier version of this test compared
    // HUE and failed on series 1 vs 2, which are ~5° apart and yet obviously
    // different — one is a vivid blue, the other a desaturated slate. Hue
    // alone both rejects legitimate pairs and passes colours that read the
    // same once desaturated. It also has to be all-PAIRS: series 1 and 4 both
    // appear on any four-series chart, so checking only neighbours misses the
    // collision that actually matters.
    for (let i = 0; i < palette.length; i++) {
      for (let j = i + 1; j < palette.length; j++) {
        expect(deltaE(palette[i], palette[j])).toBeGreaterThan(15);
      }
    }
  });

  it("spends its separation budget on the series charts actually use", () => {
    // Three or four series covers almost every exhibit, so those get a wider
    // margin than the tail.
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        expect(deltaE(palette[i], palette[j])).toBeGreaterThan(30);
      }
    }
  });
});

describe("every theme resolves a complete shape", () => {
  it.each(Object.keys(THEME_PRESETS))("%s has 10 series colours and a 5-stop ramp", (slug) => {
    const t = THEME_PRESETS[slug as keyof typeof THEME_PRESETS];
    expect(t.palette).toHaveLength(10);
    expect(t.ramps.primary).toHaveLength(5);
    expect(t.slug).toBe(slug);
    // Semantic tokens are theme-invariant on purpose — "meaning is meaning".
    expect(t.semantic).toBe(THEME_PRESETS.default.semantic);
  });
});
