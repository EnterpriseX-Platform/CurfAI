import { describe, expect, it } from "vitest";
import { shouldAnimateCountUp } from "./KpiBlock";

/**
 * The count-up snaps the readout to 0 before waiting on the first
 * requestAnimationFrame. A hidden tab never services rAF, so without these
 * guards a KPI worth 8,450,000 renders a confident "0" until the tab is
 * focused — wrong data on screen, not a missing animation.
 */
describe("shouldAnimateCountUp", () => {
  it("animates on a visible tab", () => {
    expect(shouldAnimateCountUp({ visibilityState: "visible" }, false)).toBe(true);
  });

  it("refuses to animate on a hidden tab", () => {
    expect(shouldAnimateCountUp({ visibilityState: "hidden" }, false)).toBe(false);
  });

  it("refuses to animate for reduced-motion viewers even when visible", () => {
    expect(shouldAnimateCountUp({ visibilityState: "visible" }, true)).toBe(false);
  });

  it("reduced motion wins over a hidden tab too", () => {
    expect(shouldAnimateCountUp({ visibilityState: "hidden" }, true)).toBe(false);
  });

  it("animates when there is no visibility signal at all", () => {
    expect(shouldAnimateCountUp(undefined, false)).toBe(true);
    expect(shouldAnimateCountUp({}, false)).toBe(true);
  });
});
