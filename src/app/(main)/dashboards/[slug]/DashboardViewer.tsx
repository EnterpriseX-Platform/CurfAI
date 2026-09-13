"use client";
/**
 * Dashboard viewer — two distinct experiences sharing one component:
 *
 * - Interactive (default): a normal in-app page — sidebar/topbar (AppShell)
 *   intact, scrollable, every report slot shown at once ("war room" density)
 *   instead of auto-rotating one at a time. Drill-through re-scopes a whole
 *   slot's report by clicking a chart/map, tracked per-slot in the URL so
 *   it's a real sub-page (survives refresh, browser Back walks it up).
 * - Non-interactive ("On Screen" wall-display duplicates, `interactive:
 *   false`): the original full-screen, auto-rotating kiosk — no app chrome,
 *   fixed viewport, no scroll, no drill-through. Built for a TV/monitor with
 *   nobody at the keyboard. Reports are pre-fetched server-side and stacked
 *   as absolutely-positioned divs; only the active slot has opacity-100.
 *   Rotation is driven by a single setTimeout per slot — no
 *   requestAnimationFrame, no per-frame React state. The progress bar uses a
 *   pure CSS @keyframes animation (defined inline at the bottom of this
 *   file) so the browser compositor handles it without re-rendering React.
 *
 * Kiosk controls (logged-in viewer only — token-based kiosk hides exit):
 *   Space       pause / resume rotation
 *   ← / →       previous / next report
 *   F           toggle browser fullscreen
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { formatValue } from "@/components/blocks/charts/shared";
import { isIdentifierLabel } from "@/lib/reporting/format";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { ReportDocument } from "@/components/reports/ReportDocument";
import { Pause, Play, ChevronLeft, ChevronRight, Maximize2, X as CloseIcon, Sparkles, Eye, ShoppingCart, MessageCircle, Banknote, TrendingUp, Users, GripVertical, Pencil, Check } from "lucide-react";
import { useRealtimeEvents, LiveBadge } from "@/components/realtime/LiveIndicator";
import { BlockRegistry } from "@/components/blocks";
import { useT } from "@/lib/i18n/LocaleContext";
import type { Block, Report } from "@/lib/reporting/schema";
import { DrillThroughContext, type DrillThroughHandler } from "@/components/providers/drill-through-context";
import { OperateActionsProvider } from "@/components/providers/OperateActionsProvider";
import { DrillBreadcrumbBar, type DrillBreadcrumbStep } from "@/components/blocks/DrillBreadcrumbBar";
import { AppShell } from "@/components/layout/AppShell";
import { useToast } from "@/lib/toast";
import { resolveTheme } from "@/lib/reporting/themes";
import GridLayout, { WidthProvider, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";

const ResponsiveGridLayout = WidthProvider(GridLayout);
const CUSTOM_GRID_COLS = 12;
const CUSTOM_GRID_ROW_HEIGHT = 40;
// Vertical space a custom-layout card's header (name + Live badge, py-4 +
// border) takes out of its allotted grid rows before the chart body gets
// the remainder — mirrors the card markup built in renderGridCell below.
const CUSTOM_CELL_CHROME_PX = 88;
// A card's chart body needs real pixels to render into (Recharts collapses
// to nothing usable below this) — floor applied regardless of how short a
// saved/dragged row count is.
const CUSTOM_CELL_MIN_BODY_PX = 120;
// Cards aggregate reports that may each carry a different report-level
// theme, so there's no single "the" theme to read per card — the default
// preset's accent keeps every card visually tied together instead of a
// flat, undifferentiated border. Resolved once at module scope: this is a
// fixed color from lib/reporting/themes.ts, not a per-render computation.
const DASHBOARD_ACCENT = resolveTheme(undefined).swatch;

function defaultSlotPos(i: number): SlotPos {
  return { x: (i % 2) * 6, y: Math.floor(i / 2) * 9, w: 6, h: 9 };
}

type Slot = {
  id: string;
  name: string;
  rendered: null | {
    definition: any;
    dataset: Record<string, unknown[]>;
    provenance: Record<string, unknown>;
    params: Record<string, unknown>;
  };
  error?: string;
};

type DashboardPayload = {
  id: string;
  slug: string;
  name: string;
  rotationSeconds: number;
  theme: "light" | "dark";
  layout?: "carousel" | "grid_2x2" | "grid_2x1" | "table_only" | "table_chart" | "chart_only" | "custom";
  /** false = passive wall display: drill-through, "Why?", Comment/Ask/Embed,
   *  and forecast-overlay controls are suppressed. Defaults to true (every
   *  dashboard created before this flag existed keeps its old behavior). */
  interactive?: boolean;
  slots: Slot[];
  topKpis?: any[];
  /** Tenant default currency for the top-KPI strip. Falls back to "USD". */
  currency?: string;
  /** reportId -> {x,y,w,h} on a 12-col grid. Only read when layout === "custom". */
  slotLayout?: Record<string, { x: number; y: number; w: number; h: number }>;
};

type SlotPos = { x: number; y: number; w: number; h: number };

/** Per-slot drill breadcrumb map, keyed by slot (report) id — an interactive
 *  dashboard shows every slot at once, so more than one can be drilled into
 *  simultaneously, unlike the old single-active-slide model. */
type DrillMap = Record<string, DrillBreadcrumbStep[]>;

/**
 * Geographic drill params nest in a fixed hierarchy (region > province >
 * district), unlike orthogonal facets such as "ministry" that can combine
 * freely with any of them. Picking a new region while a province from a
 * DIFFERENT region is still active would otherwise produce a self-
 * contradictory filter (region=X AND province=<city in Y>) and a breadcrumb
 * that reads in click order instead of geography ("สตูล / ภาคกลาง") — every
 * level at or below the one just picked is dropped, and steps always render
 * in hierarchy order regardless of the order they were clicked in.
 */
const GEO_DRILL_ORDER = ["region", "province", "district"];
function geoDrillRank(param: string): number {
  const i = GEO_DRILL_ORDER.indexOf(param);
  return i === -1 ? GEO_DRILL_ORDER.length : i;
}

// --- Widget Extraction Logic ---
// We prioritize finding high-value visual blocks for the dashboard.
const VISUAL_KINDS = new Set(["chart", "progress", "pivot", "heatmap", "map", "funnel", "cohort_retention"]);

function extractWidget(reportDef: Report | undefined | null): Block | null {
  if (!reportDef || !reportDef.pages) return null;

  for (const page of reportDef.pages) {
    if (!page.blocks) continue;
    // Sort visually (top->bottom, left->right) just like ReportDocument does
    const sorted = [...page.blocks].sort((a, b) => (a.y - b.y) || (a.x - b.x));

    for (const block of sorted) {
      if (VISUAL_KINDS.has(block.type)) {
        return block; // Found a high-value visual widget!
      }
    }
  }

  return null; // Return null if no chart found, so we can try auto-charting
}

function extractTable(reportDef: Report | undefined | null): Block | null {
  if (!reportDef || !reportDef.pages) return null;
  for (const page of reportDef.pages) {
    if (!page.blocks) continue;
    const sorted = [...page.blocks].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    for (const block of sorted) {
      if (block.type === "table") return block;
    }
  }
  return null;
}

/**
 * Dashboards show only KPI/chart/visual blocks, never raw data tables —
 * a wall display or drill-down view is for reading a shape at a glance,
 * not scrolling a grid. Returns a shallow-cloned report with every page's
 * `table` blocks removed; every other block type passes through untouched.
 */
function stripTables(reportDef: Report | undefined | null): any {
  if (!reportDef?.pages) return reportDef;
  return {
    ...reportDef,
    pages: reportDef.pages.map((page) => {
      const original = page.blocks ?? [];
      const kept = original.filter((b) => b.type !== "table");
      if (kept.length === original.length) return { ...page, blocks: kept };

      // ReportDocument places every block at an absolute CSS grid row
      // (gridRow: block.y+1 / span block.h) — removing a table without
      // re-flowing the blocks below it leaves a blank gap exactly the
      // table's height. Compact: a row collapses only if no *kept* block
      // still spans it (a block sitting beside the table keeps its row).
      const maxRow = original.reduce((m, b) => Math.max(m, b.y + b.h), 0);
      const occupied = new Array(maxRow).fill(false);
      for (const b of kept) {
        for (let r = b.y; r < b.y + b.h; r++) occupied[r] = true;
      }
      const rowMap = new Array(maxRow);
      let cursor = 0;
      for (let r = 0; r < maxRow; r++) {
        rowMap[r] = cursor;
        if (occupied[r]) cursor++;
      }
      return { ...page, blocks: kept.map((b) => ({ ...b, y: rowMap[b.y] })) };
    }),
  };
}

function synthesizeChart(dataset: Record<string, unknown[]> | undefined): { block: Block, newData: any[] } | null {
  if (!dataset) return null;
  const queryIds = Object.keys(dataset);
  if (queryIds.length === 0) return null;

  const queryId = queryIds[0];
  const data = dataset[queryId];

  if (!data || !Array.isArray(data) || data.length === 0) return null;

  const firstRow = data[0] as Record<string, unknown>;
  const keys = Object.keys(firstRow);

  const stringCols = keys.filter(k => typeof firstRow[k] === "string");
  // Don't treat ID columns as metrics to plot
  const numberCols = keys.filter(k => (typeof firstRow[k] === "number" || typeof firstRow[k] === "bigint") && !/id$/i.test(k));

  if (stringCols.length > 0 && numberCols.length > 0) {
    // We have both strings and numbers, plot them directly
    return {
      block: {
        type: "chart",
        id: "auto_chart_" + queryId,
        x: 0, y: 0, w: 12, h: 8,
        config: {
          queryId,
          chartType: "bar",
          xField: stringCols[0],
          yFields: [numberCols[0]],
        },
      } as any,
      newData: data
    };
  } else if (stringCols.length > 0) {
    // Only strings: count frequencies of the first string column
    // Skip 'id' columns if possible
    const col = stringCols.find(c => !/id$/i.test(c)) || stringCols[0];
    const counts: Record<string, number> = {};
    for (const row of data) {
      const val = String((row as any)[col]);
      counts[val] = (counts[val] || 0) + 1;
    }
    const aggregated = Object.entries(counts).map(([k, v]) => ({ [col]: k, count: v }));
    return {
      block: {
        type: "chart",
        id: "auto_chart_" + queryId,
        x: 0, y: 0, w: 12, h: 8,
        config: {
          queryId,
          chartType: "bar",
          xField: col,
          yFields: ["count"],
        },
      } as any,
      newData: aggregated
    };
  } else if (numberCols.length > 0) {
    // Only numbers: plot them against row index
    const newData = data.map((row, i) => ({ ...(row as Record<string, any>), index: `Row ${i + 1}` }));
    return {
      block: {
        type: "chart",
        id: "auto_chart_" + queryId,
        x: 0, y: 0, w: 12, h: 8,
        config: {
          queryId,
          chartType: "line",
          xField: "index",
          yFields: [numberCols[0]],
        },
      } as any,
      newData
    };
  }
  return null; // Return null if no chart found, so we can try auto-charting
}

// --- AI Explanation Widget ---
function AiExplanationWidget({ reportName, dataset }: { reportName: string, dataset: any }) {
  const [explanation, setExplanation] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { t, locale } = useT();

  useEffect(() => {
    async function fetchExplanation() {
      try {
        setLoading(true);
        const res = await fetch("/api/dashboards/explain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reportName, dataset, locale }),
        });
        if (res.ok) {
          const json = await res.json();
          setExplanation(json.explanation);
        } else {
          setExplanation(t("dashboardViewer.aiExplainFailed"));
        }
      } catch (err) {
        setExplanation(t("dashboardViewer.aiExplainError"));
      } finally {
        setLoading(false);
      }
    }
    fetchExplanation();
  }, [reportName, dataset, locale, t]);

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex items-center gap-1.5 mb-3">
        <Sparkles className="w-4 h-4 text-primary" />
        <span className="text-xs font-semibold text-primary uppercase tracking-wider">{t("dashboardViewer.aiInsight")}</span>
      </div>
      {loading ? (
        <div className="animate-pulse flex flex-col gap-3 mt-2">
          <div className="h-3 bg-muted rounded w-full"></div>
          <div className="h-3 bg-muted rounded w-[90%]"></div>
          <div className="h-3 bg-muted rounded w-[70%]"></div>
        </div>
      ) : (
        <p className="text-sm leading-relaxed text-muted-foreground whitespace-pre-wrap flex-1 overflow-y-auto pr-2">
          {explanation}
        </p>
      )}
    </div>
  );
}

export function DashboardViewer({
  dashboard,
  hideExit,
  isAdmin,
}: {
  dashboard: DashboardPayload;
  /** Kiosk variant hides the Esc-to-exit hint and back navigation. */
  hideExit?: boolean;
  /** Gates the "Edit Layout" control on layout === "custom". Kiosk callers
   *  omit this (defaults false) — the kiosk surface is always passive. */
  isAdmin?: boolean;
}) {
  const { t, locale } = useT();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [editingLayout, setEditingLayout] = useState(false);
  const [pendingLayout, setPendingLayout] = useState<Record<string, SlotPos> | null>(null);
  const [savingLayout, setSavingLayout] = useState(false);
  const router = useRouter();
  const toast = useToast();
  // Debounce a flurry of bust events down to one router.refresh() call
  // every 2s. The lake page-fetch is cheap (SSR-rendered slots) but a
  // burst of 20 row-appends shouldn't cause 20 simultaneous refetches.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveStatus = useRealtimeEvents((event) => {
    // Only lake.bust prompts a re-render — other event kinds pass
    // through silently for now. Future: watcher.fired could trigger
    // an in-place toast on the dashboard.
    if (event.kind !== "lake.bust") return;
    if (refreshTimerRef.current) return; // already scheduled
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      router.refresh();
    }, 2000);
  });

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  // Non-interactive dashboards ("On Screen" wall-display duplicates) never
  // read or act on the `drill` URL param — computed up front so both the
  // breadcrumb parsing below and the fetch effect can gate on it, same
  // "no provider = no drill" fallback every block already uses for
  // PDF/share/embed surfaces.
  const interactive = dashboard.interactive !== false;

  // Drill-through — whole-slot re-scope, not the raw-rows side panel
  // Reports use. A block's `config.drillParam` names a report parameter;
  // clicking it sets that parameter (breadcrumb-tracked, per slot) and
  // re-runs that ONE slot's report via the same /api/reports/[id]/run the
  // manual filter bar already uses (FilterBar.tsx) — every block in that
  // report bound to the parameter re-scopes together (KPIs, other charts),
  // not just the clicked one. A block with no drillParam configured has no
  // drill interaction. This replaced the old raw-rows DrillPanel entirely
  // for Dashboards — Reports still use that.
  //
  // The breadcrumb map lives in the URL (`?drill=<json>`), not component
  // state — drilling in is a real navigation (router.push), so it opens as
  // its own address, survives a refresh, and the browser Back button walks
  // back up one level at a time, same as any other sub-page. Keyed by slot
  // id (JSON-encoded) rather than a single flat list because an interactive
  // dashboard shows every slot at once — more than one can be drilled into
  // at the same time.
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const drillMap = useMemo<DrillMap>(() => {
    if (!interactive) return {};
    const raw = searchParams.get("drill");
    if (!raw) return {};
    try {
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return {};
      const out: DrillMap = {};
      for (const [slotId, steps] of Object.entries(obj)) {
        if (!Array.isArray(steps)) continue;
        out[slotId] = steps
          .filter((s: any) => s && typeof s.param === "string")
          .map((s: any) => ({ param: s.param, value: s.value, label: String(s.value) }));
      }
      return out;
    } catch {
      return {};
    }
  }, [searchParams, interactive]);

  function drillUrl(map: DrillMap): string {
    const params = new URLSearchParams(searchParams.toString());
    const cleaned: DrillMap = {};
    for (const [slotId, steps] of Object.entries(map)) if (steps.length) cleaned[slotId] = steps;
    if (Object.keys(cleaned).length === 0) params.delete("drill");
    // URLSearchParams already percent-encodes the value on toString() —
    // encoding it again here would double-encode (ugly %2522-style URLs).
    else params.set("drill", JSON.stringify(cleaned));
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  const [drillLoading, setDrillLoading] = useState<Record<string, boolean>>({});
  const [slotOverrides, setSlotOverrides] = useState<Record<string, { dataset: any; provenance: any }>>({});
  // Monotonic per-slot request counter — guards against a slower, earlier
  // drill fetch landing after a faster, later one and clobbering it with
  // stale data (e.g. two quick clicks on the same chart).
  const drillReqRef = useRef<Record<string, number>>({});

  // Re-fetch a slot's dataset whenever its entry in the URL's drill map
  // changes (drill in, drill back via breadcrumb click, or browser Back).
  useEffect(() => {
    const activeIds = new Set(Object.keys(drillMap));
    setSlotOverrides((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const [id, v] of Object.entries(prev)) {
        if (activeIds.has(id)) next[id] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
    for (const [slotId, breadcrumb] of Object.entries(drillMap)) {
      if (!breadcrumb.length) continue;
      const reqId = (drillReqRef.current[slotId] ?? 0) + 1;
      drillReqRef.current[slotId] = reqId;
      setDrillLoading((p) => ({ ...p, [slotId]: true }));
      const qs = new URLSearchParams();
      for (const b of breadcrumb) qs.set(`p.${b.param}`, String(b.value));
      fetch(`/api/reports/${slotId}/run?${qs.toString()}`, { cache: "no-store" })
        .then((res) => res.json().then((json) => ({ ok: res.ok, json })))
        .then(({ ok, json }) => {
          if (drillReqRef.current[slotId] !== reqId || !ok) return;
          setSlotOverrides((p) => ({ ...p, [slotId]: { dataset: json.dataset, provenance: json.provenance } }));
        })
        .finally(() => {
          if (drillReqRef.current[slotId] === reqId) setDrillLoading((p) => ({ ...p, [slotId]: false }));
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drillMap]);

  function effectiveDataset(slot: Slot) {
    return slotOverrides[slot.id]?.dataset ?? slot.rendered?.dataset;
  }
  function effectiveProvenance(slot: Slot) {
    return slotOverrides[slot.id]?.provenance ?? slot.rendered?.provenance;
  }

  function findDrillParam(reportDef: any, blockId: string): string | null {
    for (const page of reportDef?.pages ?? []) {
      for (const block of page.blocks ?? []) {
        if (block.id !== blockId) continue;
        return (block.config as any)?.drillParam ?? null;
      }
    }
    return null;
  }

  function openDrill(slotId: string, reportDef: any, blockId: string, value: unknown) {
    const drillParam = findDrillParam(reportDef, blockId);
    if (!drillParam) return; // no drillParam configured on this block -> no interaction
    // An empty-string value means "clear this dimension" rather than "drill
    // into the empty string" — no real drill value is ever "", and every
    // report's own SQL already treats :param = '' as "no filter" (see the
    // WHERE (:x = '' OR ...) pattern used throughout), so this lines up with
    // that convention. Lets a block's own "reset" affordance (e.g. the map's
    // Home/zoom-out button) undo its OWN drill without needing a second,
    // separate channel back to this component beyond the existing onDrill.
    const isClear = value === "" || value == null;
    const step: DrillBreadcrumbStep | null = isClear ? null : { param: drillParam, value, label: String(value) };
    // Propagate to every slot on this dashboard whose own report declares a
    // parameter with the same name (including the clicked one), not just
    // the one clicked — a click is meant to feel like the whole page now
    // shows "everything about {value}", matching the page-level breadcrumb
    // segment below, which reflects one shared drilled chain, not a
    // per-chart filter nobody else on the page reacts to.
    //
    // Chains rather than replaces: re-clicking the SAME dimension (e.g. a
    // different region) replaces just that step, but drilling a NEW
    // dimension on top (region, then province within it, then district)
    // keeps the earlier steps — the geographic hierarchy this whole
    // workspace is built around. A slot whose report doesn't declare THIS
    // param at all is left completely alone (it has no column to filter
    // by), not reset to empty.
    const rank = geoDrillRank(drillParam);
    const next: DrillMap = { ...drillMap };
    for (const slot of dashboard.slots) {
      const params = (slot.rendered?.definition as any)?.parameters ?? [];
      const understandsThisParam = slot.id === slotId || params.some((p: any) => p?.name === drillParam);
      if (!understandsThisParam) continue;
      const current = next[slot.id] ?? [];
      // Drop the step being replaced, plus any geo level at or below the new
      // one — those were scoped to whatever the OLD value at this level was
      // and no longer necessarily apply (e.g. a newly-picked region
      // invalidates a province drilled under the previous region). Steps for
      // orthogonal dimensions (ministry, etc.) and shallower geo ancestors
      // are untouched.
      const kept = current.filter((s) => {
        if (s.param === drillParam) return false;
        if (GEO_DRILL_ORDER.includes(s.param) && GEO_DRILL_ORDER.includes(drillParam) && geoDrillRank(s.param) > rank) return false;
        return true;
      });
      // Always render/store in canonical hierarchy order, not click order —
      // Array#sort is stable, so orthogonal (non-geo) steps keep their
      // relative order among themselves.
      next[slot.id] = step ? [...kept, step].sort((a, b) => geoDrillRank(a.param) - geoDrillRank(b.param)) : kept;
    }
    router.push(drillUrl(next));
  }
  // The page-level breadcrumb tail below: one segment per drilled level
  // (region › province › district), not just the latest click — after
  // openDrill propagates, the LONGEST chain found across slots is the full
  // depth the page is currently scoped to (a slot only understanding
  // "region" still carries just that one step even after a deeper
  // "province" drill happened elsewhere, so longest wins).
  const pageDrillChain = Object.values(drillMap).reduce<DrillBreadcrumbStep[]>(
    (longest, b) => (b.length > longest.length ? b : longest), [],
  );
  // Stable primitive key (not the array itself, which is a fresh reference
  // every render) so the KPI re-fetch below only fires when the drilled
  // path actually changes.
  const pageDrillKey = pageDrillChain.map((s) => `p.${s.param}=${encodeURIComponent(String(s.value))}`).join("&");
  // The top-KPI strip (Total Allocated Budget, etc.) is pre-computed once,
  // unscoped, at page load — without this it stays frozen at whole-tenant
  // totals even after drilling re-scopes every report slot on the page,
  // which reads as the numbers being wrong rather than merely stale.
  const [kpiOverride, setKpiOverride] = useState<any[] | null>(null);
  useEffect(() => {
    if (!interactive || !pageDrillKey) { setKpiOverride(null); return; }
    let cancelled = false;
    fetch(`/api/dashboards/${dashboard.id}/kpis/run?${pageDrillKey}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((json) => { if (!cancelled && Array.isArray(json.topKpis)) setKpiOverride(json.topKpis); })
      .catch(() => { /* stale strip beats a broken one */ });
    return () => { cancelled = true; };
  }, [interactive, dashboard.id, pageDrillKey]);
  const effectiveTopKpis = kpiOverride ?? dashboard.topKpis;
  // href for a page-breadcrumb segment at a given chain depth — clicking it
  // jumps every slot back to that depth at once, same "whole page moves
  // together" contract as openDrill. Depth 0 clears every slot back to the
  // undrilled dashboard (AppShell breadcrumbs only take a plain href, not a
  // click handler, so this is computed rather than pushed on click).
  function pageDrillUrlAtDepth(depth: number): string {
    const keepParams = new Set(pageDrillChain.slice(0, depth).map((s) => s.param));
    const next: DrillMap = {};
    for (const [slotId, steps] of Object.entries(drillMap)) {
      const kept = steps.filter((s) => keepParams.has(s.param));
      if (kept.length) next[slotId] = kept;
    }
    return drillUrl(next);
  }
  function navigateDrill(slotId: string, depth: number) {
    const current = drillMap[slotId] ?? [];
    router.push(drillUrl({ ...drillMap, [slotId]: depth <= 0 ? [] : current.slice(0, depth) }));
  }
  function exitDrill(slotId: string) {
    router.push(drillUrl({ ...drillMap, [slotId]: [] }));
  }
  // No reportId (shouldn't happen for a rendered slot, but defensive) ->
  // null context, same as the "no provider" fallback every block already
  // handles for PDF/embed surfaces.
  function drillHandlerFor(slotId: string, reportDef: any): DrillThroughHandler | null {
    return (blockId, value) => openDrill(slotId, reportDef, blockId, value);
  }
  // `interactive` suppresses drill-through by never handing out a handler —
  // same "no provider = no drill" fallback every block already uses for
  // PDF/share/embed surfaces — and `print` is passed into every block/
  // ReportDocument to also hide "Why?", Comment/Ask/Embed, and
  // forecast-overlay controls.
  function drillProviderValue(slotId: string, reportDef: any) {
    return interactive ? drillHandlerFor(slotId, reportDef) : null;
  }

  const isGrid = dashboard.layout === "grid_2x2" || dashboard.layout === "grid_2x1";
  const maxSlots = dashboard.layout === "grid_2x2" ? 4 : (dashboard.layout === "grid_2x1" ? 2 : 1);
  const totalSlots = dashboard.slots.length;
  const total = isGrid ? Math.ceil(totalSlots / maxSlots) : totalSlots;
  const dark = dashboard.theme === "dark";
  const rotationMs = Math.max(1000, dashboard.rotationSeconds * 1000);

  // Auto-advance + keyboard shortcuts are a kiosk-only concept — an
  // interactive dashboard shows every slot at once (a scrollable "war room"
  // page, embedded in the normal app shell), so there is no single "active
  // slide" to rotate, pause, or step through. Via a single setTimeout per
  // slot — no requestAnimationFrame loop, no per-frame setState, no React
  // re-renders 60×/sec (the previous implementation kept the entire
  // DashboardViewer subtree re-rendering on every animation frame just to
  // update a progress-bar width, which read as constant flicker on slower
  // machines). The visible progress bar below uses a pure CSS @keyframes
  // animation keyed off `index`, so it restarts cleanly when the slot
  // changes and freezes via animation-play-state when paused — no JS state
  // involved.
  useEffect(() => {
    if (interactive || paused || total <= 1) return;
    const timer = setTimeout(() => {
      setIndex((i) => (i + 1) % total);
    }, rotationMs);
    return () => clearTimeout(timer);
  }, [interactive, index, paused, total, rotationMs]);

  useEffect(() => {
    if (interactive) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === " ") { e.preventDefault(); setPaused((p) => !p); }
      else if (e.key === "ArrowRight") setIndex((i) => (i + 1) % Math.max(1, total));
      else if (e.key === "ArrowLeft") setIndex((i) => (i - 1 + Math.max(1, total)) % Math.max(1, total));
      else if (e.key === "f" || e.key === "F") {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen?.();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [interactive, total]);

  // Wrapper class strategy: when dark, apply the `dark` Tailwind variant
  // class — that flips every CSS variable (--foreground, --background, --card,
  // …) defined in globals.css. Without this, ReportDocument children using
  // text-foreground render near-black on near-black. Combined with
  // bg-background, the report's own white card surfaces become dark too.
  const wrapperClass = "relative h-screen overflow-hidden bg-background text-foreground" +
    (dark ? " dark" : "");

  // Active slot's report name for the kiosk title overlay. Falls back to
  // the dashboard name when the slot has no rendered definition.
  const activeName = dashboard.slots[index]?.rendered?.definition?.name
    ?? dashboard.slots[index]?.name
    ?? dashboard.name;

  if (totalSlots === 0) {
    const empty = (
      <div className={"grid min-h-screen place-items-center bg-background text-foreground" + (dark ? " dark" : "")}>
        <div className="text-center">
          <p className="text-lg font-medium">{dashboard.name}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("dashboardViewer.noReportsYet")}</p>
        </div>
      </div>
    );
    return interactive && !hideExit
      ? <AppShell breadcrumbs={[{ label: t("nav.dashboards"), href: "/dashboards" }, { label: dashboard.name }]}>{empty}</AppShell>
      : empty;
  }

  // ===========================================================================
  // Interactive: a normal app page — AppShell chrome, scrollable, every slot
  // shown at once ("war room" density) instead of one auto-rotating slide.
  // ===========================================================================
  if (interactive) {
    function renderGridCell(slot: Slot, i: number, opts?: { heightPx?: number; showDragHandle?: boolean }) {
      let block = extractWidget(slot.rendered?.definition);
      let isAutoChart = false;
      let customData: any = null;

      if (!block && slot.rendered?.dataset) {
        const synthesized = synthesizeChart(slot.rendered.dataset as Record<string, unknown[]>);
        if (synthesized) {
          block = synthesized.block;
          customData = synthesized.newData;
          isAutoChart = true;
        }
      }

      const BlockComponent = block ? (BlockRegistry as any)[block.type]?.Component : null;
      const breadcrumb = drillMap[slot.id] ?? [];
      const bodyHeight = opts?.heightPx ?? 360;
      const showDragHandle = opts?.showDragHandle ?? false;

      return (
        <div key={slot.id + "_" + i} className="group relative flex h-full min-h-[420px] flex-col overflow-hidden rounded-2xl border bg-background shadow-sm ring-1 ring-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg dark:ring-white/5">
          {/* Accent bar — ties every card back to the dashboard's theme accent
              instead of a flat, undifferentiated border (per user feedback
              that the grid read as visually flat). */}
          <div className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: DASHBOARD_ACCENT }} />
          {showDragHandle && (
            <div
              title={t("dashboardViewer.dragToMove") ?? "Drag to move"}
              className="drag-handle absolute right-2 top-2 z-10 flex cursor-grab items-center gap-1 rounded-md bg-primary/90 px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground opacity-0 shadow-sm transition-opacity active:cursor-grabbing group-hover:opacity-100"
            >
              <GripVertical className="h-3 w-3" />
            </div>
          )}
          <div className="flex flex-none items-center justify-between border-b bg-muted/20 py-4 pl-7 pr-6 dark:bg-muted/10">
            <div className="flex flex-col">
              <span className="truncate pr-4 font-semibold text-foreground">{slot.name}</span>
              {breadcrumb.length > 0 ? (
                <span className="mt-0.5 flex items-center gap-1 text-xs text-primary">
                  {breadcrumb.map((b) => b.label).join(" › ")}
                  <button type="button" onClick={() => exitDrill(slot.id)} className="ml-1 underline hover:no-underline">
                    {t("drillHierarchy.exit")}
                  </button>
                </span>
              ) : (
                <>
                  {isAutoChart && (
                    <span className="mt-0.5 flex items-center gap-1 text-xs text-primary">
                      <Sparkles className="h-3 w-3" /> {t("dashboardViewer.autoGeneratedInsight")}
                    </span>
                  )}
                  {!isAutoChart && block?.type === "chart" && (
                    <span className="mt-0.5 text-xs text-muted-foreground">
                      {block.config?.xField && t("dashboardViewer.xAxisLabel").replace("{field}", block.config.xField)}
                      {block.config?.xField && block.config?.yFields?.length ? " • " : ""}
                      {block.config?.yFields?.length ? t("dashboardViewer.yAxisLabel").replace("{fields}", block.config.yFields.join(", ")) : ""}
                    </span>
                  )}
                </>
              )}
            </div>
            <LiveBadge status={liveStatus} />
          </div>

          {slot.rendered && block && BlockComponent ? (
            // A fixed pixel height (not h-full/flex-1 stretched to fit a
            // squeezed viewport) so ResponsiveContainer always gets a real,
            // non-collapsing size — a percentage-based ancestor chain here
            // is what previously let the chart canvas shrink to ~0px and
            // render nothing but its legend. In "custom" layout this is
            // driven by the grid item's own resized height instead of the
            // fixed 360px default.
            <div className="flex-1 overflow-hidden p-5" style={{ height: bodyHeight }} data-block-id={block.id}>
              <DrillThroughContext.Provider value={drillProviderValue(slot.id, slot.rendered?.definition)}>
                <BlockComponent
                  block={block}
                  report={slot.rendered.definition}
                  dataset={customData ? { [(block.config as any).queryId]: customData } : (effectiveDataset(slot) as any)}
                  provenance={effectiveProvenance(slot)}
                  print={false}
                  params={{}}
                  reportDbId={slot.id}
                  bare
                />
              </DrillThroughContext.Provider>
            </div>
          ) : slot.rendered && !block ? (
            <div className="flex-1 overflow-y-auto p-5" style={{ height: bodyHeight }}>
              <AiExplanationWidget reportName={slot.name} dataset={slot.rendered.dataset} />
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center p-5" style={{ height: bodyHeight }}>
              <span className="text-sm italic text-muted-foreground">{t("dashboardViewer.noDefinitionOrDataset")}</span>
            </div>
          )}
        </div>
      );
    }

    function renderSlotSection(slot: Slot, i: number) {
      if (!slot.rendered) {
        return (
          <div key={slot.id + "_" + i} className="grid min-h-[240px] place-items-center">
            <div className="max-w-md rounded-2xl border border-dashed border-border/60 bg-muted/30 p-12 text-center">
              <p className="text-base font-medium text-foreground">{slot.name}</p>
              <p className="mt-2 text-sm text-muted-foreground">{slot.error ?? t("dashboardViewer.reportRenderError")}</p>
            </div>
          </div>
        );
      }

      let templateContent: React.ReactNode = null;
      if (dashboard.layout === "table_only") {
        const tableBlock = extractTable(slot.rendered.definition);
        const BlockComponent = tableBlock ? (BlockRegistry as any)[tableBlock.type]?.Component : null;
        templateContent = tableBlock && BlockComponent ? (
          <div className="rounded-xl border bg-card p-4 shadow-sm" data-block-id={tableBlock.id}>
            <DrillThroughContext.Provider value={drillProviderValue(slot.id, slot.rendered?.definition)}>
              <BlockComponent
                block={tableBlock} report={slot.rendered.definition}
                dataset={effectiveDataset(slot) as any} provenance={effectiveProvenance(slot) as any}
                print={false} params={{}} reportDbId={slot.id}
              />
            </DrillThroughContext.Provider>
          </div>
        ) : (
          <div className="grid min-h-[200px] place-items-center"><p className="text-muted-foreground">{t("dashboardViewer.noTableFound")}</p></div>
        );
      } else if (dashboard.layout === "table_chart") {
        // Drilled-in data (effectiveDataset/effectiveProvenance), not the
        // frozen slot.rendered snapshot from initial page load — this
        // layout used the static snapshot unconditionally until it was
        // found that drilling into a chart on this template silently kept
        // showing pre-drill data forever, unlike the default template.
        const liveDataset = effectiveDataset(slot);
        const liveProvenance = effectiveProvenance(slot);
        const chartBlock = extractWidget(slot.rendered.definition);
        const tableBlock = extractTable(slot.rendered.definition);
        let customData = null;
        let finalChartBlock = chartBlock;
        if (!chartBlock && liveDataset) {
          const synthesized = synthesizeChart(liveDataset as any);
          if (synthesized) { finalChartBlock = synthesized.block; customData = synthesized.newData; }
        }
        const ChartComponent = finalChartBlock ? (BlockRegistry as any)[finalChartBlock.type]?.Component : null;
        const TableComponent = tableBlock ? (BlockRegistry as any)[tableBlock.type]?.Component : null;
        templateContent = finalChartBlock && tableBlock && ChartComponent && TableComponent ? (
          <div className="flex flex-col gap-4 md:flex-row">
            <div className="h-[420px] w-full flex-shrink-0 rounded-xl border bg-card p-4 shadow-sm md:w-[42%]" data-block-id={finalChartBlock.id}>
              <DrillThroughContext.Provider value={drillProviderValue(slot.id, slot.rendered?.definition)}>
                <ChartComponent
                  block={finalChartBlock} report={slot.rendered.definition}
                  dataset={customData ? { [(finalChartBlock.config as any).queryId]: customData } : liveDataset}
                  provenance={liveProvenance} print={false} params={{}} reportDbId={slot.id}
                  bare
                />
              </DrillThroughContext.Provider>
            </div>
            <div className="h-[420px] flex-1 overflow-y-auto rounded-xl border bg-card p-4 shadow-sm" data-block-id={tableBlock.id}>
              <DrillThroughContext.Provider value={drillProviderValue(slot.id, slot.rendered?.definition)}>
                <TableComponent
                  block={tableBlock} report={slot.rendered.definition}
                  dataset={liveDataset as any} provenance={liveProvenance as any}
                  print={false} params={{}} reportDbId={slot.id}
                />
              </DrillThroughContext.Provider>
            </div>
          </div>
        ) : (
          <div className="grid min-h-[200px] place-items-center"><p className="text-muted-foreground">{t("dashboardViewer.chartAndTableRequired")}</p></div>
        );
      } else if (dashboard.layout === "chart_only") {
        // Same fix as table_chart above: read the drilled dataset, not the
        // frozen initial snapshot.
        const liveDataset = effectiveDataset(slot);
        const liveProvenance = effectiveProvenance(slot);
        const chartBlock = extractWidget(slot.rendered.definition);
        let customData = null;
        let finalChartBlock = chartBlock ? JSON.parse(JSON.stringify(chartBlock)) : null;
        if (!finalChartBlock && liveDataset) {
          const synthesized = synthesizeChart(liveDataset as any);
          if (synthesized) { finalChartBlock = synthesized.block; customData = synthesized.newData; }
        }
        if (finalChartBlock?.config) finalChartBlock.config.showAiCaption = false;
        const ChartComponent = finalChartBlock ? (BlockRegistry as any)[finalChartBlock.type]?.Component : null;
        const xDesc = finalChartBlock?.config?.xField ? t("dashboardViewer.xAxisLabel").replace("{field}", finalChartBlock.config.xField) : "";
        const yDesc = finalChartBlock?.config?.yFields?.length ? t("dashboardViewer.yAxisLabel").replace("{fields}", finalChartBlock.config.yFields.join(", ")) : "";
        templateContent = finalChartBlock && ChartComponent ? (
          <div className="flex h-[480px] flex-col gap-4 rounded-xl border bg-card p-8 shadow-sm" data-block-id={finalChartBlock.id}>
            <div className="min-h-0 flex-1">
              <DrillThroughContext.Provider value={drillProviderValue(slot.id, slot.rendered?.definition)}>
                <ChartComponent block={finalChartBlock} report={slot.rendered.definition}
                  dataset={customData ? { [finalChartBlock.config.queryId]: customData } : liveDataset}
                  provenance={liveProvenance} print={false} params={{}} reportDbId={slot.id} bare />
              </DrillThroughContext.Provider>
            </div>
            {(xDesc || yDesc) && (
              <div className="flex items-center justify-center gap-6 border-t pt-4 text-sm text-muted-foreground">
                {xDesc && <span className="rounded-full bg-muted px-3 py-1">{xDesc}</span>}
                {yDesc && <span className="rounded-full bg-muted px-3 py-1">{yDesc}</span>}
              </div>
            )}
          </div>
        ) : (
          <div className="grid min-h-[240px] place-items-center"><p className="text-muted-foreground">{t("dashboardViewer.noChartFound")}</p></div>
        );
      } else {
        // Default: the full report, dense-grid-of-blocks (its own x/y/w/h
        // layout, not stacked full-width) via ReportDocument, with a
        // breadcrumb bar when this slot has an active drill.
        const slotDef = stripTables(slot.rendered.definition);
        const breadcrumb = drillMap[slot.id] ?? [];
        templateContent = (
          <>
            <DrillBreadcrumbBar
              rootLabel={slot.name}
              breadcrumb={breadcrumb}
              loading={!!drillLoading[slot.id]}
              onNavigate={(depth) => navigateDrill(slot.id, depth)}
              onReset={() => exitDrill(slot.id)}
            />
            <DrillThroughContext.Provider value={drillProviderValue(slot.id, slot.rendered?.definition)}>
              <ReportDocument report={slotDef}
                dataset={effectiveDataset(slot) as Record<string, Record<string, unknown>[]>}
                params={slot.rendered.params} provenance={effectiveProvenance(slot) as any}
                print={false}
                reportDbId={slot.id}
                locale={locale}
                tenantCurrency={dashboard.currency} />
            </DrillThroughContext.Provider>
          </>
        );
      }

      return (
        <section key={slot.id + "_" + i} className="overflow-hidden rounded-2xl border bg-background shadow-sm">
          <div className="flex items-center justify-between border-b bg-muted/20 px-6 py-3 dark:bg-muted/10">
            <span className="font-semibold text-foreground">{slot.name}</span>
            <LiveBadge status={liveStatus} />
          </div>
          <div className="p-6">{templateContent}</div>
        </section>
      );
    }

    const isCustom = dashboard.layout === "custom";

    async function saveLayout() {
      if (!pendingLayout) { setEditingLayout(false); return; }
      setSavingLayout(true);
      try {
        const r = await fetch(`/api/dashboards/${dashboard.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slotLayout: pendingLayout }),
        });
        if (!r.ok) throw new Error(await r.text());
        toast.push({ variant: "success", title: t("dashboardViewer.layoutSaved") });
        setEditingLayout(false);
        setPendingLayout(null);
        router.refresh();
      } catch {
        toast.push({ variant: "destructive", title: t("dashboardViewer.layoutSaveFailed") });
      } finally {
        setSavingLayout(false);
      }
    }

    function cancelLayoutEdit() {
      setEditingLayout(false);
      setPendingLayout(null);
    }

    // Computed once and reused for both the grid's `layout` prop and each
    // cell's body height below — used to duplicate this same fallback chain
    // in both places, which let them drift out of sync on edit.
    const slotPositions: Record<string, SlotPos> = {};
    dashboard.slots.forEach((s, i) => {
      slotPositions[s.id] = pendingLayout?.[s.id] ?? dashboard.slotLayout?.[s.id] ?? defaultSlotPos(i);
    });
    // A card resized below this many rows has no room left for its header
    // and BlockActions toolbar once the fixed 88px chrome offset is
    // subtracted (see CUSTOM_CELL_CHROME_PX below) — clamp the drag/resize
    // handle itself so a user can't create an unusably short card.
    const CUSTOM_MIN_ROWS = 4;
    const customGridLayout: Layout[] = dashboard.slots.map((s) => {
      const pos = slotPositions[s.id];
      return { i: s.id, x: pos.x, y: pos.y, w: pos.w, h: pos.h, minH: CUSTOM_MIN_ROWS };
    });

    const body = (
      <div className={"min-h-full bg-background text-foreground" + (dark ? " dark" : "")}>
        <TopKpiBar topKpis={effectiveTopKpis as any} currency={dashboard.currency} />
        <div className="space-y-6 p-6">
          {isCustom ? (
            <ResponsiveGridLayout
              className="layout"
              layout={customGridLayout}
              cols={CUSTOM_GRID_COLS}
              rowHeight={CUSTOM_GRID_ROW_HEIGHT}
              margin={[16, 16]}
              isDraggable={editingLayout}
              isResizable={editingLayout}
              draggableHandle=".drag-handle"
              onLayoutChange={(next) => {
                if (!editingLayout) return;
                const map: Record<string, SlotPos> = {};
                for (const item of next) map[item.i] = { x: item.x, y: item.y, w: item.w, h: item.h };
                setPendingLayout(map);
              }}
            >
              {dashboard.slots.map((slot, i) => {
                const pos = slotPositions[slot.id];
                const heightPx = Math.max(CUSTOM_CELL_MIN_BODY_PX, pos.h * CUSTOM_GRID_ROW_HEIGHT - CUSTOM_CELL_CHROME_PX);
                return (
                  <div key={slot.id}>
                    {renderGridCell(slot, i, { heightPx, showDragHandle: editingLayout })}
                  </div>
                );
              })}
            </ResponsiveGridLayout>
          ) : isGrid
            ? Array.from({ length: total }).map((_, p) => {
                const gridSlots = dashboard.slots.slice(p * maxSlots, p * maxSlots + maxSlots);
                const gridCols = "grid-cols-1 md:grid-cols-2";
                return (
                  <div key={p} className={`grid ${gridCols} gap-6`}>
                    {gridSlots.map((slot, i) => renderGridCell(slot, i))}
                  </div>
                );
              })
            : dashboard.slots.map((slot, i) => renderSlotSection(slot, i))}
        </div>
      </div>
    );

    const layoutActions = isCustom && isAdmin ? (
      editingLayout ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={cancelLayoutEdit}
            disabled={savingLayout}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
          >
            <CloseIcon className="h-3.5 w-3.5" /> {t("dashboardViewer.cancelLayout")}
          </button>
          <button
            type="button"
            onClick={saveLayout}
            disabled={savingLayout}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" /> {t("dashboardViewer.saveLayout")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditingLayout(true)}
          className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent"
        >
          <Pencil className="h-3.5 w-3.5" /> {t("dashboardViewer.editLayout")}
        </button>
      )
    ) : null;

    // hideExit is true only for the unauthenticated kiosk-token route
    // (/dashboards/[slug]/kiosk — its own token IS the auth gate, no
    // session). The authenticated page (/dashboards/[slug]/page.tsx,
    // hideExit unset) is the real day-to-day interactive view this
    // provider targets; the kiosk arm stays untouched deliberately — an
    // unattended wall display shouldn't show a "raise a request" button,
    // and /api/operate/templates already requires a session regardless.
    // No appId: a Dashboard isn't tied to an Analytic App.
    return hideExit ? body : (
      <OperateActionsProvider>
        <AppShell
          breadcrumbs={[
            { label: t("nav.dashboards"), href: "/dashboards" },
            { label: dashboard.name, ...(pageDrillChain.length ? { href: pageDrillUrlAtDepth(0) } : {}) },
            // One segment per drilled level (region › province › district) —
            // every one but the last is a link back to that depth; the last is
            // the current page, no href, matching how the two static segments
            // above already work.
            ...pageDrillChain.map((step, i) => ({
              label: step.label,
              ...(i < pageDrillChain.length - 1 ? { href: pageDrillUrlAtDepth(i + 1) } : {}),
            })),
          ]}
          actions={layoutActions}
        >
          {body}
        </AppShell>
      </OperateActionsProvider>
    );
  }

  // ===========================================================================
  // Non-interactive ("On Screen"): the original full-screen, auto-rotating
  // kiosk — unchanged behavior, built for an unattended TV/monitor.
  // ===========================================================================
  const controlsPill = (
    <div className="fixed bottom-4 right-4 z-30 flex items-center gap-1 rounded-full border bg-background/80 px-2 py-1 text-xs shadow-lg backdrop-blur-md">
      {total > 1 && <span className="px-2 font-mono text-muted-foreground">{index + 1}/{total}</span>}
      {total > 1 && (
        <>
          <button
            type="button"
            onClick={() => setIndex((i) => (i - 1 + total) % total)}
            className="rounded-full p-1.5 transition-colors hover:bg-foreground/10"
            title={t("dashboardViewer.previousTooltip")}
          ><ChevronLeft className="h-4 w-4" /></button>
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className="rounded-full p-1.5 transition-colors hover:bg-foreground/10"
            title={paused ? t("dashboardViewer.resumeTooltip") : t("dashboardViewer.pauseTooltip")}
          >{paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}</button>
          <button
            type="button"
            onClick={() => setIndex((i) => (i + 1) % total)}
            className="rounded-full p-1.5 transition-colors hover:bg-foreground/10"
            title={t("dashboardViewer.nextTooltip")}
          ><ChevronRight className="h-4 w-4" /></button>
        </>
      )}
      <button
        type="button"
        onClick={() => {
          if (document.fullscreenElement) document.exitFullscreen();
          else document.documentElement.requestFullscreen?.();
        }}
        className="rounded-full p-1.5 transition-colors hover:bg-foreground/10"
        title={t("dashboardViewer.fullscreenTooltip")}
      ><Maximize2 className="h-4 w-4" /></button>
      {!hideExit && (
        <a
          href="/dashboards"
          className="rounded-full p-1.5 transition-colors hover:bg-foreground/10"
          title={t("dashboardViewer.exitTooltip")}
        ><CloseIcon className="h-4 w-4" /></a>
      )}
    </div>
  );

  if (isGrid) {
    const gridCols = "grid-cols-2";
    const gridRows = dashboard.layout === "grid_2x2" ? "grid-rows-2" : "grid-rows-1";
    const startIndex = index * maxSlots;
    const gridSlots = dashboard.slots.slice(startIndex, startIndex + maxSlots);

    return (
      <div className={wrapperClass}>
        {controlsPill}
        <div className="flex flex-col w-screen h-screen relative">
          {total > 1 && (
            <div className="absolute inset-x-0 top-0 z-50 h-[3px]">
              <div
                key={"prog_" + index}
                className="h-full bg-primary"
                style={{
                  animation: `curfDashProgress ${rotationMs}ms linear forwards`,
                  animationPlayState: paused ? "paused" : "running",
                  boxShadow: "0 0 12px hsl(var(--primary) / 0.55)",
                  willChange: "width",
                }}
              />
            </div>
          )}
          <TopKpiBar topKpis={dashboard.topKpis as any} currency={dashboard.currency} />
          <div className={`grid flex-1 overflow-hidden ${gridCols} ${gridRows} bg-gradient-to-br from-muted to-muted/50   gap-6 p-6`}>
            {gridSlots.map((slot, i) => {
              let block = extractWidget(slot.rendered?.definition);
              let isAutoChart = false;
              let customData: any = null;

              // If no explicit visual widget, try to synthesize one
              if (!block && slot.rendered?.dataset) {
                const synthesized = synthesizeChart(slot.rendered.dataset as Record<string, unknown[]>);
                if (synthesized) {
                  block = synthesized.block;
                  customData = synthesized.newData;
                  isAutoChart = true;
                }
              }

              const BlockComponent = block ? (BlockRegistry as any)[block.type]?.Component : null;

              return (
                <div key={slot.id + "_" + i} className="relative bg-background flex flex-col rounded-2xl border shadow-sm hover:shadow-md transition-shadow duration-300 overflow-hidden ring-1 ring-black/5 dark:ring-white/5">
                  <div className="flex-none px-6 py-4 flex items-center justify-between border-b bg-muted/20 dark:bg-muted/10 backdrop-blur-sm">
                    <div className="flex flex-col">
                      <span className="font-semibold text-foreground truncate pr-4">{slot.name}</span>
                      {isAutoChart && (
                        <span className="text-xs text-primary mt-0.5 flex items-center gap-1">
                          <Sparkles className="w-3 h-3" /> {t("dashboardViewer.autoGeneratedInsight")}
                        </span>
                      )}
                      {!isAutoChart && block?.type === "chart" && (
                        <span className="text-xs text-muted-foreground mt-0.5">
                          {block.config?.xField && t("dashboardViewer.xAxisLabel").replace("{field}", block.config.xField)}
                          {block.config?.xField && block.config?.yFields?.length ? " • " : ""}
                          {block.config?.yFields?.length ? t("dashboardViewer.yAxisLabel").replace("{fields}", block.config.yFields.join(", ")) : ""}
                        </span>
                      )}
                    </div>
                    <LiveBadge status={liveStatus} />
                  </div>

                  {/* Grid Slot Content */}
                  {slot.rendered && block && BlockComponent ? (
                    <div className="flex-1 relative overflow-hidden flex flex-col">
                      <div className="flex-1 relative p-5">
                        <div className="w-full h-full" data-block-id={block.id}>
                          <DrillThroughContext.Provider value={drillProviderValue(slot.id, slot.rendered?.definition)}>
                            <BlockComponent
                              block={block}
                              report={slot.rendered.definition}
                              dataset={customData ? { [(block.config as any).queryId]: customData } : slot.rendered.dataset}
                              provenance={slot.rendered.provenance}
                              print={!interactive}
                              params={{}}
                              reportDbId={slot.id}
                            />
                          </DrillThroughContext.Provider>
                        </div>
                      </div>
                    </div>
                  ) : slot.rendered && !block ? (
                    <div className="flex-1 p-5 relative overflow-y-auto">
                      <AiExplanationWidget reportName={slot.name} dataset={slot.rendered.dataset} />
                    </div>
                  ) : (
                    <div className="flex-1 p-5 flex items-center justify-center">
                      <span className="text-sm text-muted-foreground italic">{t("dashboardViewer.noDefinitionOrDataset")}</span>
                    </div>
                  )}
                </div>
              );
            })}
            {/* Fill empty cells if slots < maxSlots */}
            {Array.from({ length: Math.max(0, maxSlots - gridSlots.length) }).map((_, i) => (
              <div key={"empty_" + i} className="rounded-xl border border-dashed bg-muted/10" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    // C1: a dashboard can now open an Operate request from a block, not just
    // from a report's drill panel. Renders nothing for a tenant with no
    // chart_click templates, so this costs non-Operate tenants nothing.
    <OperateActionsProvider>
    <div className={wrapperClass}>
      {controlsPill}

      <div className="flex flex-col w-screen h-screen overflow-hidden">
        <TopKpiBar topKpis={dashboard.topKpis as any} currency={dashboard.currency} />

        <div className="relative flex-1 overflow-hidden">
          {/* Progress bar driven by a pure CSS keyframe — no JS state, no
              React re-renders. Animation key is `index` so the bar restarts
              cleanly on every slot change; play-state pauses in place when the
              user hits ⏸. The keyframes are injected once via the <style> block
              below the controls. */}
          <div className="absolute inset-x-0 top-0 z-30 h-[3px]">
            <div
              key={"prog_" + index}
              className="h-full bg-primary"
              style={{
                animation: total > 1
                  ? `curfDashProgress ${rotationMs}ms linear forwards`
                  : undefined,
                animationPlayState: paused ? "paused" : "running",
                boxShadow: "0 0 12px hsl(var(--primary) / 0.55)",
                willChange: "width",
              }}
            />
          </div>

          {/* Top-center floating overlay: dashboard name (small, muted) +
              active report name (larger, prominent). Fades + slides in when
              the slot changes so the wall reader can see what they're looking
              at without staring at a tiny corner counter. */}
          <div className="pointer-events-none absolute left-1/2 top-5 z-30 -translate-x-1/2 px-6">
            <div
              key={"hdr_" + index}
              className="rounded-full border bg-background/70 px-5 py-2 text-center shadow-lg backdrop-blur-md animate-in fade-in slide-in-from-top-2 duration-500"
            >
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {dashboard.name}
              </p>
              <p className="mt-0.5 flex items-center justify-center gap-2 text-sm font-semibold text-foreground">
                {activeName}
                <LiveBadge status={liveStatus} />
              </p>
            </div>
          </div>

          {/* Stacked report slots. Carousel/chart layouts use absolute
              positioning so cross-fade works. Table layouts use normal
              flow so the page can scroll vertically. */}
          {(dashboard.layout === "table_chart" || dashboard.layout === "table_only") ? (
            // Fixed-height layout — template content uses absolute inset-0
            <div className="relative h-full">
              {dashboard.slots.map((slot, i) => {
                const active = i === index;
                if (!active) return null;

                let templateContent = null;
                if (slot.rendered) {
                if (dashboard.layout === "table_only") {
                  const tableBlock = extractTable(slot.rendered.definition);
                  const BlockComponent = tableBlock ? (BlockRegistry as any)[tableBlock.type]?.Component : null;
                  templateContent = tableBlock && BlockComponent ? (
                    <div className="absolute inset-0 flex flex-col">
                      <div className="h-[88px] flex-shrink-0" />
                      <div className="flex-1 px-8 pb-6 overflow-hidden">
                        <div className="h-full bg-card rounded-xl border shadow-sm p-4 overflow-y-auto" data-block-id={tableBlock.id}>
                          <DrillThroughContext.Provider value={drillProviderValue(slot.id, slot.rendered?.definition)}>
                            <BlockComponent
                              block={tableBlock}
                              report={slot.rendered.definition}
                              dataset={slot.rendered.dataset}
                              provenance={slot.rendered.provenance}
                              print={!interactive}
                              params={{}}
                              reportDbId={slot.id}
                            />
                          </DrillThroughContext.Provider>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="grid h-full place-items-center"><p className="text-muted-foreground">{t("dashboardViewer.noTableFound")}</p></div>
                  );
                } else if (dashboard.layout === "table_chart") {
                  const chartBlock = extractWidget(slot.rendered.definition);
                  const tableBlock = extractTable(slot.rendered.definition);

                  let customData = null;
                  let finalChartBlock = chartBlock;
                  if (!chartBlock && slot.rendered.dataset) {
                    const synthesized = synthesizeChart(slot.rendered.dataset as any);
                    if (synthesized) {
                      finalChartBlock = synthesized.block;
                      customData = synthesized.newData;
                    }
                  }

                  const ChartComponent = finalChartBlock ? (BlockRegistry as any)[finalChartBlock.type]?.Component : null;
                  const TableComponent = tableBlock ? (BlockRegistry as any)[tableBlock.type]?.Component : null;

                  templateContent = finalChartBlock && tableBlock && ChartComponent && TableComponent ? (
                    <div className="absolute inset-0 flex flex-col">
                      {/* spacer for progress bar + title overlay */}
                      <div className="h-[88px] flex-shrink-0" />
                      <div className="flex flex-1 gap-4 px-6 pb-6 overflow-hidden">
                        {/* Chart panel — fills remaining height, recharts gets real pixel dimensions */}
                        <div
                          className="w-[42%] flex-shrink-0 bg-card rounded-xl border shadow-sm p-4 flex flex-col overflow-hidden"
                          data-block-id={finalChartBlock.id}
                        >
                          <div style={{ flex: 1, minHeight: 0 }}>
                            <DrillThroughContext.Provider value={drillProviderValue(slot.id, slot.rendered?.definition)}>
                              <ChartComponent
                                block={finalChartBlock}
                                report={slot.rendered.definition}
                                dataset={customData ? { [(finalChartBlock.config as any).queryId]: customData } : slot.rendered.dataset}
                                provenance={slot.rendered.provenance}
                                print={!interactive}
                                params={{}}
                                reportDbId={slot.id}
                              />
                            </DrillThroughContext.Provider>
                          </div>
                        </div>
                        {/* Table panel — scrollable internally */}
                        <div
                          className="flex-1 bg-card rounded-xl border shadow-sm p-4 overflow-y-auto"
                          data-block-id={tableBlock.id}
                        >
                          <DrillThroughContext.Provider value={drillProviderValue(slot.id, slot.rendered?.definition)}>
                            <TableComponent
                              block={tableBlock}
                              report={slot.rendered.definition}
                              dataset={slot.rendered.dataset}
                              provenance={slot.rendered.provenance}
                              print={!interactive}
                              params={{}}
                              reportDbId={slot.id}
                            />
                          </DrillThroughContext.Provider>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="grid h-full place-items-center"><p className="text-muted-foreground">{t("dashboardViewer.chartAndTableRequired")}</p></div>
                  );
                }
              }


                return (
                  <div key={slot.id + "_" + i}>
                    {slot.rendered ? templateContent : (
                      <div className="grid min-h-[80vh] place-items-center">
                        <div className="max-w-md rounded-2xl border border-dashed border-border/60 bg-muted/30 p-12 text-center">
                          <p className="text-base font-medium text-foreground">{slot.name}</p>
                          <p className="mt-2 text-sm text-muted-foreground">
                            {slot.error ?? t("dashboardViewer.reportRenderError")}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            // Carousel / Chart-only: stacked absolute slots with cross-fade
            <div className="absolute inset-0">
              {dashboard.slots.map((slot, i) => {
                const active = i === index;
                let templateContent = null;
                if (slot.rendered) {
                  if (dashboard.layout === "chart_only") {
                    const chartBlock = extractWidget(slot.rendered.definition);
                    let customData = null;
                    let finalChartBlock = chartBlock ? JSON.parse(JSON.stringify(chartBlock)) : null;
                    if (!finalChartBlock && slot.rendered.dataset) {
                      const synthesized = synthesizeChart(slot.rendered.dataset as any);
                      if (synthesized) { finalChartBlock = synthesized.block; customData = synthesized.newData; }
                    }
                    if (finalChartBlock?.config) finalChartBlock.config.showAiCaption = false;
                    const ChartComponent = finalChartBlock ? (BlockRegistry as any)[finalChartBlock.type]?.Component : null;
                    const xDesc = finalChartBlock?.config?.xField ? t("dashboardViewer.xAxisLabel").replace("{field}", finalChartBlock.config.xField) : "";
                    const yDesc = finalChartBlock?.config?.yFields?.length ? t("dashboardViewer.yAxisLabel").replace("{fields}", finalChartBlock.config.yFields.join(', ')) : "";
                    templateContent = finalChartBlock && ChartComponent ? (
                      <main className="mx-auto max-w-5xl px-8 pb-12 pt-24 h-full flex flex-col">
                        <div className="flex-1 bg-card rounded-xl border shadow-sm p-8 overflow-hidden flex flex-col gap-4" data-block-id={finalChartBlock.id}>
                          <div className="flex-1 min-h-0">
                            <DrillThroughContext.Provider value={drillProviderValue(slot.id, slot.rendered?.definition)}>
                              <ChartComponent block={finalChartBlock} report={slot.rendered.definition}
                                dataset={customData ? { [finalChartBlock.config.queryId]: customData } : slot.rendered.dataset}
                                provenance={slot.rendered.provenance} print={!interactive} params={{}} reportDbId={slot.id} />
                            </DrillThroughContext.Provider>
                          </div>
                          {(xDesc || yDesc) && (
                            <div className="mt-4 pt-4 border-t flex items-center justify-center gap-6 text-sm text-muted-foreground">
                              {xDesc && <span className="bg-muted px-3 py-1 rounded-full">{xDesc}</span>}
                              {yDesc && <span className="bg-muted px-3 py-1 rounded-full">{yDesc}</span>}
                            </div>
                          )}
                        </div>
                      </main>
                    ) : (
                      <div className="grid min-h-[80vh] place-items-center"><p className="text-muted-foreground">{t("dashboardViewer.noChartFound")}</p></div>
                    );
                  } else {
                    // "On Screen" wall displays keep tables (and get no
                    // breadcrumb bar / drill interaction at all).
                    templateContent = (
                      <main className="mx-auto max-w-7xl px-8 pb-12 pt-24">
                        <DrillThroughContext.Provider value={drillProviderValue(slot.id, slot.rendered?.definition)}>
                          <ReportDocument report={slot.rendered.definition}
                            dataset={slot.rendered.dataset as Record<string, Record<string, unknown>[]>}
                            params={slot.rendered.params} provenance={slot.rendered.provenance as any}
                            print={!interactive}
                            reportDbId={slot.id}
                            locale={locale}
                            tenantCurrency={dashboard.currency} />
                        </DrillThroughContext.Provider>
                      </main>
                    );
                  }
                }
                return (
                  <div key={slot.id + "_" + i} style={{ willChange: "opacity" }}
                    className={"transition-opacity duration-300 ease-out " +
                      (active ? "opacity-100" : "pointer-events-none absolute inset-0 opacity-0")}
                    aria-hidden={!active}>
                    {slot.rendered ? templateContent : (
                      <div className="grid min-h-[80vh] place-items-center">
                        <div className="max-w-md rounded-2xl border border-dashed border-border/60 bg-muted/30 p-12 text-center">
                          <p className="text-base font-medium text-foreground">{slot.name}</p>
                          <p className="mt-2 text-sm text-muted-foreground">{slot.error ?? t("dashboardViewer.reportRenderError")}</p>
                          <p className="mt-4 text-xs italic text-muted-foreground">{t("dashboardViewer.skippingShortly")}</p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Slot-position dots */}
          <div className="pointer-events-none fixed bottom-5 left-1/2 z-30 -translate-x-1/2">
            <div className="flex items-center gap-1.5 rounded-full bg-background/60 px-3 py-1.5 backdrop-blur-md">
              {dashboard.slots.map((_, i) => (
                <span key={i} className={"h-1.5 rounded-full transition-all duration-300 " +
                  (i === index ? "w-6 bg-primary" : "w-1.5 bg-foreground/30")} />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Pause indicator */}
      <div className={"pointer-events-none fixed inset-0 z-20 grid place-items-center transition-opacity duration-300 " +
        (paused ? "opacity-100" : "opacity-0")}>
        <div className="flex items-center gap-2 rounded-full border bg-background/80 px-5 py-2.5 text-sm font-medium shadow-xl backdrop-blur-md">
          <Pause className="h-4 w-4" /> {t("dashboardViewer.paused")}
        </div>
      </div>

      {/* Single global stylesheet injection: the @keyframes the progress
          bar refers to. Inline so the component is self-contained and the
          rule lives next to its only consumer. */}
      <style>{`
        @keyframes curfDashProgress {
          from { width: 0%; }
          to   { width: 100%; }
        }
      `}</style>
    </div>
    </OperateActionsProvider>
  );
}

function getIconForKpi(label: string) {
  const l = label.toLowerCase();
  if (l.includes("view") || l.includes("visit") || l.includes("impression")) return Eye;
  if (l.includes("sale") || l.includes("order") || l.includes("purchase")) return ShoppingCart;
  if (l.includes("comment") || l.includes("message") || l.includes("feedback")) return MessageCircle;
  if (l.includes("earning") || l.includes("profit") || l.includes("money") || l.includes("income") || l.includes("revenue")) return Banknote;
  if (l.includes("user") || l.includes("student") || l.includes("customer")) return Users;
  return TrendingUp; // Default
}

/**
 * A KPI's `format: "percent"` value is contractually a 0..1 fraction (see
 * recommend-kpis/route.ts's prompt: "the query MUST return a decimal
 * fraction... Do NOT multiply by 100"). That's a prompt instruction, not an
 * enforcement mechanism — an LLM-authored SQL query can and does ignore it
 * (e.g. `(disbursed/budget)*100` instead of the plain ratio), which silently
 * doubles the display scale (a real 66.7% renders as 6670.0%). No legitimate
 * KPI card value is in the thousands-of-percent range, so treat anything
 * that would render above 500% as already-scaled and skip the ×100 — a
 * code-level guard behind the prompt, not a replacement for fixing the
 * offending query.
 */
function formatKpiPercent(value: number): string {
  const asFraction = value * 100;
  return `${(Math.abs(asFraction) > 500 ? value : asFraction).toFixed(1)}%`;
}

// A "number"-format KPI is usually a count (students, budget line items,
// teachers) where compacting to 2.6K genuinely helps a headline number fit
// its card — that's why the branch below defaults to formatValue's
// compaction. But a KPI whose label reads as a year/code/id (e.g. "Latest
// Fiscal Year", "ปีการศึกษาล่าสุด") isn't a magnitude at all — compacting
// 2568 to "3K" doesn't save meaningful space and just reads as wrong.
// isIdentifierLabel is the same check KpiBlock.tsx's own headline number
// uses, kept in one place since there's no way to tell "count" from
// "identifier" from the number alone — only the label distinguishes them.
function formatKpiNumber(value: number, label: string): string {
  return isIdentifierLabel(label) ? value.toLocaleString() : formatValue(value, "number");
}

function TopKpiBar({ topKpis, currency }: { topKpis?: any[]; currency?: string }) {
  if (!topKpis || topKpis.length === 0) return null;
  return (
    <div className="flex-none bg-muted/50  flex items-center p-6 gap-6 overflow-x-auto border-b border-border">
      {topKpis.map((kpi, idx) => {
        const Icon = getIconForKpi(kpi.label);
        return (
          <div key={idx} className="flex-1 min-w-[240px] bg-card rounded-2xl border border-border/60 shadow-[0_2px_12px_-4px_rgba(0,0,0,0.05)] flex items-center justify-between p-6">
            <div className="flex flex-col justify-center gap-1.5">
              <p className="text-[2.25rem] font-bold tracking-tight text-primary  leading-none">
                {kpi.error ? (
                  <span className="text-sm text-destructive">{kpi.error}</span>
                ) : kpi.format === "percent" ? (
                  formatKpiPercent(kpi.value)
                ) : kpi.format === "currency" ? (
                  formatValue(Number(kpi.value) || 0, "currency", currency)
                ) : (
                  formatKpiNumber(Number(kpi.value) || 0, kpi.label ?? "")
                )}
              </p>
              <p className="text-[13px] font-medium text-muted-foreground">{kpi.label}</p>
            </div>
            <Icon className="h-10 w-10 text-muted-foreground/30 flex-shrink-0" strokeWidth={1.5} />
          </div>
        );
      })}
    </div>
  );
}
