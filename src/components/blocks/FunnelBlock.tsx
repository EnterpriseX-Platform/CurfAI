"use client";
/**
 * FunnelBlock — horizontal step-by-step conversion bars.
 *
 * Reads rows shaped like the lib/cohort/sql.ts funnelConversionSql
 * output: { step_name, users_reached, conversion_from_prior?, conversion_from_top? }.
 *
 * Each step renders as a horizontal bar whose width is proportional
 * to (users_reached / max_users_reached). Two label clusters:
 *   - Inside / right of the bar: absolute count (formatted)
 *   - Below the bar: "→ X% from prior · Y% from top"
 *
 * The step shape is intentionally NOT a tapered trapezoid — the
 * trapezoidal funnel, while iconic, is a poor visual encoding because
 * the eye reads the slope rather than the (only-meaningful) horizontal
 * width. Decreasing-width bars are a clearer encoding for the same data.
 *
 * When conversion_from_prior / conversion_from_top columns aren't
 * present, the renderer derives them from successive users_reached
 * values, so the block is forward-compatible with custom queries
 * that only return the count.
 */
import { useMemo } from "react";
import type { BlockRenderContext } from "./types";
import { useTheme } from "@/components/providers/ThemeProvider";
import { BlockActions } from "./BlockActions";

export function FunnelBlock(props: BlockRenderContext) {
  if (props.block.type !== "funnel") return null;
  return <FunnelBlockInner {...props} block={props.block} />;
}

type FunnelInnerProps = Omit<BlockRenderContext, "block"> & { block: Extract<BlockRenderContext["block"], { type: "funnel" }> };

function FunnelBlockInner(ctx: FunnelInnerProps) {
  const cfg = ctx.block.config;
  // Wrapped in useMemo so a stable reference is fed into the downstream
  // useMemo deps — keeps the logical-expression `?? []` out of the deps array.
  const datasetEntry = ctx.dataset[cfg.queryId];
  const rows = useMemo(() => (datasetEntry ?? []) as any[], [datasetEntry]);
  const theme = useTheme();

  const steps = useMemo(() => normalize(rows, cfg), [rows, cfg]);

  if (steps.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        {cfg.title && <p className="mb-1 text-base font-medium text-foreground">{cfg.title}</p>}
        Funnel block — query <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{cfg.queryId}</code> returned no rows.
      </div>
    );
  }

  const max = steps[0]?.reached ?? 1;
  const baseColor = theme.palette[0] ?? "#6366f1";

  return (
    <div className={ctx.bare ? "p-1" : "rounded-lg border bg-card p-4"}>
      {!ctx.bare && (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            {cfg.title && <h3 className="text-base font-semibold">{cfg.title}</h3>}
            {cfg.subtitle && <p className="text-xs text-muted-foreground">{cfg.subtitle}</p>}
          </div>
          {!ctx.print && <BlockActions><></></BlockActions>}
        </div>
      )}
      <ol className="space-y-3">
        {steps.map((s, i) => {
          const widthPct = max > 0 ? Math.max(2, Math.round((s.reached / max) * 100)) : 0;
          // Inside-bar label flips to the right of the bar when the bar
          // is too narrow to fit the count text.
          const labelInside = widthPct >= 18;
          return (
            <li key={s.name + ":" + i}>
              <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                <span className="font-medium text-foreground">{i + 1}. {s.name}</span>
                {!labelInside && (
                  <span className="font-mono text-muted-foreground">{formatCount(s.reached)}</span>
                )}
              </div>
              <div className="relative h-9 rounded bg-muted/40">
                <div
                  className="absolute inset-y-0 left-0 flex items-center justify-end rounded px-3 text-xs font-mono text-white"
                  style={{ width: `${widthPct}%`, backgroundColor: baseColor }}
                >
                  {labelInside && formatCount(s.reached)}
                </div>
              </div>
              {(s.fromPrior != null || s.fromTop != null) && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {s.fromPrior != null && (
                    <span>
                      <span className={s.fromPrior < 0.5 ? "text-destructive" : ""}>
                        {(s.fromPrior * 100).toFixed(1)}%
                      </span>
                      {" from prior"}
                    </span>
                  )}
                  {s.fromPrior != null && s.fromTop != null && <span> · </span>}
                  {s.fromTop != null && (
                    <span>{(s.fromTop * 100).toFixed(1)}% from top</span>
                  )}
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

type Step = { name: string; reached: number; fromPrior: number | null; fromTop: number | null };

function normalize(
  rows: any[],
  cfg: { stepField: string; reachedField: string; conversionFromPriorField?: string; conversionFromTopField?: string },
): Step[] {
  if (rows.length === 0) return [];
  const out: Step[] = rows.map((r) => ({
    name: String(r[cfg.stepField] ?? ""),
    reached: Number(r[cfg.reachedField]) || 0,
    fromPrior: cfg.conversionFromPriorField && r[cfg.conversionFromPriorField] != null
      ? Number(r[cfg.conversionFromPriorField])
      : null,
    fromTop: cfg.conversionFromTopField && r[cfg.conversionFromTopField] != null
      ? Number(r[cfg.conversionFromTopField])
      : null,
  })).filter((s) => s.name);

  // Derive missing conversions from row order if the query didn't
  // include them. The first step is always 100% from top, undefined
  // from prior.
  if (out.length > 0) {
    const top = out[0].reached || 1;
    for (let i = 0; i < out.length; i++) {
      if (out[i].fromTop == null) out[i].fromTop = out[i].reached / top;
      if (i > 0 && out[i].fromPrior == null) {
        const prev = out[i - 1].reached || 1;
        out[i].fromPrior = out[i].reached / prev;
      }
    }
  }
  return out;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toLocaleString();
}
