/**
 * The reference line at a chart's series average, filled in once the
 * chart's rows exist — asked for by the report blueprint (autoCurf.ts) and
 * applied by the pre-publish gate (reportGate.ts). Its own module so the
 * gate, which ships in the Community edition, doesn't need all of autoCurf.
 */
import type { Report } from "@/lib/reporting/schema";

/**
 * Fill in the reference line at the series average for the chart blocks
 * the blueprint asked it on, now that their rows exist. Skips a block
 * whose query returned nothing or whose first series isn't numeric — an
 * average of nothing is not a line worth drawing.
 */
export function applyAverageLines(report: Report, dataset: Record<string, Array<Record<string, unknown>>>, blockIds: string[]): Report {
  if (blockIds.length === 0) return report;
  const want = new Set(blockIds);
  return {
    ...report,
    pages: report.pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((b) => {
        if (b.type !== "chart" || !want.has(b.id)) return b;
        const cfg = b.config as any;
        const rows = dataset[cfg.queryId] ?? [];
        const nums = rows.map((r) => Number(r[cfg.yFields?.[0]])).filter((n) => Number.isFinite(n));
        if (nums.length < 2) return b;
        const value = nums.reduce((a, n) => a + n, 0) / nums.length;
        // Horizontal bars put the value on the x axis.
        const axis = cfg.orientation === "horizontal" ? "x" : "y";
        return { ...b, config: { ...cfg, referenceLines: [{ axis, value, label: "Average", variant: "neutral" }] } } as typeof b;
      }),
    })),
  };
}
