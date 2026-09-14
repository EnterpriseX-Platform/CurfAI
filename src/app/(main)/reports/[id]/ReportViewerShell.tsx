"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Download, Pencil, FileSpreadsheet, FileText, FileCode, Loader2, Clock, RotateCcw, Eye, RefreshCw, Check, MoreHorizontal,
} from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import type { Report } from "@/lib/reporting/schema";
import type { Dataset } from "@/lib/reporting/interpolate";
import type { ProvenanceMap } from "@/lib/reporting/provenance";
import { ReportDocument } from "@/components/reports/ReportDocument";
import { FilterBar } from "./FilterBar";
import { DrillPanel, DRILL_INITIAL, type DrillState } from "./DrillPanel";
import { DrillThroughContext } from "@/components/providers/drill-through-context";
import { Button } from "@/components/ui/button";
import { AppShell } from "@/components/layout/AppShell";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ShareButton } from "./ShareButton";
import { RegenerateButton } from "./RegenerateButton";
import { WhatIsThisBadge } from "@/components/viewer/WhatIsThisBadge";
import { OnboardingTour } from "@/components/viewer/OnboardingTour";
import { PresenceChip } from "./PresenceChip";
import { OperateActionsProvider } from "@/components/providers/OperateActionsProvider";
import { eeClient } from "@/ee/client";
import { reportDisplay } from "@/lib/reporting/schema";

const WatcherSuggestionsBanner = eeClient.reports?.WatcherSuggestionsBanner ?? null;
const AskCurfPanel = eeClient.reports?.AskCurfPanel ?? null;
const IS_COMMUNITY = eeClient.edition === "community";
const SuggestOperateActionsButton = eeClient.reports?.SuggestOperateActionsButton ?? null;
const PublishToMarketplaceButton = eeClient.reports?.PublishToMarketplaceButton ?? null;
import { AutoCurfPublishedBanner } from "./AutoCurfPublishedBanner";
import { SlowQueryBanner } from "./SlowQueryBanner";
import { useResilientSession } from "@/lib/useResilientSession";
import { useT } from "@/lib/i18n/LocaleContext";
import { useToast } from "@/lib/toast";
import { canBuild } from "@/lib/roles";

export function ReportViewerShell({
  reportId, report, initialParams, initialDataset, initialProvenance, replayedAt, previewAsRole, runError,
  userPrefs, tenantBrand, tenantCurrency, version, updatedAt, author,
}: {
  reportId: string;
  report: Report;
  initialParams: Record<string, unknown>;
  initialDataset: Dataset;
  initialProvenance?: ProvenanceMap;
  /** Report row metadata for the page header (version chip, "published by … · 06:05"). */
  version?: number;
  updatedAt?: string;
  author?: string | null;
  replayedAt?: string | null;
  /** When set, RBAC filtered as if viewer had these role slugs (admin-only preview). */
  previewAsRole?: string | null;
  /** Personalization layer (Slice B/C). */
  userPrefs?: any;
  tenantBrand?: any;
  tenantCurrency?: string | null;
  /** Set if the server-side runner threw - shown as a soft banner so blocks
   *  still render their own empty/error states underneath. */
  runError?: { message: string } | null;
}) {
  // See useResilientSession() for why this isn't a plain useSession() call:
  // it self-heals next-auth's client from a stuck-null-session state
  // instead of silently rendering as a read-only viewer forever.
  const { role, user } = useResilientSession();
  const isEditor = canBuild(role);
  // Eyebrow: "Reports / <workspace>" — the active membership's name, same
  // source the rail's workspace block reads.
  const memberships = ((user as any)?.memberships ?? []) as Array<{ tenantId: string; tenantName: string }>;
  const activeTenantId = (user as any)?.activeTenantId ?? (user as any)?.tenantId;
  const tenantName = memberships.find((m) => m.tenantId === activeTenantId)?.tenantName ?? null;
  // Content locale (report i18n overrides) — a different axis from the
  // report's tenant-authored data than the UI chrome locale, but reusing
  // the same viewer-facing signal is the simplest thing that could be
  // right: if you flip the app to Thai, a report with Thai copy authored
  // should show it too.
  const { locale, t } = useT();
  const { push: pushToast } = useToast();
  const [params, setParams] = useState(initialParams);
  // Auto-refresh's interval callback reads this instead of closing over
  // `params` directly — keeps the timer itself stable (no reset on every
  // filter change) while still always applying the CURRENT filters, not
  // whatever was set at mount.
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const [dataset, setDataset] = useState(initialDataset);
  const [provenance, setProvenance] = useState<ProvenanceMap | undefined>(initialProvenance);
  const [loading, setLoading] = useState(false);
  const [drill, setDrill] = useState<DrillState>(DRILL_INITIAL);
  // Saved-view selection. Stored on the client because /api/reports/:id/run
  // doesn't care about it — the view's params are just applied like any
  // other filter change. We mirror it into ?view=<id> so a copy/paste URL
  // restores the same active view (and its highlighted chip).
  const [activeViewId, setActiveViewId] = useState<string | null>(null);

  // On mount, hydrate ?view=<id> if present + load that view's params.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const here = new URL(window.location.href);
    const vid = here.searchParams.get("view");
    if (!vid) return;
    setActiveViewId(vid);
    // Don't apply yet if the URL already carries explicit p.* values — those
    // win because they came from a deliberate share (e.g. someone tweaked the
    // saved view's filters and then copied the link). Detect by checking if
    // any ?p.* keys exist in the URL.
    let hasInlineParams = false;
    here.searchParams.forEach((_v, k) => { if (k.startsWith("p.")) hasInlineParams = true; });
    if (hasInlineParams) return;
    fetch(`/api/reports/${reportId}/views/${vid}`, { credentials: "include" })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => {
        if (j?.view?.params) void applyParams(j.view.params);
      })
      .catch(() => { /* silent — chip will show "—" if the view was deleted */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open the drill panel + fetch the underlying rows for a clicked chart point.
  // Memoised by closing over `params` so the latest filter-bar state always
  // rides along with the drill query.
  async function openDrill(blockId: string, value: unknown) {
    setDrill({ ...DRILL_INITIAL, open: true, loading: true, blockId });
    try {
      const res = await fetch("/api/reports/" + reportId + "/drill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blockId, value, params }),
      });
      const json = await res.json();
      if (!res.ok) {
        setDrill((s) => ({ ...s, loading: false, error: json.error ?? "Drill failed" }));
        return;
      }
      setDrill({
        open: true, loading: false, blockId,
        title: json.title ?? "Drill-through",
        filterParam: json.filterParam,
        filterValue: json.filterValue,
        rowCount: json.rowCount,
        columns: json.columns ?? [],
        rows: json.rows ?? [],
        truncated: !!json.truncated,
        error: null,
        // Pass reportId through so DrillPanel's Operate hook knows which
        // report the chart-click trigger context should record.
        reportId,
      });
    } catch (e: any) {
      setDrill((s) => ({ ...s, loading: false, error: e?.message ?? "Drill failed" }));
    }
  }
  function closeDrill() { setDrill((s) => ({ ...s, open: false })); }

  // Dashboard auto-refresh. Pass ?refresh=N (seconds, >=5) to re-run the
  // report on a cadence. Great for TV dashboards; cheap because applyParams
  // only re-hits /api/reports/:id/run, not the whole page.
  const [refreshSec, setRefreshSec] = useState<number | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = new URL(window.location.href).searchParams.get("refresh");
    const n = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(n) || n < 5) return;
    setRefreshSec(n);
    const timer = setInterval(() => { void applyParams(paramsRef.current); }, n * 1000);
    return () => clearInterval(timer);
    // Deliberately mount-once: reportId never changes, and paramsRef.current
    // (not a closure) now supplies fresh filters on every tick — see paramsRef above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Relative URLs so these helpers are safe during Next's server render of
  // this client component (where `window` is undefined). The browser
  // resolves a leading-slash URL against the current origin automatically.
  function exportUrl(format: "pdf" | "xlsx" | "docx" | "csv") {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== "") qs.set(`p.${k}`, String(v));
    }
    const path = `/api/reports/${reportId}/export/${format}`;
    const query = qs.toString();
    return query ? `${path}?${query}` : path;
  }

  // CSV, unlike pdf/xlsx/docx, has a real "nothing to export" case (no
  // table block on the report) and the API route reports it as a 400 JSON
  // error — a plain <a href> navigation (what pdf/xlsx/docx still use,
  // since they always have *something* to render) dumped that raw JSON
  // into the whole tab instead of downloading anything. Fetch + blob lets
  // a failure surface as a toast instead, same pattern as SchedulesManager's
  // runNow().
  const [csvExporting, setCsvExporting] = useState(false);
  async function exportCsv() {
    setCsvExporting(true);
    try {
      const r = await fetch(exportUrl("csv"));
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: "Export failed." }));
        pushToast({
          variant: "destructive",
          title: "Couldn't export CSV",
          description: err.error ?? "This report doesn't have a table block to export.",
        });
        return;
      }
      const blob = await r.blob();
      const cd = r.headers.get("content-disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(cd);
      const fname = match?.[1] ?? "report.csv";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = fname; a.click();
      URL.revokeObjectURL(url);
    } catch {
      pushToast({ variant: "destructive", title: "Couldn't export CSV", description: "Network error." });
    } finally {
      setCsvExporting(false);
    }
  }

  async function applyParams(next: Record<string, unknown>) {
    setLoading(true);
    setParams(next);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) {
      if (v != null && v !== "") qs.set(`p.${k}`, String(v));
    }
    const query = qs.toString();

    // Mirror filter state into the URL so a copy-paste or browser refresh
    // restores the same view. Use replaceState (not router.push) to avoid
    // bloating the back-stack on every dropdown click.
    if (typeof window !== "undefined") {
      const here = new URL(window.location.href);
      // Strip any old p.* params, preserve everything else (replayedAt, refresh, etc).
      const preserved = new URLSearchParams();
      here.searchParams.forEach((value, key) => {
        if (!key.startsWith("p.")) preserved.set(key, value);
      });
      qs.forEach((value, key) => preserved.set(key, value));
      // Keep ?view in sync with state — if a saved view is active include
      // it, otherwise drop the key so a copy/paste link is clean.
      if (activeViewId) preserved.set("view", activeViewId);
      else preserved.delete("view");
      const newQs = preserved.toString();
      const newUrl = here.pathname + (newQs ? "?" + newQs : "") + here.hash;
      window.history.replaceState(null, "", newUrl);
    }

    const url = `/api/reports/${reportId}/run${query ? `?${query}` : ""}`;
    const res = await fetch(url);
    const json = await res.json();
    setDataset(json.dataset ?? {});
    if (json.provenance) setProvenance(json.provenance);
    setLoading(false);
  }

  // Defaults from the report parameters definition - used by the FilterBar
  // for the "Reset" button and the dirty-state highlight on each chip.
  const paramDefaults = (() => {
    const out: Record<string, unknown> = {};
    for (const p of report.parameters) out[p.name] = p.default ?? "";
    return out;
  })();

  const reportName = report.nameI18n?.[locale] ?? report.name;
  // The page header's receipt: the primary query's data hash plus the rows
  // every query returned — the report-level version of a KPI card's receipt.
  const primaryProof = provenance?.[report.dataSources[0]?.id ?? ""];
  const totalRows = provenance ? Object.values(provenance).reduce((s, p) => s + (p?.rowCount ?? 0), 0) : 0;
  const shortHash = (h?: string) => {
    if (!h) return null;
    const hex = h.replace(/^sha256:/i, "");
    return `${hex.slice(0, 4)}…${hex.slice(-2)}`;
  };
  // Formatted on the client only — the server's zone would differ from the
  // viewer's and fail hydration.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const publishedAt = (() => {
    if (!updatedAt || !mounted) return null;
    const d = new Date(updatedAt);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    return sameDay ? time : `${d.toLocaleDateString(locale, { day: "numeric", month: "short" })} ${time}`;
  })();

  const exportMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Download className="mr-1.5 h-4 w-4" /> Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem asChild>
          <a href={exportUrl("pdf")} target="_blank" rel="noreferrer"><FileText className="mr-2 h-4 w-4" /> PDF</a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={exportUrl("xlsx")}><FileSpreadsheet className="mr-2 h-4 w-4" /> Excel</a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={exportUrl("docx")}><FileText className="mr-2 h-4 w-4" /> Word</a>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => void exportCsv()}
          disabled={csvExporting}
          className="cursor-pointer"
        >
          {csvExporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileCode className="mr-2 h-4 w-4" />} CSV
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    // TableBlock's row "⋮" action button (src/components/blocks/TableBlock.tsx)
    // was already wired to useOperateActions() — it just had nowhere to reach:
    // this shell never mounted the provider, so the button never appeared here,
    // even though the exact same component shows it inside a public Analytic
    // App. Every render of this shell already implies an authenticated tenant
    // member (page.tsx redirects to /login otherwise; a print=true request
    // never reaches this shell), so no extra role gate is needed — same bar
    // AppViewer.tsx's canAct enforces one layer up. No appId: a Console report
    // visit didn't happen through an App, so a raised request correctly gets
    // no Decision-ledger linkage (createDecisionForRequest no-ops without one).
    <OperateActionsProvider>
      <AppShell
        breadcrumbs={[
          { label: "Reports", href: "/reports" },
          { label: reportName },
        ]}
        // The top bar keeps only the global Ask field; everything that acts
        // on this report lives in the page header below, next to its title.
      >
      <div className="no-print">
        {replayedAt && (
          <div className="flex items-center justify-between gap-3 border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs">
            <div className="flex items-center gap-2 text-foreground">
              <Clock className="h-3.5 w-3.5 text-warning" />
              <span className="font-medium">Time-travel snapshot</span>
              <span className="text-muted-foreground">
                from {new Date(replayedAt).toLocaleString()} &mdash; parameters, data, and provenance are frozen to that moment.
              </span>
            </div>
            <Button asChild size="sm" variant="outline" className="h-7 text-xs">
              <Link href={`/reports/${reportId}`}>
                <RotateCcw className="mr-1.5 h-3 w-3" /> Return to live
              </Link>
            </Button>
          </div>
        )}
        {previewAsRole && !replayedAt && (
          <div className="flex items-center justify-between gap-3 border-b border-primary/30 bg-primary-soft px-4 py-2 text-xs">
            <div className="flex items-center gap-2 text-primary-ink">
              <Eye className="h-3.5 w-3.5" />
              <span className="font-medium">Previewing as</span>
              <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[11px]">{previewAsRole}</code>
              <span className="text-muted-foreground">&mdash; role-gated blocks hidden as that reader would see them.</span>
            </div>
            <Button asChild size="sm" variant="outline" className="h-7 text-xs">
              <Link href={`/reports/${reportId}`}>
                <RotateCcw className="mr-1.5 h-3 w-3" /> Back to my view
              </Link>
            </Button>
          </div>
        )}
        {refreshSec && !replayedAt && (
          <div className="flex items-center justify-center gap-2 border-b border-primary/30 bg-primary-soft px-4 py-1.5 text-xs text-primary-ink">
            <RefreshCw className="h-3 w-3 animate-spin-slow" />
            <span className="font-medium">Dashboard mode</span>
            <span className="text-muted-foreground">&mdash; re-runs every {refreshSec}s</span>
          </div>
        )}
        {/* Auto-Curf published banner — appears once after a fresh
            auto-generate that included the public-share toggle. Renders
            its own emerald success styling and self-clears the storage
            key after read. */}
        {!replayedAt && <AutoCurfPublishedBanner />}
        {/* AI-suggested watchers — soft banner above the FilterBar. Hidden
            when there are 0 pending suggestions and the user hasn't asked
            to compute, so the viewer stays uncluttered for happy reports.
            Paid (src/ee/client): absent in Community. */}
        {!replayedAt && WatcherSuggestionsBanner && <WatcherSuggestionsBanner reportId={reportId} />}
        {!replayedAt && (
          // Slow-query alert — appears when avg run time over the last 7
          // days exceeds the threshold. One-click handoff to the MV
          // create form on /tables. Hidden for fast reports + viewers.
          <SlowQueryBanner reportId={reportId} isAdmin={isEditor} />
        )}
        {loading && (
          <div className="flex items-center justify-center gap-2 border-b border-border bg-primary/5 py-1.5 text-xs text-primary">
            <Loader2 className="h-3 w-3 animate-spin" /> Running report&hellip;
          </div>
        )}
        {runError && !loading && (
          <div className="border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs text-foreground">
            <span className="font-semibold">Couldn&apos;t run one or more queries.</span>{" "}
            <span className="text-muted-foreground">{runError.message}</span>{" "}
            <span className="text-muted-foreground">Blocks below show empty data — the report layout still renders so you can edit and re-save.</span>
          </div>
        )}
      </div>
      <div className="mx-auto w-full max-w-[1264px] px-8 pb-12 pt-7">
        {/* Page header — the object's own title, its version and who
            published it, the run receipt, and the actions that belong to
            it (Ask Curf / Share / Export / Edit, plus the editor tools
            behind "more"). The top bar keeps only the global Ask field. */}
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-[.04em] text-muted-foreground">
              <Link href="/reports" className="hover:text-foreground">Reports</Link>
              {tenantName && <span> / {tenantName}</span>}
            </div>
            <h1 className="mt-1 text-[32px] font-semibold leading-[1.15] tracking-[-.015em] text-foreground [text-wrap:balance]">
              {reportName}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-muted-foreground">
              {version != null && (
                <span className="rounded-sm border border-border px-1.5 py-px text-[11px] text-faint">v{version}</span>
              )}
              {(author || publishedAt) && (
                <span>{t("viewer.publishedBy")} {author ?? "—"}{publishedAt ? ` · ${publishedAt}` : ""}</span>
              )}
              {primaryProof && (
                <>
                  <span className="text-faint">·</span>
                  <span className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border-[1.5px] border-success text-success">
                    <Check className="h-2.5 w-2.5" strokeWidth={3} />
                  </span>
                  <span>
                    {t("viewer.verifiedRun")} · sha256 {shortHash(primaryProof.dataHash)} · {totalRows.toLocaleString()} {t("kpi.rows")}
                  </span>
                </>
              )}
            </div>
          </div>
          {/* Not shrink-0: on a narrow viewport this block drops to its own
              row under the title (the outer header is flex-wrap too), and
              without room to shrink it just kept its full natural
              (5-button, unwrapped) width and ran the last button — "more
              tools" — off the edge of the viewport instead of wrapping.
              Letting it shrink lets its own flex-wrap do its job: the
              buttons wrap across two or three short rows that fit. */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Live presence — other tenant members in this report. Hidden
                during time-travel snapshots: presence on a frozen point in
                history isn't a useful concept. */}
            {!replayedAt && (user as any)?.id && (
              <PresenceChip reportId={reportId} selfKey={(user as any).id} />
            )}
            {/* Ask Curf — conversational analysis over this report. Hidden
                during snapshots since the chat would otherwise reason
                against the frozen dataset. */}
            {!replayedAt && AskCurfPanel && <AskCurfPanel reportId={reportId} currentParams={params} />}
            <ShareButton reportId={reportId} />
            {exportMenu}
            {isEditor && (
              <Button asChild size="sm" variant="outline">
                <Link href={`/reports/${reportId}/edit`}>
                  <Pencil className="mr-1.5 h-4 w-4" /> Edit
                </Link>
              </Button>
            )}
            {isEditor && (
              // Editor tools that shouldn't crowd the header: AI-proposed
              // Operate actions (not on a frozen snapshot), publishing to
              // the marketplace, refining from comments. A popover rather
              // than a menu so each tool's own dialog can open from inside.
              <Popover.Root>
                <Popover.Trigger asChild>
                  <Button size="sm" variant="outline" className="w-8 px-0" title={t("viewer.moreTools")} aria-label={t("viewer.moreTools")}>
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    align="end"
                    sideOffset={6}
                    className="z-50 flex w-60 flex-col gap-0.5 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
                  >
                    {!replayedAt && SuggestOperateActionsButton && <SuggestOperateActionsButton reportId={reportId} />}
                    {PublishToMarketplaceButton && <PublishToMarketplaceButton reportId={reportId} reportName={report.name ?? "Untitled"} />}
                    <RegenerateButton reportId={reportId} />
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            )}
          </div>
        </div>

        {!replayedAt && (
          <div className="mt-4">
            <FilterBar
              parameters={report.parameters}
              values={params}
              defaults={paramDefaults}
              loading={loading}
              onApply={applyParams}
              reportId={reportId}
              activeViewId={activeViewId}
              onSelectView={(id) => {
                setActiveViewId(id);
                // Manual URL sync — applyParams handles it on the very next
                // call but selecting "Clear" with no other change wouldn't
                // otherwise touch the bar, so update directly here too.
                if (typeof window !== "undefined") {
                  const here = new URL(window.location.href);
                  if (id) here.searchParams.set("view", id);
                  else here.searchParams.delete("view");
                  window.history.replaceState(null, "", here.pathname + (here.search ? here.search : "") + here.hash);
                }
              }}
            />
          </div>
        )}

        <div className="mt-5">
          <DrillThroughContext.Provider value={openDrill}>
            <ReportDocument
              report={report}
              dataset={dataset}
              params={params}
              provenance={provenance}
              reportDbId={reportId}
              userPrefs={userPrefs}
              tenantBrand={tenantBrand}
              tenantCurrency={tenantCurrency}
              locale={locale}
              surface={reportDisplay(report) === "page" ? "paper" : "canvas"}
            />
          </DrillThroughContext.Provider>
        </div>
      </div>
      <DrillPanel state={drill} onClose={closeDrill} />
      {/* Self-serve onboarding pill. Shows once per browser; user dismisses
          with "Got it, hide" and it stays gone via localStorage flag. */}
      {!IS_COMMUNITY && <WhatIsThisBadge />}
      {/* First-time tour: pulses through proof badge, drill chip, filter
          bar, and the explainer pill in order. Different localStorage flag
          from the badge — they coexist (tour fires once per browser, badge
          stays visible until manually dismissed). */}
      <OnboardingTour />
      </AppShell>
    </OperateActionsProvider>
  );
}
