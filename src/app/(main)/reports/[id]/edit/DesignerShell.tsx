"use client";
import { useCallback, useEffect, useState } from "react";
import { SlidersHorizontal, Ruler, Keyboard, Languages, ShieldAlert, Save, Loader2 } from "lucide-react";
import type { Report } from "@/lib/reporting/schema";
import type { Dataset } from "@/lib/reporting/interpolate";
import { useDesignerStore } from "@/lib/reporting/store";
import { BlockPalette } from "@/components/designer/BlockPalette";
import { Canvas } from "@/components/designer/Canvas";
import { PropertyPanel } from "@/components/designer/PropertyPanel";
import { Toolbar, type LastRun } from "@/components/designer/Toolbar";
import { PageTabs } from "@/components/designer/PageTabs";
import { ShortcutsOverlay } from "@/components/designer/ShortcutsOverlay";
import { CheckPanel, useCheckItems } from "@/components/designer/CheckPanel";
import { eeClient } from "@/ee/client";
import { markSaved, useSaveReport, useUnsaved } from "@/lib/reporting/useSaveReport";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n/LocaleContext";

/** The Assistant tab proposes changes through Master Builder's block operations (paid); Community has no such tab. */
const AssistantPanel = eeClient.designer?.AssistantPanel ?? null;
const RIGHT_TABS: ReadonlyArray<"block" | "check" | "assistant"> = AssistantPanel ? ["block", "check", "assistant"] : ["block", "check"];

const PAGE_SETUP_KEY = "curf.designer.pageSetupOpen";

export function DesignerShell({
  reportId, initialReport, initialParams, initialDataset, tenantBrand,
}: {
  reportId: string;
  initialReport: Report;
  initialParams: Record<string, unknown>;
  initialDataset: Dataset;
  /** Workspace theme + chart-style fallbacks, so the canvas previews what the viewer renders. */
  tenantBrand?: { defaultTheme?: string; defaultChartStyle?: string; customPalette?: string[] };
}) {
  const setReport = useDesignerStore((s) => s.setReport);
  const liveReport = useDesignerStore((s) => s.report);
  const configModalOpen = useDesignerStore((s) => s.configModalOpen);
  const setConfigModalOpen = useDesignerStore((s) => s.setConfigModalOpen);
  const { push } = useToast();
  const { t } = useT();

  const [params, setParams] = useState<Record<string, unknown>>(initialParams);
  const [dataset, setDataset] = useState<Dataset>(initialDataset);
  const [running, setRunning] = useState(false);
  const [showRulers, setShowRulers] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  // Read the page as a reader in another content language sees it ("" = as written).
  const [readAs, setReadAs] = useState("");
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  // The right panel is the selected block's properties, or the report check (what the gate would say about this page).
  const [rightTab, setRightTab] = useState<"block" | "check" | "assistant">("block");
  const checkItems = useCheckItems(dataset);
  const unsaved = useUnsaved();
  const { state: saveState, save } = useSaveReport(reportId);
  // The page-setup row can be hidden for more canvas; remembered per browser.
  // Read after mount (not in the initializer) so the server render matches.
  const [pageSetupOpen, setPageSetupOpen] = useState(true);
  useEffect(() => {
    try { if (localStorage.getItem(PAGE_SETUP_KEY) === "0") setPageSetupOpen(false); } catch { /* storage blocked: stay open */ }
  }, []);
  const togglePageSetup = useCallback(() => {
    setPageSetupOpen((open) => {
      try { localStorage.setItem(PAGE_SETUP_KEY, open ? "0" : "1"); } catch { /* per-visit then */ }
      return !open;
    });
  }, []);

  useEffect(() => {
    setParams((prev) => {
      const next: Record<string, unknown> = {};
      for (const p of liveReport.parameters ?? []) {
        next[p.name] = prev[p.name] ?? p.default ?? "";
      }
      return next;
    });
  }, [liveReport.parameters]);

  const runPreview = useCallback(async () => {
    setRunning(true);
    try {
      const res = await fetch("/api/reports/preview-dataset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ report: useDesignerStore.getState().report, params }),
      });
      const json = await res.json();
      if (!res.ok) {
        push({ variant: "destructive", title: t("designerShell.runFailed"), description: json.error ?? t("designerShell.unknownError") });
        return;
      }
      setDataset(json.dataset ?? {});
      setLastRun({ at: Date.now(), durationMs: json.durationMs ?? 0, summary: json.summary });
      const totalRows = Object.values(json.summary ?? {}).reduce((s: number, v: any) => s + (v?.rows ?? 0), 0);
      push({
        variant: "success",
        title: t("designerShell.datasetRefreshed").replace("{n}", String(totalRows)).replace("{m}", String(Object.keys(json.summary ?? {}).length)),
        description: json.durationMs + "ms",
      });
    } catch (e: any) {
      push({ variant: "destructive", title: t("designerShell.runFailed"), description: e?.message ?? t("ask.networkError") });
    } finally {
      setRunning(false);
    }
  }, [params, push, t]);

  useEffect(() => {
    setReport(initialReport);
    markSaved(initialReport);
    useDesignerStore.temporal.getState().clear();
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditable = !!target && (
        target.tagName === "INPUT" || target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" || target.isContentEditable
      );
      const meta = e.metaKey || e.ctrlKey;
      const store = useDesignerStore.getState();
      const temporal = useDesignerStore.temporal.getState();
      if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); temporal.undo(); return; }
      if (meta && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); temporal.redo(); return; }
      if (meta && e.key.toLowerCase() === "r") { e.preventDefault(); runPreview(); return; }
      if (inEditable) return;
      // ? (Shift+/) opens the cheatsheet. Skip when modifiers held.
      if (e.key === "?" && !meta && !e.altKey) { e.preventDefault(); setShowShortcuts((v) => !v); return; }
      if (meta && e.key.toLowerCase() === "d" && store.selectedBlockId) { e.preventDefault(); store.duplicateBlock(store.selectedBlockId); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && store.selectedBlockId) { e.preventDefault(); store.removeBlock(store.selectedBlockId); return; }
      if (e.key === "Escape") { store.selectBlock(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Two bars at most above the canvas: the document bar (Toolbar) and a
  // slim page-setup row the author can hide. minmax(0,…) on the grid: a wide
  // canvas (a 1920px "Dashboard" page) scrolls inside its column instead of
  // stretching the whole designer — and the side panels — past the window.
  return (
    <div className="flex h-screen flex-col bg-background">
      <Toolbar
        reportId={reportId}
        onRun={runPreview}
        running={running}
        lastRun={lastRun}
        pageSetupOpen={pageSetupOpen}
        onTogglePageSetup={togglePageSetup}
        checkItems={checkItems}
      />
      {pageSetupOpen && (
        <PageSetupRow
          report={liveReport}
          params={params}
          onChangeParam={(name, value) => setParams((p) => ({ ...p, [name]: value }))}
          lastRun={lastRun}
          showRulers={showRulers}
          onToggleRulers={setShowRulers}
          onShowShortcuts={() => setShowShortcuts(true)}
          readAs={readAs}
          onReadAs={setReadAs}
        />
      )}
      {/* A phone stacks the three columns: the page first, then the block palette and the panel below it. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:grid md:grid-cols-[240px_minmax(0,1fr)_340px] md:overflow-hidden">
        <aside className="order-2 shrink-0 border-t border-border bg-sidebar md:order-none md:overflow-y-auto md:border-r md:border-t-0">
          <BlockPalette reportId={reportId} />
        </aside>
        <main className="designer-canvas order-1 h-[60vh] shrink-0 overflow-auto p-3 md:order-none md:h-auto md:p-8">
          <Canvas dataset={dataset} params={params} showRulers={showRulers} reportDbId={reportId} tenantBrand={tenantBrand} readAs={readAs || undefined} />
        </main>
        <aside id="designer-right" className="order-3 flex shrink-0 flex-col border-t border-border bg-background md:order-none md:overflow-y-auto md:border-l md:border-t-0">
          <div role="tablist" className="sticky top-0 z-10 flex gap-4 border-b border-border bg-background px-4">
            {RIGHT_TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={rightTab === tab}
                onClick={() => setRightTab(tab)}
                className={`-mb-px flex items-center gap-1.5 border-b-2 py-2.5 text-xs ${rightTab === tab ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              >
                {t(tab === "block" ? "designerCheck.tabBlock" : tab === "check" ? "designerCheck.tabCheck" : "designerAssist.tab")}
                {tab === "check" && checkItems.length > 0 && (
                  <span className="rounded-full bg-warning/15 px-1.5 font-mono text-2xs text-warning">{checkItems.length}</span>
                )}
              </button>
            ))}
          </div>
          {rightTab === "block" ? <PropertyPanel dataset={dataset} reportId={reportId} /> : rightTab === "check" ? <CheckPanel items={checkItems} dataset={dataset} onDataset={setDataset} /> : AssistantPanel ? <AssistantPanel reportId={reportId} onApplied={() => void runPreview()} /> : null}
        </aside>
      </div>
      {/* Phone bar: what needs attention and the one thing to do with the page, always in reach. */}
      <div className="flex items-center gap-2 border-t border-border bg-background px-3 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] md:hidden">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => { setRightTab("check"); document.getElementById("designer-right")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
        >
          <ShieldAlert className={`h-4 w-4 ${checkItems.length > 0 ? "text-warning" : "text-muted-foreground"}`} aria-hidden />
          {t("designerCheck.tabCheck")}
          {checkItems.length > 0 && <span className="rounded-full bg-warning/15 px-1.5 font-mono text-2xs text-warning">{checkItems.length}</span>}
        </Button>
        {unsaved && <span className="text-2xs text-muted-foreground">{t("designerLeave.unsavedShort")}</span>}
        <Button size="sm" className="ml-auto" onClick={() => void save()} disabled={saveState === "saving" || !unsaved}>
          {saveState === "saving" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
          {t("action.save")}
        </Button>
      </div>
      <ShortcutsOverlay open={showShortcuts} onClose={() => setShowShortcuts(false)} />

      {/* Config Modal (Double-click triggered) */}
      <Dialog open={configModalOpen} onOpenChange={setConfigModalOpen}>
        <DialogContent className="max-w-[400px] h-[80vh] flex flex-col p-0">
          <PropertyPanel dataset={dataset} reportId={reportId} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The page-setup row: page size and orientation, rulers, the report's pages,
 * the parameter values the canvas previews with, and the shortcuts sheet.
 * Hidden or shown from the document bar; the choice is remembered per browser.
 */
function PageSetupRow({
  report, params, onChangeParam, lastRun,
  showRulers, onToggleRulers, onShowShortcuts, readAs, onReadAs,
}: {
  readAs: string;
  onReadAs: (v: string) => void;
  report: Report;
  params: Record<string, unknown>;
  onChangeParam: (name: string, value: unknown) => void;
  lastRun: LastRun | null;
  showRulers: boolean;
  onToggleRulers: (v: boolean) => void;
  onShowShortcuts: () => void;
}) {
  const { t } = useT();
  const hasParams = (report.parameters ?? []).length > 0;
  // Size and orientation belong to the page on screen, not always the first
  // one; the store patches it in place so the active tab and selection stay.
  const activePageId = useDesignerStore((s) => s.activePageId);
  const patchPage = useDesignerStore((s) => s.updateActivePage);
  const page = report.pages.find((p) => p.id === activePageId) ?? report.pages[0];

  return (
    <div
      id="designer-page-setup"
      role="toolbar"
      aria-label={t("designer.pageSetup.label")}
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-muted/30 px-4 py-1.5"
    >
      <div className="flex items-center gap-1">
        <Select value={page?.size ?? "A4"} onValueChange={(v) => patchPage({ size: v as any })}>
          <SelectTrigger className="h-7 w-20 text-xs" aria-label={t("designer.pageSetup.size")} title={t("designer.pageSetup.size")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="A4">A4</SelectItem>
            <SelectItem value="Letter">Letter</SelectItem>
            <SelectItem value="Legal">Legal</SelectItem>
          </SelectContent>
        </Select>
        <Select value={page?.orientation ?? "portrait"} onValueChange={(v) => patchPage({ orientation: v as any })}>
          <SelectTrigger className="h-7 w-28 text-xs" aria-label={t("designer.pageSetup.orientation")} title={t("designer.pageSetup.orientation")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="portrait">{t("designerShell.portrait")}</SelectItem>
            <SelectItem value="landscape">{t("designerShell.landscape")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <label
        className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-2xs text-foreground hover:bg-accent"
        title={t("designer.pageSetup.rulersTooltip")}
      >
        <input
          type="checkbox"
          checked={showRulers}
          onChange={(e) => onToggleRulers(e.target.checked)}
          className="h-3 w-3 accent-[hsl(var(--primary))]"
        />
        <Ruler className="h-3 w-3" aria-hidden />
        {t("designerShell.rulers")}
      </label>
      <div className="flex items-center gap-1" title={t("designerReadAs.tooltip")}>
        <Languages className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <Select value={readAs || "as-written"} onValueChange={(v) => onReadAs(v === "as-written" ? "" : v)}>
          <SelectTrigger className="h-7 w-32 text-xs" aria-label={t("designerReadAs.label")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="as-written">{t("designerReadAs.asWritten")}</SelectItem>
            <SelectItem value="en">{t("designerReadAs.en")}</SelectItem>
            <SelectItem value="th">{t("designerReadAs.th")}</SelectItem>
            <SelectItem value="zh">{t("designerReadAs.zh")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <span className="h-5 w-px bg-border" aria-hidden />
      <PageTabs />
      {hasParams && (
        <>
          <span className="h-5 w-px bg-border" aria-hidden />
          <div className="flex flex-wrap items-center gap-2" title={t("designer.previewValuesHint")}>
            <span className="flex items-center gap-1 text-2xs text-muted-foreground">
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
              {t("designer.previewValues")}
            </span>
            {report.parameters.map((p) => (
              <div key={p.name} className="flex items-center gap-1.5">
                <Label htmlFor={"designer-param-" + p.name} className="whitespace-nowrap text-2xs">{p.label}</Label>
                <Input
                  id={"designer-param-" + p.name}
                  type={p.type === "date" ? "date" : p.type === "number" ? "number" : "text"}
                  value={String(params[p.name] ?? "")}
                  onChange={(e) => onChangeParam(p.name, e.target.value)}
                  className="h-7 w-36 text-xs"
                />
              </div>
            ))}
          </div>
        </>
      )}
      <div className="ml-auto flex items-center gap-2">
        {lastRun && (
          <span className="font-mono text-2xs text-muted-foreground">
            {t("designerShell.queriesSummary").replace("{n}", String(Object.keys(lastRun.summary ?? {}).length)).replace("{ms}", String(lastRun.durationMs))}
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={onShowShortcuts}
          title={t("designerShell.shortcutsTooltip")}
          aria-label={t("designerShell.shortcutsTooltip")}
          className="h-7 px-2 text-2xs"
        >
          <Keyboard className="h-3.5 w-3.5 xl:mr-1" /><span className="hidden xl:inline">{t("designer.shortcuts")}</span>
        </Button>
      </div>
    </div>
  );
}
