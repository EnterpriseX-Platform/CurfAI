"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, X, Filter, Download, Workflow, Zap, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { eeClient } from "@/ee/client";

const NewRequestDialog = eeClient.operate?.NewRequestDialog ?? null;
import { useT } from "@/lib/i18n/LocaleContext";
import { formatCell as formatTyped } from "@/lib/reporting/format";
import type { Era } from "@/lib/i18n/formatDate";
import { CurrencyProvider, useCurrency } from "@/components/providers/CurrencyProvider";
import { DateStyleProvider, useDateStyle } from "@/components/providers/DateStyleProvider";

/**
 * Slide-out panel that surfaces the underlying rows behind a clicked value
 * (lib/reporting/drill.ts) — from the report viewer and from dashboards.
 * Mounted once per surface; useDrillRows() fetches what it shows.
 *
 * Trust-layer note: the panel deliberately doesn't claim its own provenance
 * - it ran the configured drilldown query against live data, which is one
 * step removed from the chart's aggregate. We surface the filter +
 * row-count so the reader sees exactly what they're looking at.
 */

export type DrillState = {
  open: boolean;
  loading: boolean;
  blockId: string | null;
  title: string;
  filterParam: string;
  filterValue: unknown;
  rowCount: number;
  columns: string[];
  /** The drill's own columns (DrillThroughSchema.columns), when it names them. */
  columnDefs?: DrillColumn[] | null;
  rows: Record<string, unknown>[];
  truncated: boolean;
  error: string | null;
  /** Curf Operate trigger context — set when the drill panel opens
   *  from a chart click in a report we have an id for. Surfaces the
   *  Operate "Run business action" panel inline. */
  reportId?: string;
  /** The drilled report's money and year style, for formatting cells. */
  reportCurrency?: string | null;
  tenantCurrency?: string | null;
  dateEra?: Era | null;
};

export type DrillColumn = { key: string; label: string; type: string; format?: string };

export const DRILL_INITIAL: DrillState = {
  open: false, loading: false, blockId: null, title: "",
  filterParam: "", filterValue: "", rowCount: 0,
  columns: [], rows: [], truncated: false, error: null,
  reportId: undefined,
};

/**
 * The rows behind a click: POST /api/reports/:id/drill with the surface's
 * current filters, into the panel's state. One per surface (report viewer,
 * dashboard), whatever block was clicked.
 */
export function useDrillRows() {
  const [state, setState] = useState<DrillState>(DRILL_INITIAL);
  const open = useCallback(async (req: {
    reportId: string; blockId: string; value: unknown; params: Record<string, unknown>;
    reportCurrency?: string | null; tenantCurrency?: string | null; dateEra?: Era | null;
  }) => {
    const { reportId, blockId, value, params, ...style } = req;
    setState({ ...DRILL_INITIAL, open: true, loading: true, blockId, ...style });
    try {
      const res = await fetch("/api/reports/" + reportId + "/drill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blockId, value, params }),
      });
      const json = await res.json();
      if (!res.ok) {
        setState((s) => ({ ...s, loading: false, error: json.error ?? "Drill failed" }));
        return;
      }
      setState({
        open: true, loading: false, blockId, ...style,
        title: json.title ?? "",
        filterParam: json.filterParam ?? "",
        filterValue: json.filterValue,
        rowCount: json.rowCount,
        columns: json.columns ?? [],
        columnDefs: json.columnDefs ?? null,
        rows: json.rows ?? [],
        truncated: !!json.truncated,
        error: null,
        // The Operate hook records which report the click came from.
        reportId,
      });
    } catch (e: any) {
      setState((s) => ({ ...s, loading: false, error: e?.message ?? "Drill failed" }));
    }
  }, []);
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);
  return { state, open, close };
}

/** What the panel lists: the drill's own columns, or every column the query returned, typed by its values. */
function panelColumns(state: DrillState): DrillColumn[] {
  if (state.columnDefs?.length) return state.columnDefs;
  return state.columns.map((key) => {
    const vals = state.rows.map((r) => r[key]).filter((v) => v != null && v !== "");
    const type = vals.length && vals.every((v) => typeof v === "number") ? "number"
      : vals.length && vals.every((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}(T|$)/.test(v)) ? "date"
      : "string";
    return { key, label: key, type };
  });
}

export function DrillPanel({ state, onClose }: { state: DrillState; onClose: () => void }) {
  const { t } = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  // Operate hooks — fetch matching chart_click templates the moment the
  // panel opens, then optionally surface the action picker / dialog.
  const [actions, setActions] = useState<any[] | null>(null);
  const [pickedTemplateId, setPickedTemplateId] = useState<string | null>(null);

  useEffect(() => {
    if (!state.open) { setActions(null); setPickedTemplateId(null); return; }
    // reportId is a stable prop for this whole panel-open lifecycle (unlike
    // OperateActionsProvider's one-fetch-serves-many-blocks mount), so
    // scoping the already-happening fetch costs nothing extra. Absent when
    // a drill opens without a resolvable report id — the param is simply
    // omitted and behavior is unchanged (today's tenant-wide list).
    // Operate is paid: no request dialog in the registry means no
    // templates route to ask either.
    if (!NewRequestDialog) { setActions([]); return; }
    const qs = new URLSearchParams({ triggerKind: "chart_click", enabledOnly: "1" });
    if (state.reportId) qs.set("reportId", state.reportId);
    if (state.blockId) qs.set("blockId", state.blockId);
    fetch(`/api/operate/templates?${qs.toString()}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setActions(j.items || []))
      .catch(() => setActions([]));
  }, [state.open, state.reportId, state.blockId]);

  // Esc to close.
  useEffect(() => {
    if (!state.open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.open, onClose]);

  if (!state.open) return null;

  return (
    <>
      {/* Backdrop. Click to close, but only catches outside the panel. */}
      <div
        className="fixed inset-0 z-40 bg-foreground/20 backdrop-blur-[1px] transition-opacity"
        onClick={onClose}
      />
      {/* Panel itself. */}
      <aside
        ref={panelRef}
        className="fixed right-0 top-0 z-50 flex h-full w-full max-w-2xl flex-col border-l border-border bg-background shadow-2xl"
        role="dialog" aria-label={t("drillPanel.ariaLabel")}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("drillPanel.title")}
            </p>
            <h2 className="mt-0.5 truncate text-base font-semibold">{state.title}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {/* A KPI's drill has no filter: the rows behind the whole number. */}
              {state.filterParam && (
                <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[11px] text-primary">
                  <Filter className="h-3 w-3" />
                  {String(state.filterValue)}
                </span>
              )}
              {!state.loading && !state.error && (
                <span className="text-[11px]">
                  {state.rowCount === 1
                    ? t("drillPanel.rowCountOne").replace("{n}", String(state.rowCount))
                    : t("drillPanel.rowCountMany").replace("{n}", String(state.rowCount))}
                  {state.truncated && " " + t("drillPanel.truncatedNote")}
                </span>
              )}
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose} title={t("drillPanel.closeTooltip")} className="h-8 w-8 shrink-0 p-0">
            <X className="h-4 w-4" />
          </Button>
        </header>

        {/* Operate actions panel — surfaces matching templates inline so
           the user can fire a workflow from the same row they're staring
           at. Hidden when no chart_click templates exist for this tenant. */}
        {actions && actions.length > 0 && (
          <section className="border-b border-border bg-muted/40 px-5 py-3">
            <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Workflow className="h-3 w-3" /> {t("drillPanel.runActionHeading")}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {actions.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setPickedTemplateId(a.id)}
                  className="group inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-accent/30"
                  title={a.description ?? a.name}
                >
                  <Zap className="h-3 w-3 text-muted-foreground transition-colors group-hover:text-primary" />
                  {a.name}
                  {a.dryRun && <span className="rounded-full bg-warning/10 px-1 py-0 text-[9px] font-semibold uppercase text-warning">{t("drillPanel.dryBadge")}</span>}
                  <ChevronRight className="h-3 w-3 text-muted-foreground/60 transition group-hover:translate-x-0.5 group-hover:text-foreground" />
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {state.loading && (
            <div className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("drillPanel.loadingRows")}
            </div>
          )}
          {state.error && (
            <div className="m-5 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              {state.error}
            </div>
          )}
          {!state.loading && !state.error && state.rows.length === 0 && (
            <div className="p-12 text-center text-sm text-muted-foreground">
              {t("drillPanel.noRows")}
            </div>
          )}
          {!state.loading && !state.error && state.rows.length > 0 && (
            <CurrencyProvider reportCurrency={state.reportCurrency ?? null} tenantCurrency={state.tenantCurrency ?? null}>
              <DateStyleProvider reportEra={state.dateEra ?? null}>
                <DrillRows columns={panelColumns(state)} rows={state.rows} />
              </DateStyleProvider>
            </CurrencyProvider>
          )}
        </div>

        {!state.loading && !state.error && state.rows.length > 0 && (
          <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3 text-xs text-muted-foreground">
            <span>{t("drillPanel.footerNote")}</span>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => downloadCsv(state, panelColumns(state))}>
              <Download className="mr-1 h-3 w-3" /> {t("drillPanel.csvButton")}
            </Button>
          </footer>
        )}
      </aside>

      {/* New-request dialog rendered above the drill panel, prefilled
         with the first row's columns so chart click → action submit is
         a 3-click workflow (click bar → click action chip → submit). */}
      {NewRequestDialog && <NewRequestDialog
        open={!!pickedTemplateId}
        onClose={() => setPickedTemplateId(null)}
        prefillTemplateId={pickedTemplateId ?? undefined}
        lockTemplate
        prefillInput={buildPrefill(state)}
        triggerContext={{
          source: "chart_click",
          reportId: state.reportId,
          blockId: state.blockId ?? undefined,
          value: state.filterValue,
        }}
        title={t("drillPanel.runBusinessActionTitle")}
      />}
    </>
  );
}

/**
 * Build the prefill bag from the drilled rows. Strategy:
 *   - If exactly one row → use its columns directly (richest case).
 *   - If many rows → use the filter (param=value) so a one-row template
 *     fed with "province" gets the clicked province name.
 *   - Always include the chart's filter pair so templates can reference
 *     the clicked dimension by name.
 */
function buildPrefill(state: DrillState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (state.filterParam) out[state.filterParam] = state.filterValue;
  if (state.rows.length === 1) {
    for (const [k, v] of Object.entries(state.rows[0])) out[k] = v;
  } else if (state.rows.length > 1) {
    // For multi-row drills, surface the first numeric column's sum so
    // amount-style fields can prefill — common case for "send notice
    // about overrun ฿X" templates.
    for (const c of state.columns) {
      const isNumeric = state.rows.every((r) => r[c] == null || typeof r[c] === "number");
      if (isNumeric) {
        const sum = state.rows.reduce((acc, r) => acc + (typeof r[c] === "number" ? (r[c] as number) : 0), 0);
        if (sum !== 0) out[c] = sum;
      }
    }
  }
  return out;
}

/** The rows, each cell formatted by its column's type — money, dates and numbers the way the report shows them. */
function DrillRows({ columns, rows }: { columns: DrillColumn[]; rows: Record<string, unknown>[] }) {
  const currency = useCurrency();
  const dateStyle = useDateStyle();
  const numeric = (c: DrillColumn) => c.type === "number" || c.type === "currency" || c.type === "percent";
  const cell = (c: DrillColumn, v: unknown) =>
    v == null || v === "" ? "—"
      : typeof v === "object" ? JSON.stringify(v)
      : formatTyped(v, c.type, c.format, currency, dateStyle);
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-muted/95 backdrop-blur">
        <tr>
          {columns.map((c) => (
            <th key={c.key} className={"border-b border-border px-3 py-2 font-semibold text-muted-foreground " + (numeric(c) ? "text-right" : "text-left")}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-border/60 last:border-b-0 hover:bg-muted/50">
            {columns.map((c) => (
              <td key={c.key} className={"px-3 py-2 align-top " + (numeric(c) ? "text-right tabular-nums" : "")}>
                {cell(c, r[c.key])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The rows as CSV: the panel's headings, the values as they came (no formatting). */
function downloadCsv(state: DrillState, columns: DrillColumn[]) {
  const lines = [columns.map((c) => csvEscape(c.label)).join(",")];
  for (const row of state.rows) {
    lines.push(columns.map((c) => csvEscape(row[c.key])).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "drill-" + (state.filterParam ? state.filterParam + "-" + String(state.filterValue) : "rows") + ".csv";
  a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
