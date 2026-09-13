"use client";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Loader2, X, Search, Plus, Minus, Home, AlertTriangle } from "lucide-react";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/reporting/format";
import type { BlockRenderContext } from "./types";
import { ProvenanceBadge } from "./ProvenanceBadge";
import { ShowWorkButton } from "./ShowWorkButton";
import { AskButton } from "./AskButton";
import { CommentButton } from "./CommentButton";
import { useDrillThrough } from "@/components/providers/drill-through-context";
import { useTheme } from "@/components/providers/ThemeProvider";
import { useCurrency } from "@/components/providers/CurrencyProvider";
import { BlockActions } from "./BlockActions";
import { cn } from "@/lib/utils";
import { THAILAND_MAP_W, THAILAND_MAP_H, THAILAND_PROVINCE_PATHS, THAILAND_PROVINCE_NAMES, thailandProvinceAliases } from "@/lib/reporting/thailandProvincePaths";
import { projectLon, projectLat } from "@/lib/reporting/thailandDistrictGeo";

/**
 * Choropleth map block.
 *
 * For "country"/"us-state", the renderer fetches d3-geo + topojson-client +
 * world-atlas from cdn.jsdelivr.net at runtime - keeping npm deps small and
 * letting the block ship without changing package.json. Once cached the
 * second mount is instant. "thailand-province" needs none of that — its
 * geometry is pre-baked into static SVG path data (thailandProvincePaths.ts).
 *
 * Region keys:
 *   - regionType="country" expects ISO-3 alpha (USA, GBR, JPN, ...)
 *   - regionType="us-state" expects 2-letter postal codes (CA, TX, NY, ...)
 *   - regionType="thailand-province" expects the English camelCase province
 *     slug (narathiwat, chiangMai, ... — see THAILAND_PROVINCE_PATHS's keys)
 *
 * Cells are colored on a single-hue ramp from a faint background to a
 * saturated brand color, scaled by the aggregated value. Regions with no
 * data render in muted gray. Hover surfaces region name + formatted value.
 */

/**
 * Fixed (theme-invariant) ramp tips. The "primary" slug is special — it
 * routes through the active theme's primary ramp via useTheme() so the
 * choropleth color scale follows the report theme.
 */
const FIXED_RAMP_TIPS: Record<string, string> = {
  emerald: "#10b981",
  amber:   "#f59e0b",
  rose:    "#f43f5e",
  cyan:    "#06b6d4",
};

const TOPOLOGY_URLS = {
  country:    "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json",
  "us-state": "https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json",
};

// We use ESM imports from esm.sh so they execute as proper modules.
const D3_GEO_URL    = "https://esm.sh/d3-geo@3";
const TOPO_CLIENT_URL = "https://esm.sh/topojson-client@3";

function fmt(v: number, kind: "number" | "currency" | "percent" | "compact", currency?: string): string {
  if (v == null || Number.isNaN(v)) return "";
  if (kind === "currency") return formatCurrency(v, currency);
  if (kind === "percent")  return formatPercent(v);
  if (kind === "compact") {
    const abs = Math.abs(v);
    if (abs >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
    if (abs >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (abs >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return v.toLocaleString();
  }
  return formatNumber(v);
}

// ISO-3 alpha → numeric (3-digit) codes used by world-atlas. Built-in for the
// 60+ markets a typical B2B demo cares about; missing entries fall back to
// matching by country name (next priority).
const ISO3_TO_NUM: Record<string, string> = {
  USA: "840", CAN: "124", MEX: "484", BRA: "076", ARG: "032", COL: "170", CHL: "152", PER: "604",
  GBR: "826", IRL: "372", FRA: "250", DEU: "276", ESP: "724", PRT: "620", ITA: "380", NLD: "528",
  BEL: "056", LUX: "442", CHE: "756", AUT: "040", DNK: "208", SWE: "752", NOR: "578", FIN: "246",
  ISL: "352", POL: "616", CZE: "203", SVK: "703", HUN: "348", ROU: "642", BGR: "100", GRC: "300",
  TUR: "792", RUS: "643", UKR: "804", BLR: "112",
  ZAF: "710", NGA: "566", KEN: "404", EGY: "818", MAR: "504", DZA: "012", GHA: "288", ETH: "231",
  CHN: "156", JPN: "392", KOR: "410", PRK: "408", TWN: "158", HKG: "344", SGP: "702", MYS: "458",
  THA: "764", VNM: "704", PHL: "608", IDN: "360", IND: "356", PAK: "586", BGD: "050", LKA: "144",
  AUS: "036", NZL: "554",
  ARE: "784", SAU: "682", QAT: "634", KWT: "414", OMN: "512", BHR: "048", JOR: "400", LBN: "422",
  ISR: "376", IRN: "364", IRQ: "368",
};

type Props = BlockRenderContext;

export function MapBlock(props: Props) {
  if (props.block.type !== "map") return null;
  return <MapBlockInner {...props} block={props.block} />;
}

type MapInnerProps = Omit<BlockRenderContext, "block"> & { block: Extract<BlockRenderContext["block"], { type: "map" }> };

function MapBlockInner({ block, dataset, provenance, print, report, params, reportDbId, bare }: MapInnerProps) {
  const cfg = block.config;
  // Wrapped in useMemo so `rows` is stable across renders when the dataset
  // entry hasn't changed, and to keep the logical-expression `?? []` out
  // of the downstream useMemo deps array.
  const datasetEntry = dataset[cfg.queryId];
  const rows = useMemo(
    () => (datasetEntry ?? []) as Record<string, unknown>[],
    [datasetEntry],
  );
  const proof = !print && provenance ? provenance[cfg.queryId] : undefined;
  const ds = !print ? report.dataSources.find((d) => d.id === cfg.queryId) ?? null : null;

  const onDrill = useDrillThrough();
  const drillEnabled = !print && (!!cfg.drilldown || !!cfg.drillParam) && !!onDrill;

  // Aggregate region -> value once.
  const byRegion = useMemo(() => {
    type B = { sum: number; count: number; min: number; max: number };
    const acc: Record<string, B> = {};
    for (const r of rows) {
      const key = String(r[cfg.regionField] ?? "").trim().toUpperCase();
      if (!key) continue;
      const v = Number(r[cfg.valueField]);
      if (!Number.isFinite(v)) continue;
      const e = acc[key] ?? { sum: 0, count: 0, min: Infinity, max: -Infinity };
      e.sum += v; e.count += 1;
      if (v < e.min) e.min = v;
      if (v > e.max) e.max = v;
      acc[key] = e;
    }
    return acc;
  }, [rows, cfg.regionField, cfg.valueField]);

  const valueOf = (key: string): number | null => {
    const e = byRegion[key];
    if (!e) return null;
    if (cfg.aggregation === "avg") return e.sum / e.count;
    if (cfg.aggregation === "count") return e.count;
    if (cfg.aggregation === "min") return e.min;
    if (cfg.aggregation === "max") return e.max;
    return e.sum;
  };

  const allValues = Object.keys(byRegion).map((k) => valueOf(k)!).filter((v): v is number => v != null);
  const maxAbs = Math.max(1, ...allValues.map((v) => Math.abs(v)));
  // The report's own SQL ran fine and returned rows, but not one of them
  // matched a region on this map — almost always means "Region Field" is
  // pointing at the wrong column (a code instead of a name, or the wrong
  // granularity), not "there's genuinely no data yet". Silently rendering
  // every region gray looks identical to that second, benign case, so this
  // surfaces the distinction instead of leaving it to be found by hand (as
  // it was the first time this exact mismatch happened, mid-build).
  const dataMismatch = rows.length > 0 && Object.keys(byRegion).length === 0;
  const regionFormatHint = cfg.regionType === "thailand-province"
    ? "one of Thailand's 77 province names (Thai or English, e.g. เชียงใหม่ / Chiang Mai)"
    : cfg.regionType === "us-state"
    ? "a 2-letter US state postal code (e.g. CA, TX)"
    : "an ISO-3 country code or country name (e.g. USA, THA)";
  // Theme-aware ramp resolution. "primary" follows the report theme;
  // semantic slugs (emerald/rose/etc) stay constant by design.
  const theme = useTheme();
  const currency = useCurrency();
  const rampSlug = cfg.ramp ?? "primary";
  const ramp = rampSlug === "primary"
    ? theme.ramps.primary[theme.ramps.primary.length - 1]
    : (FIXED_RAMP_TIPS[rampSlug] ?? theme.ramps.primary[theme.ramps.primary.length - 1]);

  // Render via dynamic-loaded d3 + topojson.
  const containerRef = useRef<HTMLDivElement>(null);
  // aliases: every upper-cased key a data row may use for this region —
  // see matchKey. Thai provinces get Thai + English + slug; country/state
  // features get iso3 + name + id.
  const [paths, setPaths] = useState<Array<{ id: string; iso3?: string; name: string; d: string; aliases: string[] }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // thailand-province only: the province currently shown in the floating
  // detail card (independent of drillEnabled/onDrill — works even when the
  // report author hasn't configured drillParam), a client-side name search,
  // and the container's actual pixel size (needed to reproduce the SVG's
  // own preserveAspectRatio="xMidYMid meet" letterboxing math so overlay
  // pins/cards land on the correct spot instead of drifting).
  const [selectedRegion, setSelectedRegion] = useState<{ id: string; name: string; cx: number; cy: number; row: Record<string, unknown> | null } | null>(null);
  const [search, setSearch] = useState("");
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const FULL_VIEW = { x: 0, y: 0, w: THAILAND_MAP_W, h: THAILAND_MAP_H };
  const [view, setView] = useState(FULL_VIEW);
  const zoomAnimRef = useRef<number | null>(null);
  // Drag-to-pan — once zoomed in (manually or via a province click), part of
  // the map falls outside the crop and there was previously no way to reach
  // it (reported: zoomed in, couldn't scroll down to click the southern
  // provinces). `moved` distinguishes a drag from a plain click so panning
  // doesn't accidentally trigger handleClick on release.
  const dragRef = useRef<{ active: boolean; startX: number; startY: number; lastX: number; lastY: number; moved: boolean; suppressClickUntil: number }>({ active: false, startX: 0, startY: 0, lastX: 0, lastY: 0, moved: false, suppressClickUntil: 0 });
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (cfg.regionType !== "thailand-province" || !containerRef.current) return;
    const el = containerRef.current;
    const update = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    update();
    // The synchronous read above can land mid-layout right after a
    // client-side drill navigation (e.g. clicking a province), capturing a
    // stale 0×H box that ResizeObserver then never corrects because the
    // container's actual size never changes again afterward — pins and the
    // floating detail card (both gated on toScreenPct, which refuses to
    // compute against a zero-sized box) would then silently never appear.
    // A rAF-deferred re-measure catches that case without waiting on an
    // unrelated resize event.
    const raf = requestAnimationFrame(update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [cfg.regionType]);

  // Animates `view` (the SVG viewBox) toward `target` over ~500ms with an
  // ease-out curve — a small hand-rolled tween via requestAnimationFrame
  // rather than adding framer-motion as a dependency just for this one
  // effect (the reference implementation uses framer-motion's animate();
  // this reproduces the same visual result without the extra package).
  function animateView(target: { x: number; y: number; w: number; h: number }) {
    if (zoomAnimRef.current != null) cancelAnimationFrame(zoomAnimRef.current);
    const from = view;
    const start = performance.now();
    const duration = 500;
    function step(now: number) {
      const t = Math.min(1, (now - start) / duration);
      const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setView({
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
        w: from.w + (target.w - from.w) * e,
        h: from.h + (target.h - from.h) * e,
      });
      if (t < 1) zoomAnimRef.current = requestAnimationFrame(step);
      else zoomAnimRef.current = null;
    }
    zoomAnimRef.current = requestAnimationFrame(step);
  }

  // Fits a province's path into the viewport with generous padding (55%,
  // matching the reference implementation) so its shape reads clearly
  // without feeling like an uncomfortably tight crop. Bbox is derived by
  // regex-scanning the path's own "d" string for coordinate pairs rather
  // than needing real SVG geometry APIs (this runs before layout, and
  // getBBox() requires the element to already be mounted/painted).
  function bboxFromPath(d: string): { x: number; y: number; w: number; h: number } | null {
    const nums = d.match(/-?\d+\.?\d*/g)?.map(Number) ?? [];
    if (nums.length < 2) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const px = nums[i], py = nums[i + 1];
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
    }
    const w = maxX - minX, h = maxY - minY;
    const padX = w * 0.55, padY = h * 0.55;
    return { x: minX - padX, y: minY - padY, w: w + padX * 2, h: h + padY * 2 };
  }

  // Keeps the crop window inside the full map — translation only (w/h are
  // already clamped by their own callers), so panning or zooming near an
  // edge (e.g. Narathiwat in the far south) stops at the boundary instead
  // of drifting into empty space with no way back without a full reset.
  function clampView(v: { x: number; y: number; w: number; h: number }) {
    const maxX = Math.max(0, FULL_VIEW.w - v.w);
    const maxY = Math.max(0, FULL_VIEW.h - v.h);
    return { ...v, x: Math.min(Math.max(v.x, 0), maxX), y: Math.min(Math.max(v.y, 0), maxY) };
  }

  function zoomToProvince(slug: string) {
    const geo = THAILAND_PROVINCE_PATHS[slug];
    if (!geo) return;
    const box = bboxFromPath(geo.d);
    if (box) animateView(clampView(box));
  }

  // Zooms tight around a single point (viewBox units) — used for district
  // pins, which have no path/bbox of their own to fit like a province does.
  // A hand-typed district centroid can sit a little outside its own
  // province's actual boundary path, so a pin's exact screen pixel doesn't
  // always land back on a clickable <path> underneath it; making the pin
  // itself the click target (zooming in on ITS coordinate, not whatever
  // happens to be under it) sidesteps that instead of relying on it.
  function zoomToPoint(x: number, y: number) {
    const w = THAILAND_MAP_W * 0.12;
    const h = THAILAND_MAP_H * 0.12;
    animateView(clampView({ x: x - w / 2, y: y - h / 2, w, h }));
  }

  function resetZoom() {
    setSelectedRegion(null);
    animateView(FULL_VIEW);
    // "Zoom out to the whole country" should mean "show the whole country" —
    // without this, the choropleth stayed spotlighted on whatever province
    // was last drilled into (every other region grayed out) even after
    // visually zooming back out to full extent. DashboardViewer's openDrill
    // treats an empty-string value as "clear this dimension" specifically
    // for this case.
    if (drillEnabled) onDrill!(block.id, "");
  }

  // Manual zoom, centered on whatever's currently in the middle of the
  // view — for when a province is too small to click reliably before
  // zooming in at all (77 provinces packed into a small dashboard card).
  // Scales width/height by the same factor so the viewBox's aspect ratio
  // never distorts. Clamped between the full-country view (can't zoom out
  // past that) and a minimum crop (can't zoom in past useless).
  function zoomBy(factor: number) {
    const cx = view.x + view.w / 2;
    const cy = view.y + view.h / 2;
    const MIN_W = THAILAND_MAP_W * 0.06;
    const MIN_H = THAILAND_MAP_H * 0.06;
    let w = Math.min(FULL_VIEW.w, Math.max(MIN_W, view.w * factor));
    let h = Math.min(FULL_VIEW.h, Math.max(MIN_H, view.h * factor));
    // Snap back to the exact full-country origin once zoomed all the way
    // out, rather than a same-size-but-off-center crop from rounding.
    if (w >= FULL_VIEW.w && h >= FULL_VIEW.h) { animateView(FULL_VIEW); return; }
    animateView(clampView({ x: cx - w / 2, y: cy - h / 2, w, h }));
  }

  // Pans the crop window by a raw pixel delta (screen space) converted into
  // viewBox units via the same scale toScreenPct uses. Applied directly
  // (not animated) for 1:1 responsiveness while dragging.
  function panBy(dxPx: number, dyPx: number) {
    if (box.w <= 0 || box.h <= 0) return;
    const scale = Math.min(box.w / view.w, box.h / view.h);
    setView((v) => clampView({ ...v, x: v.x - dxPx / scale, y: v.y - dyPx / scale }));
  }

  // A "click" is never pixel-perfect on real hardware — mouse/trackpad hand
  // tremor routinely reports 1-3px of movement between button-down and
  // button-up. Checking only the delta since the *previous* move event (the
  // original approach) treats that jitter as an intentional drag on almost
  // every real click once zoomed in, which is why + then clicking a
  // province appeared to do nothing. Comparing cumulative displacement from
  // the gesture's start point instead tolerates jitter while still catching
  // any genuine drag within a few pixels.
  const DRAG_THRESHOLD_PX = 6;

  function handlePointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (cfg.regionType !== "thailand-province" || view.w >= FULL_VIEW.w) return;
    dragRef.current.active = true;
    dragRef.current.startX = e.clientX;
    dragRef.current.startY = e.clientY;
    dragRef.current.lastX = e.clientX;
    dragRef.current.lastY = e.clientY;
    dragRef.current.moved = false;
    setIsDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function handlePointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (!dragRef.current.active) return;
    const dx = e.clientX - dragRef.current.lastX;
    const dy = e.clientY - dragRef.current.lastY;
    const totalDx = e.clientX - dragRef.current.startX;
    const totalDy = e.clientY - dragRef.current.startY;
    if (Math.hypot(totalDx, totalDy) > DRAG_THRESHOLD_PX) dragRef.current.moved = true;
    dragRef.current.lastX = e.clientX;
    dragRef.current.lastY = e.clientY;
    panBy(dx, dy);
  }
  function handlePointerUp() {
    // A brief self-expiring window rather than a single-shot flag consumed
    // by the next click event — pointer capture / synthetic dispatch don't
    // always deliver that follow-up click, and a flag left set would then
    // silently swallow the next UNRELATED click instead of just this one.
    if (dragRef.current.moved) dragRef.current.suppressClickUntil = Date.now() + 300;
    dragRef.current.active = false;
    dragRef.current.moved = false;
    setIsDragging(false);
  }

  // Converts a point already in THAILAND_PROVINCE_PATHS' coordinate space
  // (viewBox units — province cx/cy, or a district's projectLon/projectLat
  // output) into a 0..1 fraction of the container, accounting for both the
  // current zoomed `view` window and the SVG's own centered-letterbox fit
  // within a container whose aspect ratio rarely matches the view's shape.
  function toScreenPct(x: number, y: number): { xPct: number; yPct: number } | null {
    if (box.w <= 0 || box.h <= 0) return null;
    const scale = Math.min(box.w / view.w, box.h / view.h);
    const px = (x - view.x) * scale + (box.w - view.w * scale) / 2;
    const py = (y - view.y) * scale + (box.h - view.h * scale) / 2;
    return { xPct: px / box.w, yPct: py / box.h };
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // Thailand's geometry is already flattened to plain SVG path strings
        // (see thailandProvincePaths.ts) — no d3-geo/topojson CDN fetch or
        // projection needed, unlike country/us-state below.
        if (cfg.regionType === "thailand-province") {
          const out: typeof paths = Object.entries(THAILAND_PROVINCE_PATHS).map(([slug, p]) => ({
            id: slug,
            name: THAILAND_PROVINCE_NAMES[slug]?.th ?? slug,
            d: p.d,
            aliases: thailandProvinceAliases(slug),
          }));
          setPaths(out);
          setLoading(false);
          return;
        }
        const [d3Geo, topoClient, topology] = await Promise.all([
          import(/* webpackIgnore: true */ D3_GEO_URL) as any,
          import(/* webpackIgnore: true */ TOPO_CLIENT_URL) as any,
          fetch(TOPOLOGY_URLS[cfg.regionType]).then((r) => r.json()),
        ]);
        if (cancelled) return;

        const featureKey = cfg.regionType === "country" ? "countries" : "states";
        const featureCollection = topoClient.feature(topology, topology.objects[featureKey]);

        // Pick a projection that keeps the world readable and centers nicely.
        const projection = cfg.regionType === "us-state"
          ? d3Geo.geoAlbersUsa()
          : d3Geo.geoEqualEarth();
        // Fit projection to the viewBox so countries render at full size.
        const W = 800, H = 420;
        projection.fitSize([W, H], featureCollection);
        const path = d3Geo.geoPath(projection);

        const out: typeof paths = [];
        let i = 0;
        for (const f of featureCollection.features) {
          const numId = String(f.id ?? "");
          const name = (f.properties?.name as string) ?? numId;
          // Find the iso3 by reverse-lookup (numeric id -> iso3). Falls back to name.
          let iso3: string | undefined;
          for (const [k, v] of Object.entries(ISO3_TO_NUM)) {
            if (v === numId) { iso3 = k; break; }
          }
          const d = path(f) ?? "";
          // Always-unique key: prefer numeric id, fall back to name + index so
          // features without an `id` property (which exist in some topologies)
          // don't all collide on an empty-string key.
          const uniqueKey = numId || `f-${name || "x"}-${i}`;
          out.push({ id: uniqueKey, iso3, name, d, aliases: [...new Set([iso3, name.toUpperCase(), uniqueKey.toUpperCase()].filter((a): a is string => !!a))] });
          i++;
        }
        setPaths(out);
        setLoading(false);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message ?? "Failed to load map");
        setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [cfg.regionType]);

  /** The data key (byRegion's upper-cased row value) this region's rows used, if any. */
  function matchKey(p: { aliases: string[] }): string | null {
    return p.aliases.find((a) => byRegion[a] !== undefined) ?? null;
  }

  function colorFor(p: { aliases: string[] }): string {
    const k = matchKey(p);
    const v = k ? valueOf(k) : null;
    if (v == null) return "rgba(15,23,42,0.05)";
    if (v < 0) {
      const t = Math.min(1, Math.abs(v) / maxAbs);
      return colorMix(theme.semantic.danger, Math.round(15 + t * 65));
    }
    const t = Math.min(1, v / maxAbs);
    return colorMix(ramp, Math.round(12 + t * 70));
  }

  function valueForPath(p: { aliases: string[] }): number | null {
    const k = matchKey(p);
    return k ? valueOf(k) : null;
  }

  // Full underlying row for the clicked region (not just the aggregated
  // valueField) — powers the floating detail card, which shows every
  // column the report author selected, not a single pre-picked metric.
  // Same alias match as colorFor/valueForPath.
  function rowForRegion(p: { aliases: string[] }): Record<string, unknown> | null {
    const k = matchKey(p);
    if (!k) return null;
    return (rows.find((r) => String(r[cfg.regionField] ?? "").trim().toUpperCase() === k) as Record<string, unknown>) ?? null;
  }

  function handleClick(p: { iso3?: string; name: string; id?: string }) {
    // A drag-to-pan gesture still fires a click on release; swallow clicks
    // for a brief window after any drag that actually moved the view.
    if (Date.now() < dragRef.current.suppressClickUntil) return;
    if (cfg.regionType === "thailand-province" && p.id) {
      const geo = THAILAND_PROVINCE_PATHS[p.id];
      setSelectedRegion({ id: p.id, name: p.name, cx: geo?.cx ?? 0, cy: geo?.cy ?? 0, row: rowForRegion(p as any) });
      zoomToProvince(p.id);
    }
    if (!drillEnabled) return;
    const key = p.iso3 ?? p.name;
    onDrill!(block.id, key);
  }

  return (
    <div className={cn(
      "group relative flex h-full flex-col overflow-hidden",
      bare ? "p-1" : "rounded-lg border border-border bg-card p-4 shadow-xs",
    )}>
      {!print && (proof || ds) && (
        <div className="absolute right-2 top-2 z-10">
          <BlockActions>
            {reportDbId && <AskButton reportId={reportDbId} blockId={block.id} blockType="chart" params={params} />}
            {reportDbId && <CommentButton reportId={reportDbId} blockId={block.id} proofHash={proof?.queryHash} />}
            {ds && <ShowWorkButton ds={ds} rows={rows} params={params} />}
            {proof && <ProvenanceBadge record={proof} />}
          </BlockActions>
        </div>
      )}
      {!bare && (cfg.title || cfg.subtitle) && (
        <header className="mb-3 pr-12">
          {cfg.title && (
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              {cfg.title}
              {drillEnabled && (
                <span className="rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-primary">
                  click to drill
                </span>
              )}
            </h3>
          )}
          {cfg.subtitle && <p className="mt-0.5 text-[11px] text-muted-foreground">{cfg.subtitle}</p>}
        </header>
      )}
      {!loading && !error && dataMismatch && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-warning/60 bg-warning/10 p-2.5 text-warning  ">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <p className="text-xs leading-relaxed">
            {rows.length} row{rows.length === 1 ? "" : "s"} loaded, but none matched a region on this map — every one rendered gray. Check that <strong>Region Field</strong> ({cfg.regionField}) holds {regionFormatHint}, not a different column.
          </p>
        </div>
      )}
      {/* Search lives outside the map container (which clips overflow) so its
          results dropdown isn't cut off. Client-side only — province names
          are already fully loaded, no extra query. */}
      {cfg.regionType === "thailand-province" && !loading && !error && (
        <div className="relative mb-2 shrink-0">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ค้นหาจังหวัด…"
            className="w-full rounded-md border border-border bg-background py-1.5 pl-7 pr-2.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {search.trim() && (
            <div
              className="absolute z-30 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-border shadow-lg"
              style={{ backgroundColor: "hsl(var(--background, 0 0% 100%))" }}
            >
              {paths.filter((p) => p.name.includes(search.trim()) || p.aliases.some((a) => a.includes(search.trim().toUpperCase()))).slice(0, 8).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => { handleClick(p); setSearch(""); }}
                  className="block w-full px-2.5 py-1.5 text-left text-xs hover:bg-muted"
                >
                  {p.name}
                </button>
              ))}
              {paths.filter((p) => p.name.includes(search.trim()) || p.aliases.some((a) => a.includes(search.trim().toUpperCase()))).length === 0 && (
                <p className="px-2.5 py-1.5 text-xs text-muted-foreground">ไม่พบจังหวัด</p>
              )}
            </div>
          )}
        </div>
      )}
      <div ref={containerRef} className={"relative min-h-0 flex-1 overflow-hidden " + (bare ? "pt-8" : "")}>
        {/* Manual zoom — 77 provinces packed into a small dashboard card can
            be too small to click reliably; lets a viewer zoom in first,
            then click precisely, instead of relying only on the
            click-to-auto-zoom that already happens on a province click. */}
        {cfg.regionType === "thailand-province" && !loading && !error && (
          <div className="pointer-events-auto absolute right-2 top-2 z-30 flex flex-col overflow-hidden rounded-md border border-border shadow-sm" style={{ backgroundColor: "hsl(var(--background, 0 0% 100%))" }}>
            <button type="button" onClick={() => zoomBy(0.7)} className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground" title="Zoom in" aria-label="Zoom in">
              <Plus className="h-3 w-3" />
            </button>
            <button type="button" onClick={() => zoomBy(1 / 0.7)} className="flex h-6 w-6 items-center justify-center border-t border-border text-muted-foreground hover:bg-muted hover:text-foreground" title="Zoom out" aria-label="Zoom out">
              <Minus className="h-3 w-3" />
            </button>
            <button type="button" onClick={resetZoom} className="flex h-6 w-6 items-center justify-center border-t border-border text-muted-foreground hover:bg-muted hover:text-foreground" title="Reset view" aria-label="Reset view">
              <Home className="h-3 w-3" />
            </button>
          </div>
        )}
        {loading && (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading map…
          </div>
        )}
        {error && (
          <div className="flex h-full items-center justify-center text-xs text-destructive">
            Failed to load map: {error}
          </div>
        )}
        {!loading && !error && (
          <svg
            viewBox={cfg.regionType === "thailand-province" ? `${view.x} ${view.y} ${view.w} ${view.h}` : "0 0 800 420"}
            width="100%"
            height="100%"
            className="block touch-none"
            style={cfg.regionType === "thailand-province" && view.w < FULL_VIEW.w ? { cursor: isDragging ? "grabbing" : "grab" } : undefined}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
          >
            {paths.map((p) => {
              const v = valueForPath(p);
              return (
                <path
                  key={p.id}
                  d={p.d}
                  fill={colorFor(p)}
                  stroke="rgba(255,255,255,0.85)"
                  strokeWidth={0.4}
                  onClick={() => handleClick(p)}
                  style={{ cursor: (cfg.regionType === "thailand-province" || drillEnabled) && v != null ? "pointer" : "default" }}
                >
                  <title>{v != null
                    ? `${p.name} — ${fmt(v, cfg.format ?? "compact", currency)}`
                    : `${p.name} — no data`}</title>
                </path>
              );
            })}
          </svg>
        )}
        {/* District pins — thailand-province only, empty until cfg.pinsQueryId's
            query actually returns rows (typically scoped to the currently
            drilled-into province via the same :drillParam binding used for
            the choropleth itself, so pins appear as a natural side effect of
            drilling in rather than needing separate UI). */}
        {cfg.regionType === "thailand-province" && cfg.pinsQueryId && !loading && !error && (() => {
          const pinRows = (dataset[cfg.pinsQueryId] ?? []) as Record<string, unknown>[];
          const lonKey = cfg.pinLonField ?? "lon";
          const latKey = cfg.pinLatField ?? "lat";
          const nameKey = cfg.pinNameField ?? "name";
          return pinRows.map((r, i) => {
            const lon = Number(r[lonKey]);
            const lat = Number(r[latKey]);
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
            const pos = toScreenPct(projectLon(lon), projectLat(lat));
            if (!pos) return null;
            const name = String(r[nameKey] ?? "");
            const val = cfg.pinValueField ? r[cfg.pinValueField] : undefined;
            const valNum = Number(val);
            return (
              <div
                key={i}
                className="pointer-events-none absolute"
                style={{ left: `${pos.xPct * 100}%`, top: `${pos.yPct * 100}%` }}
              >
                <button
                  type="button"
                  onClick={() => zoomToPoint(projectLon(lon), projectLat(lat))}
                  className="pointer-events-auto -ml-1.5 -mt-1.5 h-3 w-3 cursor-pointer rounded-full shadow ring-2 ring-background transition-transform hover:scale-150"
                  style={{ backgroundColor: ramp }}
                  title={`${name}${Number.isFinite(valNum) ? " — " + fmt(valNum, cfg.format ?? "compact", currency) : ""}`}
                  aria-label={name}
                />
              </div>
            );
          });
        })()}
        {/* Floating detail card — set by handleClick regardless of whether
            drillParam is configured, so it works standalone too. Shows
            every column in the matched row except the one used for region
            matching (already the card's own title), using the report
            author's own SQL-aliased column names as labels. */}
        {cfg.regionType === "thailand-province" && selectedRegion && (() => {
          const pos = toScreenPct(selectedRegion.cx, selectedRegion.cy);
          if (!pos) return null;
          const entries = selectedRegion.row
            ? Object.entries(selectedRegion.row).filter(([k]) => k !== cfg.regionField)
            : [];
          // Positioned in real pixels (not %+transform) so it can be fully
          // CLAMPED within the container on every edge at once — Thailand's
          // tall, irregular shape puts province centroids anywhere from a
          // corner (Chiang Rai, Narathiwat) to dead-center (Phatthalung),
          // and a "flip to the other side" rule alone can still clip when
          // BOTH sides are tight on a narrow dashboard card; clamping is the
          // only approach that's correct everywhere.
          const CARD_W = 208, CARD_H = 84, MARGIN = 4;
          const pxX = pos.xPct * box.w, pxY = pos.yPct * box.h;
          let cardLeft = pxX + 10;
          if (cardLeft + CARD_W > box.w - MARGIN) cardLeft = pxX - CARD_W - 10;
          cardLeft = Math.max(MARGIN, Math.min(cardLeft, box.w - CARD_W - MARGIN));
          let cardTop = pxY - CARD_H - 8;
          if (cardTop < MARGIN) cardTop = pxY + 8;
          cardTop = Math.max(MARGIN, Math.min(cardTop, box.h - CARD_H - MARGIN));
          return (
            <div
              className="pointer-events-auto absolute z-30 w-52 overflow-hidden rounded-lg border border-border text-foreground shadow-2xl"
              style={{
                left: cardLeft,
                top: cardTop,
                backgroundColor: "hsl(var(--background, 0 0% 100%))",
              }}
            >
              <div className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-1.5">
                <span className="truncate text-xs font-semibold">{selectedRegion.name}</span>
                <button
                  type="button"
                  onClick={() => { setSelectedRegion(null); resetZoom(); }}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Close"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
              <div className="space-y-1 px-2.5 py-2 text-[11px]">
                {entries.length > 0 ? entries.map(([k, v]) => {
                  const n = Number(v);
                  const display = v != null && v !== "" && Number.isFinite(n) ? fmt(n, "compact", currency) : String(v ?? "—");
                  return (
                    <div key={k} className="flex items-center justify-between gap-3">
                      <span className="truncate text-muted-foreground">{k}</span>
                      <span className="shrink-0 font-medium tabular-nums text-foreground">{display}</span>
                    </div>
                  );
                }) : <p className="text-muted-foreground">No data</p>}
              </div>
            </div>
          );
        })()}
      </div>
      {/* Legend */}
      {!loading && !error && allValues.length > 0 && (
        <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>0</span>
          {[0.15, 0.35, 0.55, 0.75, 0.95].map((t, i) => (
            <span key={i}
              className="inline-block h-3 w-5 rounded-sm"
              style={{ background: colorMix(ramp, Math.round(12 + t * 70)) }}
            />
          ))}
          <span>{fmt(maxAbs, cfg.format ?? "compact", currency)}</span>
          <span className="ml-auto">
            {Object.keys(byRegion).length} {cfg.regionType === "country" ? "countries" : cfg.regionType === "us-state" ? "states" : "provinces"} with data
          </span>
        </div>
      )}
    </div>
  );
}

function colorMix(hex: string, alphaPct: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${(alphaPct / 100).toFixed(2)})`;
}
