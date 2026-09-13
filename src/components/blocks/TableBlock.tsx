"use client";
import { aggregate, formatCell } from "@/lib/reporting/format";
import type { BlockRenderContext } from "./types";
import { cn } from "@/lib/utils";
import { ProvenanceBadge } from "./ProvenanceBadge";
import { ShowWorkButton } from "./ShowWorkButton";
import { AskButton } from "./AskButton";
import { CommentButton } from "./CommentButton";
import { ActionButton } from "./ActionButton";
import type { ConditionalFormat, ConditionalRule } from "@/lib/reporting/schema";
import { useTheme } from "@/components/providers/ThemeProvider";
import { useCurrency } from "@/components/providers/CurrencyProvider";
import { VariantIcon } from "./VariantIcon";
import { useWhy } from "./WhyDrawer";
import { useOperateActions } from "@/components/providers/operate-actions-context";
import { BlockActions } from "./BlockActions";
import { compileFormula, evaluateRow, evaluateAggregate, type FormulaResult } from "@/lib/reporting/formula";
import { BlockEmptyState } from "./BlockEmptyState";
import { useT } from "@/lib/i18n/LocaleContext";

/**
 * Conditional formatting (Tier 1.6 — viz.conditional_table, Team plan).
 *
 * Layered rendering, with first-match-wins for threshold rules:
 *
 *   1. Compute column-wide min/max once per render so heatmap + bar both
 *      have stable scales.
 *   2. For each cell, evaluate threshold rules in declaration order; the
 *      first rule that matches paints the chip foreground/background.
 *   3. Heatmap shading layers under threshold paint (so a "danger" rule
 *      still reads as red even when the heatmap is showing low values).
 *   4. Data bars draw at z-0 behind the cell text.
 *
 * The renderer itself is dumb — it doesn't know about tier gates. Server
 * routes that mutate report config are responsible for refusing to save a
 * conditional rule on a non-Team tenant; once persisted, viewers see the
 * rendered shading regardless of who's looking. This matches how every
 * other tier-gated visual already works (threshold lines, AI captions, …).
 */

// Threshold rules colour the ink, not the cell: status is meaning, and the
// only tinted backgrounds in the system are the seal and selection. Tokens,
// so the same rule reads correctly on a dark dashboard.
const VARIANT_BG: Record<NonNullable<ConditionalRule["variant"]>, string> = {
  success: "font-medium text-success",
  warning: "font-medium text-warning",
  danger:  "font-medium text-destructive",
  info:    "font-medium text-primary-ink",
  neutral: "text-muted-foreground",
};

/**
 * Pick a variant for a cell value by walking the rules. Numeric coerce is
 * intentional — string columns don't get rule matches.
 */
function matchRule(rules: ConditionalRule[] | undefined, value: unknown): ConditionalRule | null {
  if (!rules || rules.length === 0) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  for (const r of rules) {
    if (r.op === "gt"  && n >  r.value) return r;
    if (r.op === "gte" && n >= r.value) return r;
    if (r.op === "lt"  && n <  r.value) return r;
    if (r.op === "lte" && n <= r.value) return r;
    if (r.op === "eq"  && n === r.value) return r;
    if (r.op === "between" && r.value2 !== undefined && n >= r.value && n <= r.value2) return r;
  }
  return null;
}

/**
 * Heatmap fill calculator. Returns an inline rgba background color so we
 * don't bloat Tailwind with arbitrary shades. The four ramps trade off
 * polarity:
 *   - primary:    follows the report theme (theme.ramps.primary tip), heavier at the high end
 *   - diverging:  semantic rose ↔ emerald, zero-centered
 *   - good-bad:   semantic emerald ↔ rose (more = worse: churn, latency)
 *   - bad-good:   semantic rose ↔ emerald (more = better: revenue, NPS)
 *
 * The semantic ramps stay constant — meaning is meaning. Only "primary"
 * is theme-aware. We pre-parse the theme tip into rgb so we can keep the
 * inline style as rgba(r, g, b, alpha).
 */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = h.length === 3
    ? h.split("").map((c) => parseInt(c + c, 16))
    : [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  return [n[0] || 0, n[1] || 0, n[2] || 0];
}

function heatmapStyle(
  value: number,
  min: number,
  max: number,
  ramp: NonNullable<ConditionalFormat["heatmap"]>,
  primaryRgb: [number, number, number],
): React.CSSProperties | undefined {
  if (ramp === "off") return undefined;
  if (max === min) return undefined;
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  if (ramp === "primary") {
    const [r, g, b] = primaryRgb;
    return { backgroundColor: `rgba(${r}, ${g}, ${b}, ${(t * 0.35).toFixed(3)})` };
  }
  if (ramp === "good-bad") {
    return t < 0.5
      ? { backgroundColor: `rgba(16, 185, 129, ${((1 - t * 2) * 0.35).toFixed(3)})` }
      : { backgroundColor: `rgba(244, 63, 94, ${((t * 2 - 1) * 0.35).toFixed(3)})` };
  }
  if (ramp === "bad-good") {
    return t < 0.5
      ? { backgroundColor: `rgba(244, 63, 94, ${((1 - t * 2) * 0.35).toFixed(3)})` }
      : { backgroundColor: `rgba(16, 185, 129, ${((t * 2 - 1) * 0.35).toFixed(3)})` };
  }
  // diverging: rose ↔ emerald, balanced
  return t < 0.5
    ? { backgroundColor: `rgba(244, 63, 94, ${((1 - t * 2) * 0.30).toFixed(3)})` }
    : { backgroundColor: `rgba(16, 185, 129, ${((t * 2 - 1) * 0.30).toFixed(3)})` };
}

export function TableBlock(props: BlockRenderContext) {
  if (props.block.type !== "table") return null;
  return <TableBlockInner {...props} block={props.block} />;
}

type TableInnerProps = Omit<BlockRenderContext, "block"> & { block: Extract<BlockRenderContext["block"], { type: "table" }> };

function TableBlockInner({ block, dataset, provenance, print, report, params, reportDbId, bare }: TableInnerProps) {
  const { queryId, title, columns, stripe, showTotals, actions } = block.config as any;
  const { t } = useT();
  // null on surfaces that don't mount OperateActionsProvider (PDF export,
  // anonymous app views) — the row affordance simply isn't rendered there.
  const onOperateAction = useOperateActions();
  const rows = dataset[queryId] ?? [];
  const proof = !print && provenance ? provenance[queryId] : undefined;
  const ds = !print ? report.dataSources.find((d) => d.id === queryId) ?? null : null;

  // Theme-aware "primary" heatmap — the saturated tip of the active theme's
  // primary ramp drives conditional table heatmap intensity.
  const theme = useTheme();
  const currency = useCurrency();
  const primaryRgb = hexToRgb(theme.ramps.primary[theme.ramps.primary.length - 1]);

  // "Why?" everywhere — clicking a numeric cell decomposes it. Anchor on
  // the FIRST non-numeric column found in the row (typically the row's
  // identity column: campaign / channel / region). The metric is the
  // clicked column's key.
  const openWhy = useWhy();
  const firstStringCol: string | null = (() => {
    const c = (columns as any[]).find((c: any) => c.type === "string");
    return c?.key ?? null;
  })();
  const whyEnabled = !print && !!openWhy && !!reportDbId && !!firstStringCol;

  // Pre-compile formula columns once per render. expr-eval's Parser is
  // ~5x slower than executing a parsed expression, so for a 1000-row
  // table this matters. Bad formulas are stored as a sentinel error so
  // each row can render "#SYNTAX!" with a tooltip without re-parsing.
  type CompiledFormula = { ok: true; expr: ReturnType<typeof compileFormula> } | { ok: false; error: string };
  const formulaCache: Record<string, CompiledFormula> = {};
  for (const col of columns as any[]) {
    if (col.type === "formula" && col.formula) {
      try { formulaCache[col.key] = { ok: true, expr: compileFormula(col.formula) }; }
      catch (e: any) { formulaCache[col.key] = { ok: false, error: e?.message ?? "Bad formula" }; }
    }
  }

  // Pre-compute per-column min/max (once) for any column with conditional
  // formatting that needs it. Skip for non-numeric columns and columns
  // without heatmap/bar — keeps tables with zero conditional formatting at
  // their original cost.
  const colStats = new Map<string, { min: number; max: number; absMax: number }>();
  for (const col of columns as any[]) {
    const cf: ConditionalFormat | undefined = col.conditional;
    if (!cf) continue;
    if (cf.heatmap === "off" && !cf.bar) continue;
    if (col.type !== "number" && col.type !== "currency" && col.type !== "percent") continue;
    const nums = rows
      .map((r: any) => Number(r[col.key]))
      .filter((n: number) => Number.isFinite(n));
    if (nums.length === 0) continue;
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    colStats.set(col.key, { min, max, absMax: Math.max(Math.abs(min), Math.abs(max)) || 1 });
  }

  if (!queryId || rows.length === 0) {
    return <BlockEmptyState type="table" blockId={block.id} title={title} description={t("blockEmpty.noData")} />;
  }

  return (
    // The block is its own card (same frame as the KPI and chart blocks);
    // the table inside it is separated by rules, not by a second box.
    <div className={cn("group relative flex h-full flex-col overflow-hidden", !bare && "rounded-report border border-border bg-card px-5 pb-1 pt-4 shadow-xs")}>
      {!print && (proof || ds) && (
        <div className={cn("absolute z-10", bare ? "right-0 top-0" : "right-3 top-3")}>
          <BlockActions>
            {reportDbId && <AskButton reportId={reportDbId} blockId={block.id} blockType="table" params={params} />}
            {reportDbId && <CommentButton reportId={reportDbId} blockId={block.id} proofHash={proof?.queryHash} />}
            {ds && <ShowWorkButton ds={ds} rows={rows} params={params} />}
            {proof && <ProvenanceBadge record={proof} />}
          </BlockActions>
        </div>
      )}
      <div className="mb-2 flex items-center justify-between gap-3 pr-8">
        <h3 className="truncate text-base font-semibold tracking-tight text-foreground">{title ?? ""}</h3>
        <span className="shrink-0 font-mono text-xs text-faint">table · {rows.length} {t("kpi.rows")}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          {/* Header is a label row, not a band: small caps in the faint ink,
              separated by the rule below it. */}
          <thead className="text-faint">
            <tr>
              {columns.map((col: any) => (
                <th
                  key={col.key}
                  className={cn(
                    "whitespace-nowrap border-b border-border px-3 py-2 text-left text-[11px] font-medium uppercase tracking-[.04em]",
                    col.align === "right" && "text-right",
                    col.align === "center" && "text-center",
                    (col.type === "number" || col.type === "currency" || col.type === "percent") &&
                      !col.align && "text-right"
                  )}
                >
                  {col.label}
                </th>
              ))}
              {!print && ((Array.isArray(actions) && actions.length > 0) || onOperateAction) && (
                <th className="w-1 whitespace-nowrap border-b border-border px-3 py-2 text-right text-[11px] font-medium uppercase tracking-[.04em]">Actions</th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row: any, i: number) => (
              <tr key={i} className={cn("[&:last-child>td]:border-b-0", stripe && i % 2 === 1 && "bg-muted/40")}>
                {columns.map((col: any) => {
                  // Formula columns default to right-align (they're
                  // numeric-looking by default unless the author picked
                  // formulaFormat: "string"). String formulas land left.
                  const isNumericCol =
                    col.type === "number" || col.type === "currency" || col.type === "percent" ||
                    (col.type === "formula" && (col.formulaFormat ?? "number") !== "string");
                  const align =
                    col.align ??
                    (isNumericCol ? "right" : "left");
                  const cf: ConditionalFormat | undefined = col.conditional;
                  // For formula columns, evaluate the compiled expression
                  // against this row + the full dataset. Falls back to a
                  // sentinel "#SYNTAX!" / "#ERROR!" string the renderer
                  // can show when something's wrong, with the underlying
                  // error message exposed as the cell's title attribute.
                  let rawValue: any;
                  let formulaError: string | null = null;
                  if (col.type === "formula") {
                    const compiled = formulaCache[col.key];
                    if (!compiled) rawValue = "";
                    else if (!compiled.ok) { rawValue = "#SYNTAX!"; formulaError = compiled.error; }
                    else {
                      const r = evaluateRow(compiled.expr, row, rows);
                      if (r.error) { rawValue = "#ERROR!"; formulaError = r.error; }
                      else rawValue = r.value;
                    }
                  } else {
                    rawValue = row[col.key];
                  }
                  const numValue = Number(rawValue);
                  const stats = colStats.get(col.key);
                  const matched = matchRule(cf?.rules, rawValue);
                  const heatStyle = cf && stats && Number.isFinite(numValue)
                    ? heatmapStyle(numValue, stats.min, stats.max, cf.heatmap ?? "off", primaryRgb)
                    : undefined;
                  // Mini-bar width: positive values fill from left, negative
                  // from right, centered around zero. We use absMax so bars
                  // stay comparable across the column.
                  let barEl: React.ReactNode = null;
                  if (cf?.bar && stats && Number.isFinite(numValue)) {
                    const pct = Math.min(100, (Math.abs(numValue) / stats.absMax) * 100);
                    const positive = numValue >= 0;
                    // Positive bars use the theme primary tint; negative
                    // bars stay rose (semantic "danger" cue).
                    const [pr, pg, pb] = primaryRgb;
                    barEl = (
                      <span
                        aria-hidden
                        className={cn(
                          "absolute inset-y-1 rounded-sm",
                          positive ? "left-1" : "right-1 bg-destructive/15",
                        )}
                        style={{
                          width: `${pct}%`,
                          maxWidth: "calc(100% - 8px)",
                          ...(positive ? { backgroundColor: `rgba(${pr}, ${pg}, ${pb}, 0.32)` } : null),
                        }}
                      />
                    );
                  }
                  // Formula columns format using formulaFormat (defaults
                  // to "number"); regular columns use the existing path.
                  // Sentinel error strings ("#SYNTAX!" etc) skip formatting
                  // entirely so the literal text shows.
                  const cellText = col.type === "formula"
                    ? (typeof rawValue === "string" && rawValue.startsWith("#")
                        ? rawValue
                        : formatCell(rawValue, col.formulaFormat ?? "number", col.format, currency))
                    : formatCell(rawValue, col.type, col.format, currency);
                  const variantClass = matched ? VARIANT_BG[matched.variant] : "";
                  // "Why?" everywhere — numeric cells in tables that have
                  // a string anchor column become clickable, opening the
                  // Why drawer for {anchorField: row[firstStringCol], metric: col.key}.
                  const isClickable = whyEnabled
                    && Number.isFinite(numValue)
                    && (col.type === "number" || col.type === "currency" || col.type === "percent")
                    && row[firstStringCol!] != null;
                  return (
                    <td
                      key={col.key}
                      className={cn(
                        "relative border-b border-border px-3 py-2.5 text-foreground",
                        align === "right" && "text-right tabular-nums",
                        align === "center" && "text-center",
                        // Short identifiers (SKU-2041, INV-2091) never wrap
                        // mid-token and read in the provenance voice (mono,
                        // muted); prose-length strings still wrap.
                        typeof rawValue === "string" && rawValue.length <= 12 && "whitespace-nowrap",
                        typeof rawValue === "string" && /^[A-Z]{2,6}-?\d{2,}$/i.test(rawValue) && "font-mono text-xs text-muted-foreground",
                        variantClass,
                        isClickable && "cursor-pointer transition-colors hover:bg-primary/5",
                      )}
                      style={!matched ? heatStyle : undefined}
                      onClick={isClickable ? () => openWhy!({
                        reportId: reportDbId!,
                        blockId: block.id,
                        anchor: { field: firstStringCol!, value: String(row[firstStringCol!]) },
                        metric: col.key,
                        label: `${col.label}: ${cellText}`,
                      }) : undefined}
                      title={
                        formulaError ? `Formula error: ${formulaError}` :
                        isClickable ? "Click to ask Why?" : undefined
                      }
                    >
                      {barEl}
                      <span className="relative z-10 inline-flex items-center gap-1.5">
                        {matched && (
                          <VariantIcon
                            kind={matched.iconKind}
                            variant={matched.variant}
                            fallback={matched.icon}
                          />
                        )}
                        {cellText}
                      </span>
                    </td>
                  );
                })}
                {!print && ((reportDbId && Array.isArray(actions) && actions.length > 0) || onOperateAction) && (
                  <td className="whitespace-nowrap border-b border-border px-3 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {reportDbId && Array.isArray(actions) && actions.map((a: any) => (
                        <ActionButton
                          key={a.id}
                          reportId={reportDbId}
                          blockId={block.id}
                          action={a}
                          row={row}
                          params={params}
                        />
                      ))}
                      {/* C1: route this row into Operate — approval chain,
                          SLA and destination — as opposed to the dispatcher
                          actions above, which fire immediately. */}
                      {onOperateAction && (
                        <button
                          type="button"
                          className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:border-primary hover:text-primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOperateAction({
                              reportId: reportDbId ?? "",
                              blockId: block.id,
                              row: row as Record<string, unknown>,
                            });
                          }}
                        >
                          {t("operateActions.rowAction")}
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}

          </tbody>
          {showTotals && columns.some((c: any) => c.total !== "none") && rows.length > 0 && (
            <tfoot className="bg-muted/60 font-medium text-foreground">
              <tr>
                {columns.map((col: any) => {
                  // For formula columns, the column total can mean two
                  // things: (a) sum/avg of the COMPUTED per-row values,
                  // or (b) evaluate the formula against the whole dataset
                  // (e.g. =SUM(spend)/SUM(leads) for a pooled-rate). We
                  // pick (a) — that's what spreadsheet users expect from
                  // a footer aggregate over a derived column. Tenants
                  // who want pooled rates can write that directly as a
                  // separate row in the source query.
                  let agg: number | null = null;
                  if (col.total !== "none") {
                    if (col.type === "formula") {
                      const compiled = formulaCache[col.key];
                      if (compiled?.ok) {
                        const computed = rows.map((r: any) => {
                          const v = evaluateRow(compiled.expr, r, rows).value;
                          return Number(v);
                        }).filter((n: number) => Number.isFinite(n));
                        if (computed.length > 0) {
                          if (col.total === "sum") agg = computed.reduce((a: number, b: number) => a + b, 0);
                          else if (col.total === "avg") agg = computed.reduce((a: number, b: number) => a + b, 0) / computed.length;
                          else if (col.total === "min") agg = Math.min(...computed);
                          else if (col.total === "max") agg = Math.max(...computed);
                          else if (col.total === "count") agg = computed.length;
                        }
                      }
                    } else {
                      agg = aggregate(rows, col.key, col.total);
                    }
                  }
                  return (
                    <td
                      key={col.key}
                      className={cn(
                        "border-t border-border px-3 py-2",
                        (col.type === "number" || col.type === "currency" || col.type === "percent" || col.type === "formula") &&
                          "text-right tabular-nums"
                      )}
                    >
                      {agg == null ? "" : formatCell(agg, col.type === "formula" ? (col.formulaFormat ?? "number") : col.type, col.format, currency)}
                    </td>
                  );
                })}
                {!print && ((Array.isArray(actions) && actions.length > 0) || onOperateAction) && (
                  <td className="border-t border-border px-3 py-2"></td>
                )}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
