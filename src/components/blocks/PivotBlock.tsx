"use client";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/reporting/format";
import { cn } from "@/lib/utils";
import type { BlockRenderContext } from "./types";
import { ProvenanceBadge } from "./ProvenanceBadge";
import { ShowWorkButton } from "./ShowWorkButton";
import { AskButton } from "./AskButton";
import { CommentButton } from "./CommentButton";
import { useTheme } from "@/components/providers/ThemeProvider";
import { useCurrency } from "@/components/providers/CurrencyProvider";
import { BlockActions } from "./BlockActions";
import { BlockEmptyState } from "./BlockEmptyState";

/**
 * Cross-tab / pivot block. Aggregates a flat dataset by two dimensions and
 * one measure, rendering a 2D table with optional row/column totals and a
 * value-scaled heatmap shade.
 *
 * Aggregation runs client-side over the same dataset the chart/table blocks
 * consume, so the existing filter bar fans out to the pivot for free.
 *
 * Author config (see PivotConfigSchema):
 *   - rowField: column name used for row labels (e.g. "region")
 *   - colField: column name used for column labels (e.g. "product")
 *   - valueField: numeric column to aggregate (e.g. "amount")
 *   - aggregation: sum | avg | count | min | max
 */
export function PivotBlock(props: BlockRenderContext) {
  if (props.block.type !== "pivot") return null;
  return <PivotBlockInner {...props} block={props.block} />;
}

type PivotInnerProps = Omit<BlockRenderContext, "block"> & { block: Extract<BlockRenderContext["block"], { type: "pivot" }> };

function PivotBlockInner({ block, dataset, provenance, print, report, params, reportDbId, bare }: PivotInnerProps) {
  const cfg = block.config;
  const rows = (dataset[cfg.queryId] ?? []) as Record<string, unknown>[];
  const proof = !print && provenance ? provenance[cfg.queryId] : undefined;
  const ds = !print ? report.dataSources.find((d) => d.id === cfg.queryId) ?? null : null;

  // Theme-aware heatmap shading. The pivot used to reference the global
  // --primary CSS var, but that's the *Curf brand* primary, not the
  // *report theme* primary — so it never followed the theme. Read the tip
  // of the active theme's primary ramp and convert to rgba inline.
  const theme = useTheme();
  const currency = useCurrency();

  if (!cfg.queryId || rows.length === 0) {
    return <BlockEmptyState type="pivot" blockId={block.id} title={cfg.title} />;
  }

  const tip = theme.ramps.primary[theme.ramps.primary.length - 1];
  const tipRgb = (() => {
    const h = tip.replace("#", "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  })();

  // Aggregate.
  const pivot = aggregate(rows, cfg.rowField, cfg.colField, cfg.valueField, cfg.aggregation);
  const fmt = (n: number | null) =>
    n == null ? "—" :
    cfg.format === "currency" ? formatCurrency(n, currency) :
    cfg.format === "percent"  ? formatPercent(n) :
    formatNumber(n);

  // Cell shading: scale by value relative to overall max in the body. Row/col
  // totals get their own muted background and don't participate in the scale.
  const allValues = pivot.rowKeys.flatMap((rk) =>
    pivot.colKeys.map((ck) => pivot.cells[rk]?.[ck] ?? null).filter((v): v is number => v != null)
  );
  const maxAbs = Math.max(1, ...allValues.map((v) => Math.abs(v)));
  function shadeStyle(v: number | null): React.CSSProperties {
    if (!cfg.heatmap || v == null) return {};
    const intensity = Math.min(1, Math.abs(v) / maxAbs);
    const [r, g, b] = tipRgb;
    return { background: `rgba(${r}, ${g}, ${b}, ${(intensity * 0.35).toFixed(3)})` };
  }

  return (
    <div className={cn(
      "group relative flex h-full flex-col overflow-hidden",
      bare ? "p-1" : "rounded-lg border border-border bg-card p-4 shadow-xs",
    )}>
      {!print && (proof || ds) && (
        <div className="absolute right-2 top-2 z-10">
          <BlockActions>
            {reportDbId && <AskButton reportId={reportDbId} blockId={block.id} blockType="table" params={params} />}
            {reportDbId && <CommentButton reportId={reportDbId} blockId={block.id} proofHash={proof?.queryHash} />}
            {ds && <ShowWorkButton ds={ds} rows={rows} params={params} />}
            {proof && <ProvenanceBadge record={proof} />}
          </BlockActions>
        </div>
      )}
      {!bare && cfg.title && (
        <header className="mb-2">
          <h3 className="text-sm font-semibold text-foreground">{cfg.title}</h3>
          <p className="text-[11px] text-muted-foreground">
            Rows: {cfg.rowField} · Cols: {cfg.colField} · {cfg.aggregation.toUpperCase()}({cfg.valueField})
          </p>
        </header>
      )}
      <div className={"min-h-0 flex-1 overflow-auto " + (bare ? "pt-8" : "")}>
        <table className="w-full text-xs" style={{ tableLayout: "auto", borderCollapse: "collapse" }}>
          <thead>
            <tr className="text-muted-foreground">
              <th className="border-b border-border px-2.5 py-1.5 text-left font-medium">{cfg.rowField}</th>
              {pivot.colKeys.map((ck) => (
                <th key={ck} className="border-b border-border px-2.5 py-1.5 text-right font-medium">{ck}</th>
              ))}
              {cfg.showRowTotals && (
                <th className="border-b border-border bg-muted px-2.5 py-1.5 text-right font-semibold text-foreground">Total</th>
              )}
            </tr>
          </thead>
          <tbody>
            {pivot.rowKeys.map((rk) => (
              <tr key={rk}>
                <td className="border-b border-border/60 px-2.5 py-1.5 align-top">{rk}</td>
                {pivot.colKeys.map((ck) => {
                  const v = pivot.cells[rk]?.[ck] ?? null;
                  return (
                    <td
                      key={ck}
                      className="border-b border-border/60 px-2.5 py-1.5 text-right tabular-nums"
                      style={shadeStyle(v)}
                    >
                      {fmt(v)}
                    </td>
                  );
                })}
                {cfg.showRowTotals && (
                  <td className="border-b border-border/60 bg-muted/60 px-2.5 py-1.5 text-right font-semibold tabular-nums">
                    {fmt(pivot.rowTotals[rk] ?? null)}
                  </td>
                )}
              </tr>
            ))}
            {cfg.showColTotals && (
              <tr className="bg-muted/60">
                <td className="px-2.5 py-1.5 font-semibold">Total</td>
                {pivot.colKeys.map((ck) => (
                  <td key={ck} className="px-2.5 py-1.5 text-right font-semibold tabular-nums">
                    {fmt(pivot.colTotals[ck] ?? null)}
                  </td>
                ))}
                {cfg.showRowTotals && (
                  <td className="px-2.5 py-1.5 text-right font-semibold tabular-nums">
                    {fmt(pivot.grandTotal)}
                  </td>
                )}
              </tr>
            )}
          </tbody>
        </table>
        {pivot.rowKeys.length === 0 && (
          <div className="p-6 text-center text-xs text-muted-foreground">No rows to pivot.</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

type PivotResult = {
  rowKeys: string[];
  colKeys: string[];
  cells: Record<string, Record<string, number>>;
  rowTotals: Record<string, number>;
  colTotals: Record<string, number>;
  grandTotal: number;
};

export function aggregate(
  rows: Record<string, unknown>[],
  rowField: string,
  colField: string,
  valueField: string,
  agg: "sum" | "avg" | "count" | "min" | "max",
): PivotResult {
  const rowKeySet = new Set<string>();
  const colKeySet = new Set<string>();
  // For avg we need running sum + count per cell.
  const sums: Record<string, Record<string, number>> = {};
  const counts: Record<string, Record<string, number>> = {};
  const mins: Record<string, Record<string, number>> = {};
  const maxs: Record<string, Record<string, number>> = {};

  for (const row of rows) {
    const r = String(row[rowField] ?? "—");
    const c = String(row[colField] ?? "—");
    rowKeySet.add(r);
    colKeySet.add(c);
    sums[r]   = sums[r]   ?? {};
    counts[r] = counts[r] ?? {};
    mins[r]   = mins[r]   ?? {};
    maxs[r]   = maxs[r]   ?? {};
    const raw = row[valueField];
    const num = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(num)) continue;
    sums[r][c]   = (sums[r][c] ?? 0) + num;
    counts[r][c] = (counts[r][c] ?? 0) + 1;
    mins[r][c]   = mins[r][c] == null ? num : Math.min(mins[r][c], num);
    maxs[r][c]   = maxs[r][c] == null ? num : Math.max(maxs[r][c], num);
  }

  const rowKeys = Array.from(rowKeySet).sort();
  const colKeys = Array.from(colKeySet).sort();
  const cells: Record<string, Record<string, number>> = {};
  for (const r of rowKeys) {
    cells[r] = {};
    for (const c of colKeys) {
      const sum   = sums[r]?.[c]   ?? null;
      const count = counts[r]?.[c] ?? 0;
      const mn    = mins[r]?.[c]   ?? null;
      const mx    = maxs[r]?.[c]   ?? null;
      let v: number | null = null;
      if (agg === "sum")    v = sum;
      else if (agg === "avg")   v = (sum != null && count > 0) ? sum / count : null;
      else if (agg === "count") v = count > 0 ? count : null;
      else if (agg === "min")   v = mn;
      else if (agg === "max")   v = mx;
      if (v != null) cells[r][c] = v;
    }
  }

  // Totals: same aggregation applied across the row / column / whole grid.
  const rowTotals: Record<string, number> = {};
  const colTotals: Record<string, number> = {};
  for (const r of rowKeys) {
    const vals: number[] = [];
    for (const c of colKeys) {
      const v = cells[r][c];
      if (v != null) vals.push(v);
    }
    rowTotals[r] = totalOf(vals, agg);
  }
  for (const c of colKeys) {
    const vals: number[] = [];
    for (const r of rowKeys) {
      const v = cells[r][c];
      if (v != null) vals.push(v);
    }
    colTotals[c] = totalOf(vals, agg);
  }
  const flat: number[] = [];
  for (const r of rowKeys) for (const c of colKeys) {
    const v = cells[r][c];
    if (v != null) flat.push(v);
  }
  const grandTotal = totalOf(flat, agg);

  return { rowKeys, colKeys, cells, rowTotals, colTotals, grandTotal };
}

function totalOf(vals: number[], agg: "sum" | "avg" | "count" | "min" | "max"): number {
  if (vals.length === 0) return 0;
  if (agg === "sum")   return vals.reduce((s, v) => s + v, 0);
  if (agg === "avg")   return vals.reduce((s, v) => s + v, 0) / vals.length;
  if (agg === "count") return vals.length;
  if (agg === "min")   return Math.min(...vals);
  if (agg === "max")   return Math.max(...vals);
  return 0;
}
