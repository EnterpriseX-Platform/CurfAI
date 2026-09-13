"use client";
import { useCallback, useEffect, useState } from "react";
import { Loader2, Play, SlidersHorizontal, Ruler, Keyboard } from "lucide-react";
import type { Report } from "@/lib/reporting/schema";
import type { Dataset } from "@/lib/reporting/interpolate";
import { useDesignerStore } from "@/lib/reporting/store";
import { BlockPalette } from "@/components/designer/BlockPalette";
import { Canvas } from "@/components/designer/Canvas";
import { PropertyPanel } from "@/components/designer/PropertyPanel";
import { Toolbar } from "@/components/designer/Toolbar";
import { PageTabs } from "@/components/designer/PageTabs";
import { ShortcutsOverlay } from "@/components/designer/ShortcutsOverlay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n/LocaleContext";

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
  const [lastRun, setLastRun] = useState<{ at: number; durationMs: number; summary?: Record<string, { rows: number }> } | null>(null);

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
        body: JSON.stringify({ report: liveReport, params }),
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
  }, [liveReport, params, push, t]);

  useEffect(() => {
    setReport(initialReport);
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

  return (
    <div className="grid h-screen grid-rows-[auto_auto_auto_1fr] bg-background">
      <Toolbar reportId={reportId} />
      <DesignParameterBar
        report={liveReport}
        params={params}
        onChangeParam={(name, value) => setParams((p) => ({ ...p, [name]: value }))}
        onRun={runPreview}
        running={running}
        lastRun={lastRun}
        showRulers={showRulers}
        onToggleRulers={setShowRulers}
        onShowShortcuts={() => setShowShortcuts(true)}
      />
      <PageTabs />
      <div className="grid grid-cols-[240px_1fr_340px] overflow-hidden">
        <aside className="overflow-y-auto border-r border-border bg-sidebar">
          <BlockPalette />
        </aside>
        <main className="designer-canvas overflow-auto p-8">
          <Canvas dataset={dataset} params={params} showRulers={showRulers} reportDbId={reportId} tenantBrand={tenantBrand} />
        </main>
        <aside className="overflow-y-auto border-l border-border bg-background">
          <PropertyPanel dataset={dataset} />
        </aside>
      </div>
      <ShortcutsOverlay open={showShortcuts} onClose={() => setShowShortcuts(false)} />

      {/* Config Modal (Double-click triggered) */}
      <Dialog open={configModalOpen} onOpenChange={setConfigModalOpen}>
        <DialogContent className="max-w-[400px] h-[80vh] flex flex-col p-0">
          <PropertyPanel dataset={dataset} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DesignParameterBar({
  report, params, onChangeParam, onRun, running, lastRun,
  showRulers, onToggleRulers, onShowShortcuts,
}: {
  report: Report;
  params: Record<string, unknown>;
  onChangeParam: (name: string, value: unknown) => void;
  onRun: () => void;
  running: boolean;
  lastRun: { at: number; durationMs: number; summary?: Record<string, { rows: number }> } | null;
  showRulers: boolean;
  onToggleRulers: (v: boolean) => void;
  onShowShortcuts: () => void;
}) {
  const { t } = useT();
  const hasParams = (report.parameters ?? []).length > 0;
  const setReport = useDesignerStore((s) => s.setReport);
  const page = report.pages[0];

  function patchPage(patch: Partial<{ size: "A4" | "Letter" | "Legal"; orientation: "portrait" | "landscape" }>) {
    const next = { ...report, pages: report.pages.map((p, i) => i === 0 ? { ...p, ...patch } : p) };
    setReport(next);
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-muted/30 px-4 py-2">
      {hasParams && (
        <>
          <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
          {report.parameters.map((p) => (
            <div key={p.name} className="flex items-center gap-1.5">
              <Label className="whitespace-nowrap text-[11px]">{p.label}</Label>
              <Input
                type={p.type === "date" ? "date" : p.type === "number" ? "number" : "text"}
                value={String(params[p.name] ?? "")}
                onChange={(e) => onChangeParam(p.name, e.target.value)}
                className="h-7 w-36 text-xs"
              />
            </div>
          ))}
        </>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Label className="text-[11px]">{t("designerShell.pageLabel")}</Label>
          <Select value={page?.size ?? "A4"} onValueChange={(v) => patchPage({ size: v as any })}>
            <SelectTrigger className="h-7 w-20 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="A4">A4</SelectItem>
              <SelectItem value="Letter">Letter</SelectItem>
              <SelectItem value="Legal">Legal</SelectItem>
            </SelectContent>
          </Select>
          <Select value={page?.orientation ?? "portrait"} onValueChange={(v) => patchPage({ orientation: v as any })}>
            <SelectTrigger className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="portrait">{t("designerShell.portrait")}</SelectItem>
              <SelectItem value="landscape">{t("designerShell.landscape")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground hover:bg-accent">
          <input
            type="checkbox"
            checked={showRulers}
            onChange={(e) => onToggleRulers(e.target.checked)}
            className="h-3 w-3 accent-[hsl(var(--primary))]"
          />
          <Ruler className="h-3 w-3" />
          {t("designerShell.rulers")}
        </label>
        {lastRun && (
          <span className="text-[11px] text-muted-foreground">
            {t("designerShell.queriesSummary").replace("{n}", String(Object.keys(lastRun.summary ?? {}).length)).replace("{ms}", String(lastRun.durationMs))}
          </span>
        )}
        <Button size="sm" variant="outline" onClick={onRun} disabled={running} title={t("designerShell.refreshTooltip")}>
          {running
            ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> {t("designerShell.running")}</>
            : <><Play className="mr-1.5 h-4 w-4" /> {t("designerShell.run")}</>}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={onShowShortcuts}
          title={t("designerShell.shortcutsTooltip")}
          className="h-7 w-7"
        >
          <Keyboard className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
