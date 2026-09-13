/**
 * Forecast helper — Tier 4 of the viz roadmap (ai.forecast_linear, Team).
 *
 * Linear regression projection with a 95% confidence band. Pure JS, no
 * deps. Used by ChartBlock to extend time-series charts (line / area /
 * combo) into the future.
 *
 * Why a separate module: keeps the math testable in isolation and makes it
 * easy to swap the projection method later (we already have `method: "llm"`
 * in the schema, which would route to a Claude-based forecast on Business
 * tier — implementation is a thin wrapper around this same shape, just
 * with the prediction coming from Anthropic instead of OLS).
 *
 * The projection treats x as the row index (1, 2, 3, …) so it works
 * regardless of whether the actual xField is a date string, ISO week, or
 * arbitrary categorical ordinal. The renderer just needs to bind the
 * projected y to the right xField label — see `projectSeries` below.
 */

/**
 * A metric whose observed history was never negative (revenue, spend, lead
 * counts, units sold, …) shouldn't suddenly become "allowed" to go negative
 * just because a straight-line/trend extrapolation crossed zero a few
 * periods out. A short, volatile history projected forward can easily
 * produce a point estimate — or confidence bound — like "-300K leads",
 * which is meaningless for the metric AND forces the chart's Y axis to
 * spend a chunk of its range on a region nothing real ever occupies (that
 * "why is there so much empty space" report traced back to exactly this).
 * A genuinely negative-capable metric (a margin delta, a P&L bridge, a
 * temperature) keeps its full unclamped projection — this only clamps the
 * floor when NONE of the observed history was ever negative.
 */
function clampToObservedSign(value: number, allNonNegative: boolean): number {
  return allNonNegative ? Math.max(0, value) : value;
}

export type ForecastPoint = {
  /** Same shape as a data row, with the projected yField + bounds. */
  [field: string]: unknown;
  __forecast: true;
  __upper: number;
  __lower: number;
};

/**
 * Ordinary-least-squares slope + intercept over (x_i = i, y_i = values[i]).
 * Returns null if the input is degenerate (fewer than 2 finite points or
 * zero variance in x — though x is just the index so the latter is only
 * possible with a single point).
 */
export function linearFit(values: number[]): { slope: number; intercept: number; residualStd: number } | null {
  const finite = values.map((v, i) => [i + 1, v] as const).filter(([, v]) => Number.isFinite(v));
  const n = finite.length;
  if (n < 2) return null;

  const sumX = finite.reduce((s, [x]) => s + x, 0);
  const sumY = finite.reduce((s, [, y]) => s + y, 0);
  const meanX = sumX / n;
  const meanY = sumY / n;

  let num = 0;
  let den = 0;
  for (const [x, y] of finite) {
    num += (x - meanX) * (y - meanY);
    den += (x - meanX) * (x - meanX);
  }
  if (den === 0) return null;
  const slope = num / den;
  const intercept = meanY - slope * meanX;

  // Residual standard deviation — drives the 95% confidence band width.
  let ssRes = 0;
  for (const [x, y] of finite) {
    const yhat = slope * x + intercept;
    ssRes += (y - yhat) * (y - yhat);
  }
  const residualStd = Math.sqrt(ssRes / Math.max(1, n - 2));

  return { slope, intercept, residualStd };
}

/**
 * Project N future periods past the end of the input series.
 *
 * Each output row carries:
 *   - yField  = projected value (so the chart's existing series renders it)
 *   - __forecast = true, so renderers can style it differently (dashed)
 *   - __upper / __lower = 95% confidence interval bounds
 *
 * The xField on each forecast row is filled with a synthesized label
 * (`"+1"`, `"+2"`, … by default; pass `xLabeler` to plug in a date
 * progression like "2025-Q3" → "2025-Q4" → "2026-Q1").
 *
 * Returns an empty array on degenerate input — caller can append safely.
 */
export function projectSeries(
  rows: Array<Record<string, unknown>>,
  yField: string,
  periods: number,
  options: {
    xField?: string;
    xLabeler?: (lastValue: unknown, stepsAhead: number) => string;
  } = {},
): ForecastPoint[] {
  if (periods <= 0 || rows.length === 0) return [];

  const ys = rows.map((r) => Number(r?.[yField]));
  const fit = linearFit(ys);
  if (!fit) return [];

  const { slope, intercept, residualStd } = fit;
  const lastIdx = rows.length;
  const lastX = options.xField ? rows[rows.length - 1]?.[options.xField] : undefined;
  const labeler = options.xLabeler ?? ((_lv, k) => `+${k}`);
  const allNonNegative = ys.every((v) => !Number.isFinite(v) || v >= 0);

  const out: ForecastPoint[] = [];
  for (let k = 1; k <= periods; k++) {
    const xi = lastIdx + k;
    const yhatRaw = slope * xi + intercept;
    // Crude band — 1.96σ each side. For a small N this overstates
    // confidence vs a proper t-distribution scale, but it's a band, not a
    // p-value, so the visual story is what matters.
    const band = 1.96 * residualStd;
    const yhat = clampToObservedSign(yhatRaw, allNonNegative);
    const point: ForecastPoint = {
      __forecast: true,
      __upper: clampToObservedSign(yhatRaw + band, allNonNegative),
      __lower: clampToObservedSign(yhatRaw - band, allNonNegative),
      [yField]: yhat,
    };
    if (options.xField) {
      point[options.xField] = labeler(lastX, k);
    }
    out.push(point);
  }
  return out;
}

/**
 * Holt's linear trend (double exponential smoothing) — the third forecast
 * method alongside OLS ("linear") and the LLM call. Distinct from OLS in
 * one important way: OLS fits ONE straight line through the whole history,
 * so a recent inflection barely moves the slope. Exponential smoothing
 * weights recent points more heavily (via `alpha`/`beta`), so it reacts
 * faster to a trend that just changed — the tradeoff a user picks it for.
 * Still pure JS, still deterministic, no LLM round-trip.
 *
 * alpha smooths the level, beta smooths the trend. 0.3/0.1 are the
 * textbook "moderate responsiveness" defaults (Holt's original working
 * range is roughly 0.1–0.3 for both) — reasonable without per-series
 * tuning, which this function deliberately doesn't attempt.
 */
const ETS_ALPHA = 0.3;
const ETS_BETA = 0.1;

export function exponentialSmoothingFit(
  values: number[],
): { level: number; trend: number; residualStd: number } | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return null;

  let level = finite[0];
  let trend = finite[1] - finite[0];
  let ssRes = 0;
  let n = 0;
  for (let i = 1; i < finite.length; i++) {
    const yhat = level + trend; // one-step-ahead prediction from the PREVIOUS state
    const y = finite[i];
    ssRes += (y - yhat) * (y - yhat);
    n += 1;

    const prevLevel = level;
    level = ETS_ALPHA * y + (1 - ETS_ALPHA) * (level + trend);
    trend = ETS_BETA * (level - prevLevel) + (1 - ETS_BETA) * trend;
  }
  const residualStd = Math.sqrt(ssRes / Math.max(1, n - 1));
  return { level, trend, residualStd };
}

/**
 * Same contract as `projectSeries` (OLS) — see that function's docstring
 * for the shared shape/labeling behavior. The band widens with the
 * horizon (`Math.sqrt(k)`) rather than staying constant, since compounding
 * a per-step trend estimate k steps out is genuinely less certain the
 * further out it goes — OLS's band doesn't do this because a single fitted
 * line has no such compounding.
 */
export function projectSeriesETS(
  rows: Array<Record<string, unknown>>,
  yField: string,
  periods: number,
  options: {
    xField?: string;
    xLabeler?: (lastValue: unknown, stepsAhead: number) => string;
  } = {},
): ForecastPoint[] {
  if (periods <= 0 || rows.length === 0) return [];

  const ys = rows.map((r) => Number(r?.[yField]));
  const fit = exponentialSmoothingFit(ys);
  if (!fit) return [];

  const { level, trend, residualStd } = fit;
  const lastX = options.xField ? rows[rows.length - 1]?.[options.xField] : undefined;
  const labeler = options.xLabeler ?? ((_lv, k) => `+${k}`);
  const allNonNegative = ys.every((v) => !Number.isFinite(v) || v >= 0);

  const out: ForecastPoint[] = [];
  for (let k = 1; k <= periods; k++) {
    const yhatRaw = level + k * trend;
    const band = 1.96 * residualStd * Math.sqrt(k);
    const yhat = clampToObservedSign(yhatRaw, allNonNegative);
    const point: ForecastPoint = {
      __forecast: true,
      __upper: clampToObservedSign(yhatRaw + band, allNonNegative),
      __lower: clampToObservedSign(yhatRaw - band, allNonNegative),
      [yField]: yhat,
    };
    if (options.xField) {
      point[options.xField] = labeler(lastX, k);
    }
    out.push(point);
  }
  return out;
}

export type CadenceUnit = "day" | "week" | "month" | "quarter" | "year" | "point";

/**
 * Infers what one forecast "period" actually represents — day / week /
 * month / quarter / year, or a generic "point" when it can't tell — by
 * looking at the LAST TWO historical x-labels, not assuming a fixed grain.
 *
 * This exists for two reasons:
 *   1. Correctness — the forecast x-label generator used to hard-code "ISO
 *      date → +7 days" for every date-labeled series regardless of the
 *      series' real spacing (a monthly-snapshot chart got weekly-looking
 *      projected dates). `stepDays` here is the REAL gap between the last
 *      two points, so the projection lands on realistic dates.
 *   2. Clarity — "How far ahead: 4" is ambiguous to a viewer. Knowing the
 *      unit lets the UI say "4 months" instead of a bare number.
 */
/**
 * Thai abbreviated month + 2-digit Buddhist-Era year — "ต.ค. 68", "ก.ค. 69" —
 * common in Thai government/budget report SQL (month_label columns). Kept
 * here (not duplicated in ChartBlock.tsx) as the single source of truth;
 * smartXLabel there imports this to advance projected labels the same way.
 */
export const THAI_MONTHS_ABBR: string[] = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];
const THAI_MONTH_RE = new RegExp(`^(${THAI_MONTHS_ABBR.join("|").replace(/\./g, "\\.")})\\s(\\d{2})$`);

export function detectCadenceUnit(
  rows: Array<Record<string, unknown>>,
  xField: string,
): { unit: CadenceUnit; stepDays?: number } {
  if (rows.length < 2) return { unit: "point" };
  const last = rows[rows.length - 1]?.[xField];
  const prev = rows[rows.length - 2]?.[xField];
  if (typeof last !== "string" || typeof prev !== "string") return { unit: "point" };

  if (/^\d{4}-Q[1-4]$/.test(last)) return { unit: "quarter" };
  if (/^\d{4}-\d{2}$/.test(last)) return { unit: "month" };
  if (/^\d{4}$/.test(last)) return { unit: "year" };
  // Thai month labels aren't lexicographically ordered like ISO strings, so
  // there's no cheap "is `last` after `prev`" check — matching the pattern
  // at all is a strong enough signal on its own (real report SQL emits
  // these in chronological order; a categorical chart would essentially
  // never coincidentally produce two consecutive valid Thai month labels).
  if (THAI_MONTH_RE.test(last) && THAI_MONTH_RE.test(prev)) return { unit: "month", stepDays: 30 };

  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (isoDate.test(last) && isoDate.test(prev)) {
    const t1 = new Date(prev).getTime();
    const t2 = new Date(last).getTime();
    if (Number.isFinite(t1) && Number.isFinite(t2) && t2 > t1) {
      const stepDays = Math.round((t2 - t1) / 86_400_000);
      // Boundaries are rough classification, not precise thresholds — a
      // 30-day gap should read as "month," not "4.28 weeks."
      if (stepDays <= 1) return { unit: "day", stepDays };
      if (stepDays <= 9) return { unit: "week", stepDays };
      if (stepDays <= 45) return { unit: "month", stepDays };
      if (stepDays <= 120) return { unit: "quarter", stepDays };
      return { unit: "year", stepDays };
    }
  }
  return { unit: "point" };
}

/**
 * Convenience: returns a merged dataset = original rows + projected rows.
 * Original rows are returned unchanged; projected rows carry __forecast.
 *
 * Renderers that want to draw the actual + projected series with different
 * styles can branch on the `__forecast` flag (e.g. solid line for
 * historical, dashed line for projection, shaded area between __upper and
 * __lower for the band).
 */
export function withForecast(
  rows: Array<Record<string, unknown>>,
  yField: string,
  periods: number,
  options: Parameters<typeof projectSeries>[3] = {},
): Array<Record<string, unknown>> {
  const projected = projectSeries(rows, yField, periods, options);
  return [...rows, ...projected];
}
