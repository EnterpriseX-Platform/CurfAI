/**
 * Chart style presets. The load-bearing test here is the "classic" one: this
 * feature ships to tenants with existing reports, and the whole safety
 * argument is that nothing changes for anyone who doesn't opt in. If a future
 * edit tunes classic's tokens "while we're in here", every report in every
 * workspace silently restyles — so classic's values are pinned literally
 * against what the renderers shipped with, not against CHART_STYLE_PRESETS
 * itself (which would tautologically pass).
 */
import { describe, it, expect } from "vitest";
import {
  CHART_STYLE_PRESETS,
  resolveChartStyle,
  directLabelsFit,
} from "./chartStyles";

describe("resolveChartStyle", () => {
  it("falls back to classic for missing / unknown slugs", () => {
    // Same contract as resolveTheme: a report saved against a preset we later
    // rename must still render rather than throw.
    expect(resolveChartStyle(undefined).slug).toBe("classic");
    expect(resolveChartStyle(null).slug).toBe("classic");
    expect(resolveChartStyle("").slug).toBe("classic");
    expect(resolveChartStyle("nope").slug).toBe("classic");
  });

  it("resolves each real slug to itself", () => {
    for (const slug of ["classic", "modern", "enterprise"] as const) {
      expect(resolveChartStyle(slug).slug).toBe(slug);
    }
  });
});

describe("classic reproduces the pre-chartStyle rendering", () => {
  const c = CHART_STYLE_PRESETS.classic;

  it("keeps the exact bar geometry the renderers shipped with", () => {
    // barRenderer.tsx: barRadius [3,3,0,0] / [0,3,3,0], maxBarSize 14|48,
    // barCategoryGap "35%" horizontal / "20%" vertical.
    expect(c.bar.radius).toBe(3);
    expect(c.bar.maxBarSize).toEqual({ vertical: 48, horizontal: 14 });
    expect(c.bar.categoryGap).toEqual({ vertical: "20%", horizontal: "35%" });
    expect(c.bar.pill).toBe(false);
    // A track only ever appeared behind a horizontal ranked list.
    expect(c.bar.track).toBe("list");
  });

  it("keeps a line at 2.5 and an area outline at 2, which shipped different", () => {
    // Same trap as comboRadius below: renderLineChart hardcoded 2.5 while
    // renderAreaChart's outline was 2. A single shared stroke token would have
    // restyled every existing line chart the moment classic landed.
    expect(c.line.strokeWidth).toBe(2.5);
    expect(c.area.strokeWidth).toBe(2);
    expect(c.line.roundCap).toBe(false);
    expect(c.line.dots).toBe(true);
    expect(c.showBrush).toBe(true);
  });

  it("keeps combo bars at 6, which shipped different from plain bars at 3", () => {
    // lineAreaComboRenderers.tsx used radius={[6,6,0,0]} for combo bars while
    // barRenderer used 3. Collapsing these into one token would restyle every
    // existing combo chart the moment classic was introduced.
    expect(c.bar.comboRadius).toBe(6);
    expect(c.bar.comboRadius).not.toBe(c.bar.radius);
  });

  it("stays flat — gradients were area/combo only", () => {
    expect(c.fill.gradient).toBe(false);
  });

  it("keeps the value axis and does not force labels on", () => {
    // Turning either of these would drop the axis out from under every
    // existing chart.
    expect(c.valueAxis).toBe(true);
    expect(c.forceDataLabels).toBe(false);
  });

  it("keeps the dashed grid, square pie ends and the 0.05 area floor", () => {
    expect(c.grid).toBe("dashed");
    expect(c.pie.cornerRadius).toBe(0);
    expect(c.pie.innerRadius).toBe("55%");
    expect(c.pie.paddingAngle).toBe(2);
    expect(c.treemap.rx).toBe(3);
    expect(c.treemap.strokeWidth).toBe(2);
    expect(c.treemap.monochrome).toBe(false);
    expect(c.area).toEqual({ strokeWidth: 2, roundCap: false, filled: true, fadeToZero: false });
    expect(c.waterfall).toEqual({ connectors: false, signedLabels: false });
  });
});

describe("the opt-in styles actually differ", () => {
  it("modern is the decorative direction: gradient, softer corners", () => {
    const m = CHART_STYLE_PRESETS.modern;
    expect(m.fill.gradient).toBe(true);
    expect(m.bar.radius).toBeGreaterThan(CHART_STYLE_PRESETS.classic.bar.radius);
    expect(m.pie.cornerRadius).toBeGreaterThan(0);
    expect(m.area.fadeToZero).toBe(true);
  });

  it("no style puts a ghost track behind a plain magnitude bar", () => {
    // A track reads as "X out of a possible Y". On a ranked list the row's own
    // full width is a fair Y; on a revenue-by-category chart the only Y
    // available is the rounded-up axis max, which is not a real denominator.
    // Modern shipped as "always" briefly and it both misled and looked broken
    // (a bar fading toward its base is paler than the track behind it, so the
    // track read as a detached second bar).
    for (const s of Object.values(CHART_STYLE_PRESETS)) {
      expect(s.bar.track).not.toBe("always");
    }
  });

  it("keeps gradient bars opaque enough to sit on the axis", () => {
    // A bar fading to ~0.5 at its base washes out against the card and stops
    // reading as a solid object. 0.65 is the floor the combo renderer has
    // shipped with all along.
    for (const s of Object.values(CHART_STYLE_PRESETS)) {
      if (s.fill.gradient) expect(s.fill.stops[1]).toBeGreaterThanOrEqual(0.6);
    }
  });

  it("enterprise is the opposite direction: flatter and squarer than classic", () => {
    // The point worth guarding — enterprise is not "more modern", it removes
    // decoration. A future edit that gives it a gradient has misunderstood it.
    const e = CHART_STYLE_PRESETS.enterprise;
    expect(e.fill.gradient).toBe(false);
    expect(e.bar.radius).toBeLessThan(CHART_STYLE_PRESETS.classic.bar.radius);
    expect(e.grid).toBe("none");
    expect(e.bar.track).toBe("never");
    expect(e.treemap.rx).toBe(0);
    expect(e.treemap.monochrome).toBe(true);
    expect(e.area.filled).toBe(false);
    expect(e.waterfall.signedLabels).toBe(true);
    // A line chart is the case where "enterprise" is easiest to under-apply:
    // it has no fill to drop and no bars to square off, so without these it
    // ends up as classic-minus-grid. Thin precise stroke, unmarked line, and
    // no drag-to-zoom strip on a style built for print.
    expect(e.line.strokeWidth).toBeLessThan(CHART_STYLE_PRESETS.classic.line.strokeWidth);
    expect(e.line.dots).toBe(false);
    expect(e.showBrush).toBe(false);
  });

  it("both label-forcing styles drop the value axis, and vice versa", () => {
    // These two travel together: dropping the axis without labels leaves a
    // chart with no scale at all.
    for (const s of Object.values(CHART_STYLE_PRESETS)) {
      expect(s.valueAxis).toBe(!s.forceDataLabels);
    }
  });
});

describe("directLabelsFit", () => {
  it("allows direct labels only for single-series charts", () => {
    // Labels on grouped/stacked bars overlap regardless of category count.
    expect(directLabelsFit(4, false)).toBe(false);
    expect(directLabelsFit(4, true)).toBe(true);
  });

  it("gates at 12 rows, matching barRenderer's existing ranked-list rule", () => {
    expect(directLabelsFit(12, true)).toBe(true);
    expect(directLabelsFit(13, true)).toBe(false);
  });
});
