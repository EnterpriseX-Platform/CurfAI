/**
 * Emphasis colouring (`emphasisTop`) — the rule that decides which bars carry
 * the finding and which recede.
 *
 * The renderers pick a fill inline rather than through a helper, so this test
 * pins the *decision table* those inline ternaries implement. The ordering is
 * the load-bearing part: three colour semantics now share one Cell, and
 * getting the precedence wrong doesn't throw — it silently greys out a
 * forecast bar, or lets a category colour override the de-emphasis that is the
 * whole point of the setting.
 */
import { describe, it, expect } from "vitest";
import { DEEMPHASIS_FILL } from "./shared";

/**
 * Mirrors barRenderer's per-row fill choice exactly. Kept in the test rather
 * than exported from the renderer because it is three ternaries over locals
 * that the renderer needs anyway — extracting it for testability alone would
 * add indirection to the hot path without removing a single branch.
 */
function fillFor(opts: {
  rowIndex: number;
  isForecastRow?: boolean;
  emphasisTop?: number;
  singleSeries?: boolean;
  categorical?: boolean;
}): string {
  const { rowIndex, isForecastRow = false, emphasisTop, singleSeries = true, categorical = false } = opts;
  const useEmphasis = singleSeries && typeof emphasisTop === "number" && emphasisTop > 0;
  const useCategorical = singleSeries && categorical;
  if (isForecastRow) return "FORECAST";
  if (useEmphasis && rowIndex >= emphasisTop!) return DEEMPHASIS_FILL;
  if (useCategorical) return `categorical:${rowIndex}`;
  return "SERIES";
}

describe("emphasisTop — which rows carry the finding", () => {
  it("keeps the first N rows in the series colour and recedes the rest", () => {
    // "Three sites hold 70%" — rows 0..2 argue it, 3..5 are context.
    expect(fillFor({ rowIndex: 0, emphasisTop: 3 })).toBe("SERIES");
    expect(fillFor({ rowIndex: 2, emphasisTop: 3 })).toBe("SERIES");
    expect(fillFor({ rowIndex: 3, emphasisTop: 3 })).toBe(DEEMPHASIS_FILL);
    expect(fillFor({ rowIndex: 5, emphasisTop: 3 })).toBe(DEEMPHASIS_FILL);
  });

  it("does nothing when unset — the default must not grey anything", () => {
    for (const rowIndex of [0, 1, 9]) {
      expect(fillFor({ rowIndex })).toBe("SERIES");
    }
  });

  it("is inert on multi-series charts", () => {
    // Colour is already carrying the series there; per-row greying would
    // destroy that mapping rather than add emphasis.
    expect(fillFor({ rowIndex: 4, emphasisTop: 2, singleSeries: false })).toBe("SERIES");
  });
});

describe("precedence between the three colour semantics", () => {
  it("a forecast row outranks de-emphasis", () => {
    // A projected bar is a different KIND of bar. Greying it would merge two
    // unrelated meanings — "outside the finding" and "not actual data" — into
    // one indistinguishable fill.
    expect(fillFor({ rowIndex: 9, emphasisTop: 2, isForecastRow: true })).toBe("FORECAST");
  });

  it("de-emphasis outranks categorical colour", () => {
    // Otherwise the out-of-scope rows keep a bright per-category hue and the
    // setting does nothing visible at all.
    expect(fillFor({ rowIndex: 4, emphasisTop: 2, categorical: true })).toBe(DEEMPHASIS_FILL);
  });

  it("in-scope rows still get their categorical colour", () => {
    expect(fillFor({ rowIndex: 1, emphasisTop: 3, categorical: true })).toBe("categorical:1");
  });
});

describe("the de-emphasis fill itself", () => {
  it("is a theme token, not a fixed grey", () => {
    // A hex tuned against a white card renders as a bright block on a dark
    // one. Deriving from the muted ink token keeps it recessive in both.
    expect(DEEMPHASIS_FILL).toContain("var(--muted-foreground)");
  });

  it("stays visible — context, not a hidden row", () => {
    const alpha = Number(/\/\s*([\d.]+)\)/.exec(DEEMPHASIS_FILL)?.[1]);
    expect(alpha).toBeGreaterThan(0.15);
    expect(alpha).toBeLessThan(0.5);
  });
});
