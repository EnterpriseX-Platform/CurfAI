"use client";
/**
 * CohortRetentionBlock — the classic Mixpanel/Amplitude retention triangle.
 *
 * Pivots flat rows ({ cohort_period, periods_since_signup, retention_pct,
 * cohort_size? }) into a triangular table:
 *
 *   - Rows = distinct cohort_period values, newest first.
 *   - Columns = 0..N periods-since-signup.
 *   - Cells = retention_pct, color-coded with a single-hue ramp.
 *   - Period-0 cell shows the cohort size (when provided).
 *
 * The triangle shape comes from the natural data: a cohort that signed
 * up 5 periods ago can only have data through period 5; all later
 * cells are empty. We render those as blank — no zero, no hatching —
 * so the eye doesn't read missing as bad.
 *
 * Pure CSS grid; no external chart library. SVG would let us do
 * hover tooltips but the table form lets users copy/paste rows into
 * a spreadsheet, which marketing/CS teams ask for constantly.
 */
import { useMemo } from "react";
import type { BlockRenderContext } from "./types";
import { useTheme } from "@/components/providers/ThemeProvider";
import { BlockActions } from "./BlockActions";

export function CohortRetentionBlock(props: BlockRenderContext) {
  if (props.block.type !== "cohort_retention") return null;
  return <CohortRetentionBlockInner {...props} block={props.block} />;
}

type CohortRetentionInnerProps = Omit<BlockRenderContext, "block"> & { block: Extract<BlockRenderContext["block"], { type: "cohort_retention" }> };

function CohortRetentionBlockInner(ctx: CohortRetentionInnerProps) {
  const cfg = ctx.block.config;
  // Wrapped in useMemo so the `rows` reference stays stable across renders
  // when the underlying dataset entry hasn't changed — also keeps the
  // logical-expression `?? []` out of the downstream useMemo deps array.
  const datasetEntry = ctx.dataset[cfg.queryId];
  const rows = useMemo(() => (datasetEntry ?? []) as any[], [datasetEntry]);
  const theme = useTheme();

  const { cohorts, periodMax, cellByKey, cohortSize } = useMemo(() => {
    return pivot(rows, cfg);
  }, [rows, cfg]);

  // Color scale: take the report theme's primary and lerp from
  // 6%-alpha to full opacity for retention 0..1. Empty cells get a
  // muted background-color so they read as "no data" not "0%".
  const baseColor = theme.palette[0] ?? "#6366f1";

  if (cohorts.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        {cfg.title && <p className="mb-1 text-base font-medium text-foreground">{cfg.title}</p>}
        Cohort retention block — query <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{cfg.queryId}</code> returned no rows.
      </div>
    );
  }

  return (
    <div className={ctx.bare ? "p-1" : "rounded-lg border bg-card p-4"}>
      {!ctx.bare && (
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            {cfg.title && <h3 className="text-base font-semibold">{cfg.title}</h3>}
            {cfg.subtitle && <p className="text-xs text-muted-foreground">{cfg.subtitle}</p>}
          </div>
          {!ctx.print && <BlockActions><></></BlockActions>}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 bg-card px-2 py-1.5 text-left font-medium text-muted-foreground">Cohort</th>
              {Array.from({ length: periodMax + 1 }, (_, i) => i).map((p) => (
                <th key={p} className="px-2 py-1.5 text-center font-medium text-muted-foreground">+{p}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cohorts.map((cohort) => (
              <tr key={cohort}>
                <th className="sticky left-0 whitespace-nowrap bg-card px-2 py-1.5 text-left font-medium text-foreground">
                  {cohort}
                </th>
                {Array.from({ length: periodMax + 1 }, (_, p) => {
                  const cell = cellByKey.get(`${cohort}::${p}`);
                  if (cell == null) {
                    return <td key={p} className="bg-muted/20 px-2 py-1.5" />;
                  }
                  // Period 0 shows cohort size when provided; subsequent
                  // periods show retention as a percent.
                  const isPeriod0 = p === 0;
                  const display =
                    isPeriod0 && cohortSize.has(cohort)
                      ? cohortSize.get(cohort)!.toLocaleString()
                      : cfg.cellFormat === "count"
                      ? Math.round(cell).toLocaleString()
                      : `${(cell * 100).toFixed(1)}%`;
                  // Alpha: clamp 0..1 then floor at 0.06 so even tiny
                  // retention is visible against the cell background.
                  const alpha = Math.max(0.06, Math.min(1, cell));
                  return (
                    <td
                      key={p}
                      className="px-2 py-1.5 text-center font-mono"
                      style={{
                        backgroundColor: hexWithAlpha(baseColor, alpha),
                        color: alpha > 0.55 ? "white" : "currentColor",
                      }}
                      title={`${cohort} · period +${p} · ${display}`}
                    >
                      {display}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function pivot(
  rows: any[],
  cfg: { cohortField: string; periodField: string; retentionField: string; cohortSizeField?: string },
): {
  cohorts: string[];
  periodMax: number;
  cellByKey: Map<string, number>;
  cohortSize: Map<string, number>;
} {
  const cohortSet = new Set<string>();
  let periodMax = 0;
  const cellByKey = new Map<string, number>();
  const cohortSize = new Map<string, number>();

  for (const r of rows) {
    const cohort = String(r[cfg.cohortField] ?? "");
    const period = Number(r[cfg.periodField]);
    const retention = Number(r[cfg.retentionField]);
    if (!cohort || !Number.isFinite(period) || !Number.isFinite(retention)) continue;
    cohortSet.add(cohort);
    if (period > periodMax) periodMax = period;
    cellByKey.set(`${cohort}::${period}`, retention);
    if (cfg.cohortSizeField && r[cfg.cohortSizeField] != null) {
      cohortSize.set(cohort, Number(r[cfg.cohortSizeField]));
    }
  }
  // Sort cohorts descending — newest at top reads naturally as "what
  // happened most recently."
  const cohorts = Array.from(cohortSet).sort((a, b) => b.localeCompare(a));
  return { cohorts, periodMax, cellByKey, cohortSize };
}

/**
 * Apply alpha to a hex color. Accepts #RRGGBB; falls back to the input
 * unchanged on parse failure (better to show an unstyled cell than throw).
 */
function hexWithAlpha(hex: string, alpha: number): string {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return hex;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}
