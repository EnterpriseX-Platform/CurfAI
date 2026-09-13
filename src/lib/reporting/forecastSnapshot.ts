/**
 * Forecast Accuracy / Trust Layer — deciding WHICH forecast rows are worth
 * recording as a ForecastSnapshot. Pure, no Prisma/fetch — shared as-is
 * between the client (ChartBlock.tsx computes candidates before POSTing
 * them) and any server-side caller, so "what counts as verifiable" is
 * defined in exactly one place.
 *
 * Deliberately scoped to ISO-date x-labels only (YYYY-MM-DD). A prediction
 * can only be graded later if we can compute "when does this arrive" as a
 * real calendar date to sweep against — quarter/month/year-formatted labels
 * ("2025-Q4", "2025-04") aren't real Date-parseable strings, and a plain
 * "+1"/"+2" categorical label has no date at all. Those chart types simply
 * don't get accuracy tracking for now rather than silently guessing a date.
 */

export type SnapshotCandidate = {
  targetLabel: string;
  targetDate: Date;
  predictedValue: number;
  upperBound: number;
  lowerBound: number;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Filters a forecast-augmented dataset (rows flagged `__forecast: true`,
 * shape produced by lib/reporting/forecast.ts's projectSeries/projectSeriesETS)
 * down to the subset worth recording for later accuracy grading.
 */
export function buildSnapshotCandidates(
  rows: Array<Record<string, unknown>>,
  xField: string,
  yField: string,
): SnapshotCandidate[] {
  const out: SnapshotCandidate[] = [];
  for (const row of rows) {
    if ((row as any).__forecast !== true) continue;
    const label = row[xField];
    if (typeof label !== "string" || !ISO_DATE.test(label)) continue;
    const date = new Date(label);
    if (Number.isNaN(date.getTime())) continue;
    const predicted = Number(row[yField]);
    const upper = Number((row as any).__upper);
    const lower = Number((row as any).__lower);
    if (!Number.isFinite(predicted) || !Number.isFinite(upper) || !Number.isFinite(lower)) continue;
    out.push({ targetLabel: label, targetDate: date, predictedValue: predicted, upperBound: upper, lowerBound: lower });
  }
  return out;
}
