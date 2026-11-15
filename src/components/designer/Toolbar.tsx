"use client";
/**
 * Toolbar — the designer's document bar: back to Reports, the report's
 * name, undo/redo, then what you do with the whole document (Data, Preview,
 * Run, page setup, Export, Publish, Save). The settings that change rarely
 * (display, year style, theme, schedule, history, story) live in the
 * inspector's Report settings, shown when no block is selected
 * (ReportSettingsPanel); Suggest charts sits with the block palette.
 * Every icon here has a name for screen readers and a tooltip.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Undo2, Redo2, Save, Eye, ChevronRight, ArrowLeft,
  Loader2, Check, Play, PanelTop,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDesignerStore } from "@/lib/reporting/store";
import { useSaveReport, useUnsaved, type SaveState } from "@/lib/reporting/useSaveReport";
import type { CheckItem } from "@/lib/reporting/designerCheck";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DataDrawer } from "./DataDrawer";
import { ReportExportMenu } from "@/components/reports/ReportExportMenu";
import { useT } from "@/lib/i18n/LocaleContext";
import { CurfLogo } from "@/components/common/CurfLogo";
import { eeClient } from "@/ee/client";

const PublishButton = eeClient.designer?.PublishButton ?? null;

export type LastRun = { at: number; durationMs: number; summary?: Record<string, { rows: number }> };

export function Toolbar({
  reportId, onRun, running, lastRun, pageSetupOpen, onTogglePageSetup, checkItems,
}: {
  reportId: string;
  /** What the report check says now: the Publish review lists it. */
  checkItems: CheckItem[];
  onRun: () => void;
  running: boolean;
  lastRun: LastRun | null;
  pageSetupOpen: boolean;
  onTogglePageSetup: () => void;
}) {
  const router = useRouter();
  const name = useDesignerStore((s) => s.report.name);
  const setMeta = useDesignerStore((s) => s.updateReportMeta);
  const report = useDesignerStore((s) => s.report);
  const { t } = useT();
  const { state: saveState, save } = useSaveReport(reportId);
  const unsaved = useUnsaved();
  // Leaving with edits that are not saved asks first (the back link and the logo; a closed tab asks through the browser).
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);
  const guard = (href: string) => (e: React.MouseEvent) => {
    if (!unsaved) return;
    e.preventDefault();
    setLeaveTo(href);
  };

  const undo = () => useDesignerStore.temporal.getState().undo();
  const redo = () => useDesignerStore.temporal.getState().redo();

  // The last run's query count and time ride on Run's tooltip, so they are
  // there even while the page-setup row is hidden.
  const runTitle = lastRun
    ? `${t("designer.runTooltip")} · ${t("designerShell.queriesSummary")
        .replace("{n}", String(Object.keys(lastRun.summary ?? {}).length))
        .replace("{ms}", String(lastRun.durationMs))}`
    : t("designer.runTooltip");
  const pageSetupLabel = t(pageSetupOpen ? "designer.pageSetup.hide" : "designer.pageSetup.show");

  // The actions wrap onto a second line before they squeeze the report's
  // name to nothing on a narrow window.
  return (
    <header className="flex flex-wrap items-center justify-between gap-y-1.5 border-b border-border bg-background px-4 py-2">
      <div className="flex min-w-0 shrink items-center gap-2">
        <Button
          asChild
          size="sm"
          variant="ghost"
          className="h-8 -ml-1 text-muted-foreground hover:text-foreground"
          title={t("designerToolbar.backToReports")}
        >
          <Link href="/reports" onClick={guard("/reports")}>
            <ArrowLeft className="mr-1.5 h-4 w-4" /> {t("nav.reports")}
          </Link>
        </Button>
        <div className="hidden items-center gap-2 sm:flex">
          <span className="text-muted-foreground/50" aria-hidden>/</span>
          <Link href="/" onClick={guard("/")} className="flex items-center" title="Curf" aria-label="Curf">
            <CurfLogo variant="icon" size={22} />
          </Link>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" aria-hidden />
        </div>
        <Input
          value={name}
          onChange={(e) => setMeta({ name: e.target.value })}
          aria-label={t("designer.nameLabel")}
          title={t("designer.nameLabel")}
          className="h-8 w-56 min-w-0 border-transparent bg-transparent text-sm font-medium shadow-none focus-visible:border-input focus-visible:bg-background xl:w-72"
        />
        <SaveIndicator state={saveState} />
      </div>

      {/* On a phone the actions are one scrolling row (Save stays reachable) instead of three wrapped rows. */}
      <div className="flex w-full flex-nowrap items-center justify-start gap-1 overflow-x-auto pb-0.5 [&>*]:shrink-0 sm:w-auto sm:flex-wrap sm:justify-end sm:overflow-visible sm:pb-0">
        <div className="mr-1 flex items-center gap-0.5">
          <Button size="icon" variant="ghost" onClick={undo} title={t("designer.undoTooltip")} aria-label={t("designerToolbar.undo")}>
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={redo} title={t("designer.redoTooltip")} aria-label={t("designerToolbar.redo")}>
            <Redo2 className="h-4 w-4" />
          </Button>
        </div>
        <DataDrawer />
        <Button size="sm" variant="ghost" asChild title={t("designer.previewTooltip")}>
          <Link href={"/reports/" + reportId} target="_blank">
            <Eye className="mr-1.5 h-4 w-4" />{t("designerToolbar.preview")}
          </Link>
        </Button>
        <Button size="sm" variant="ghost" onClick={onRun} disabled={running} title={runTitle} aria-busy={running}>
          {running
            ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />{t("designerShell.running")}</>
            : <><Play className="mr-1.5 h-4 w-4" />{t("designerShell.run")}</>}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onTogglePageSetup}
          title={pageSetupLabel}
          aria-label={pageSetupLabel}
          aria-pressed={pageSetupOpen}
          aria-controls="designer-page-setup"
          className={pageSetupOpen ? "text-foreground" : "text-muted-foreground"}
        >
          <PanelTop className="h-4 w-4 2xl:mr-1.5" /><span className="hidden 2xl:inline">{t("designer.pageSetup.label")}</span>
        </Button>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <ReportExportMenu reportId={reportId} />
        {PublishButton && <PublishButton reportId={reportId} checkItems={checkItems} />}
        <Button size="sm" onClick={() => void save()} disabled={saveState === "saving"} title={t("designer.saveTooltip")}>
          {saveState === "saving" ? (
            <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> {t("common.saving")}</>
          ) : (
            <><Save className="mr-1.5 h-4 w-4" /> {t("action.save")}</>
          )}
        </Button>
      </div>
      <Dialog open={leaveTo !== null} onOpenChange={(o) => { if (!o && !leaving) setLeaveTo(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("designerLeave.title")}</DialogTitle>
            <DialogDescription>{t("designerLeave.body")}</DialogDescription>
          </DialogHeader>
          <DialogBody />
          <DialogFooter>
            <Button variant="ghost" disabled={leaving} onClick={() => setLeaveTo(null)}>{t("designerLeave.stay")}</Button>
            <Button variant="outline" disabled={leaving} onClick={() => { const to = leaveTo; setLeaveTo(null); if (to) router.push(to); }}>{t("designerLeave.discard")}</Button>
            <Button
              disabled={leaving}
              onClick={async () => {
                setLeaving(true);
                const ok = await save();
                setLeaving(false);
                if (ok && leaveTo) { const to = leaveTo; setLeaveTo(null); router.push(to); }
              }}
            >
              {leaving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}{t("designerLeave.saveLeave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const { t } = useT();
  if (state === "idle") return null;
  if (state === "saving") return (
    <span className="ml-1 inline-flex items-center gap-1 text-2xs text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" /> {t("common.saving")}
    </span>
  );
  if (state === "saved") return (
    <span className="ml-1 inline-flex items-center gap-1 text-2xs text-success">
      <Check className="h-3 w-3" /> {t("common.saved")}
    </span>
  );
  return <span className="ml-1 text-2xs text-destructive">{t("common.saveFailed")}</span>;
}
