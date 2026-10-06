"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Undo2, Redo2, Save, Eye, ChevronRight, ArrowLeft,
  Loader2, Check, FileText, History, Clock, Palette, Sparkles,
  LayoutDashboard, CalendarDays,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDesignerStore } from "@/lib/reporting/store";
import { DataDrawer } from "./DataDrawer";
import { ScheduleDrawer } from "./ScheduleDrawer";
import { ReportExportMenu } from "@/components/reports/ReportExportMenu";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n/LocaleContext";
import { CurfLogo } from "@/components/common/CurfLogo";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { THEME_PRESETS } from "@/lib/reporting/themes";
import { reportDisplay, type Theme, type ReportDisplay } from "@/lib/reporting/schema";
import { eeClient } from "@/ee/client";

const PublishButton = eeClient.designer?.PublishButton ?? null;
const SuggestChartButton = eeClient.designer?.SuggestChartButton ?? null;
const STORY_MODE = !!eeClient.designer?.storyMode;

type SaveState = "idle" | "saving" | "saved" | "error";

export function Toolbar({ reportId }: { reportId: string }) {
  const router = useRouter();
  const name = useDesignerStore((s) => s.report.name);
  const setMeta = useDesignerStore((s) => s.updateReportMeta);
  const report = useDesignerStore((s) => s.report);
  const { push } = useToast();
  const { t } = useT();
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const undo = () => useDesignerStore.temporal.getState().undo();
  const redo = () => useDesignerStore.temporal.getState().redo();

  async function save() {
    setSaveState("saving");
    const res = await fetch("/api/reports/" + reportId, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ definition: report }),
    });
    if (!res.ok) {
      setSaveState("error");
      // A tier-gated field (e.g. a non-default theme — see ThemePicker's
      // "click→save→toast is the upgrade nudge" design) fails here with a
      // structured 402 body, not plain text. The raw response text used to
      // get dumped straight into the toast; read it once, try to parse it
      // as the {error, upgradeUrl} shape the rest of the app uses, and fall
      // back to the raw text only when it genuinely isn't JSON.
      const raw = await res.text();
      let description = raw || t("common.requestFailed");
      try {
        const json = JSON.parse(raw);
        description = json?.upgradeUrl
          ? t("designerToolbar.upgradeAt")
              .replace("{error}", json.error ?? t("common.requestFailed"))
              .replace("{url}", json.upgradeUrl)
          : json?.error ?? description;
      } catch { /* not JSON — keep the raw text */ }
      push({ variant: "destructive", title: t("common.saveFailed"), description });
      return;
    }
    setSaveState("saved");
    push({ variant: "success", title: t("common.saved"), description: t("designerToolbar.reportUpdated") });
    router.refresh();
    setTimeout(() => setSaveState("idle"), 1500);
  }

  // The actions wrap onto a second row before they squeeze the report's
  // name to nothing (they need ~1460px; a laptop has 1280–1440).
  return (
    <header className="flex flex-wrap items-center justify-between gap-y-1.5 border-b border-border bg-background/90 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="flex shrink-0 items-center gap-2">
        <Button
          asChild
          size="sm"
          variant="ghost"
          className="h-8 -ml-1 text-muted-foreground hover:text-foreground"
          title={t("designerToolbar.backToReports")}
        >
          <Link href="/reports">
            <ArrowLeft className="mr-1.5 h-4 w-4" /> {t("nav.reports")}
          </Link>
        </Button>
        <div className="hidden items-center gap-2 sm:flex">
          <span className="text-muted-foreground/50">/</span>
          <Link
            href="/"
            className="flex items-center"
            title="Curf"
          >
            <CurfLogo variant="icon" size={22} />
          </Link>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
        </div>
        <Input
          value={name}
          onChange={(e) => setMeta({ name: e.target.value })}
          className="h-8 w-64 border-transparent bg-transparent text-sm font-medium shadow-none focus-visible:border-input focus-visible:bg-background"
        />
        <SaveIndicator state={saveState} />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-1">
        <div className="mr-1 flex items-center gap-0.5">
          <Button size="icon" variant="ghost" onClick={undo} title={t("designerToolbar.undo")}>
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={redo} title={t("designerToolbar.redo")}>
            <Redo2 className="h-4 w-4" />
          </Button>
        </div>
        <DataDrawer />
        {SuggestChartButton && <SuggestChartButton reportId={reportId} />}
        <DisplayPicker />
        <YearsPicker />
        <ThemePicker />
        {/* Secondary actions show their label on wide screens only — the icon
            and tooltip carry them on a laptop, so the bar fits beside the name. */}
        <Button size="sm" variant="ghost" onClick={() => setScheduleOpen(true)} title={t("designerToolbar.scheduleTooltip")} aria-label={t("designerToolbar.schedule")}>
          <Clock className="h-4 w-4 2xl:mr-1.5" /><span className="hidden 2xl:inline">{t("designerToolbar.schedule")}</span>
        </Button>
        <Button size="sm" variant="ghost" asChild title={t("reportHistory.breadcrumb")}>
          <Link href={"/reports/" + reportId + "/history"} aria-label={t("reportHistory.breadcrumb")}>
            <History className="h-4 w-4 2xl:mr-1.5" /><span className="hidden 2xl:inline">{t("reportHistory.breadcrumb")}</span>
          </Link>
        </Button>
        <Button size="sm" variant="ghost" asChild title={t("designerToolbar.preview")}>
          <Link href={"/reports/" + reportId} target="_blank" aria-label={t("designerToolbar.preview")}>
            <Eye className="h-4 w-4 2xl:mr-1.5" /><span className="hidden 2xl:inline">{t("designerToolbar.preview")}</span>
          </Link>
        </Button>
        {PublishButton && <PublishButton reportId={reportId} />}
        {/* Story Mode — Business plan. On Cloud the page enforces the tier
            gate (renders an upgrade card below Business) so the button stays
            visible as a discovery affordance; Community has no story page. */}
        {STORY_MODE && (
          <Button size="sm" variant="ghost" asChild title={t("designerToolbar.storyTooltip")}>
            <Link href={"/reports/" + reportId + "/story"} target="_blank" aria-label={t("designerToolbar.story")}>
              <Sparkles className="h-4 w-4 2xl:mr-1.5" /><span className="hidden 2xl:inline">{t("designerToolbar.story")}</span>
            </Link>
          </Button>
        )}
        <ReportExportMenu reportId={reportId} />
        <Button size="sm" onClick={save} disabled={saveState === "saving"}>
          {saveState === "saving" ? (
            <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> {t("common.saving")}</>
          ) : (
            <><Save className="mr-1.5 h-4 w-4" /> {t("action.save")}</>
          )}
        </Button>
      </div>
      <ScheduleDrawer
        reportId={reportId}
        reportName={name || t("common.untitled")}
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
      />
    </header>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const { t } = useT();
  if (state === "idle") return null;
  if (state === "saving") return (
    <span className="ml-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" /> {t("common.saving")}
    </span>
  );
  if (state === "saved") return (
    <span className="ml-1 inline-flex items-center gap-1 text-[11px] text-success">
      <Check className="h-3 w-3" /> {t("common.saved")}
    </span>
  );
  return <span className="ml-1 text-[11px] text-destructive">{t("common.saveFailed")}</span>;
}

/**
 * DisplayPicker — how the viewer lays the report out: full-width dashboard
 * grid, or the A4 / Letter sheets it prints as. Exports and the designer
 * canvas always use the sheets; this only changes the interactive viewer.
 */
const DISPLAY_OPTIONS: Array<{ value: ReportDisplay; labelKey: string; descriptionKey: string; Icon: typeof LayoutDashboard }> = [
  { value: "dashboard", labelKey: "designerToolbar.display.dashboard", descriptionKey: "designerToolbar.display.dashboardDesc", Icon: LayoutDashboard },
  { value: "page",      labelKey: "designerShell.pageLabel",           descriptionKey: "designerToolbar.display.pageDesc",      Icon: FileText },
];

function DisplayPicker() {
  const { t } = useT();
  const report = useDesignerStore((s) => s.report);
  const setMeta = useDesignerStore((s) => s.updateReportMeta);
  const current = DISPLAY_OPTIONS.find((o) => o.value === reportDisplay(report)) ?? DISPLAY_OPTIONS[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" title={t("designerToolbar.displayTooltip")}>
          <current.Icon className="mr-1.5 h-4 w-4" />
          <span className="text-muted-foreground">{t("designerToolbar.displayLabel")}</span>&nbsp;{t(current.labelKey)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {DISPLAY_OPTIONS.map((o) => (
          <DropdownMenuItem key={o.value} onClick={() => setMeta({ display: o.value })} className="flex items-start gap-2">
            <o.Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">
              <span className="block text-sm font-medium">{t(o.labelKey)}</span>
              <span className="block text-[10px] leading-tight text-muted-foreground">{t(o.descriptionKey)}</span>
            </span>
            {current.value === o.value && <Check className="mt-0.5 h-3.5 w-3.5 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * YearsPicker — how this report writes years for Thai readers. "Reader's
 * choice" (unset) follows each reader's Account preference; locking it to
 * พ.ศ. or ค.ศ. makes every reader, and every PDF and Excel file, show the
 * same year — what a regulatory or board report needs. Report.dateEra.
 */
const YEARS_OPTIONS: Array<{ value: "be" | "ce" | undefined; labelKey: string; descriptionKey: string }> = [
  { value: undefined, labelKey: "designerToolbar.years.reader", descriptionKey: "designerToolbar.years.readerDesc" },
  { value: "be",      labelKey: "designerToolbar.years.be",     descriptionKey: "designerToolbar.years.beDesc" },
  { value: "ce",      labelKey: "designerToolbar.years.ce",     descriptionKey: "designerToolbar.years.ceDesc" },
];

function YearsPicker() {
  const { t } = useT();
  const report = useDesignerStore((s) => s.report);
  const setMeta = useDesignerStore((s) => s.updateReportMeta);
  const current = YEARS_OPTIONS.find((o) => o.value === report.dateEra) ?? YEARS_OPTIONS[0]!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" title={t("designerToolbar.years.tooltip")}>
          <CalendarDays className="mr-1.5 h-4 w-4" />
          <span className="text-muted-foreground">{t("designerToolbar.years.label")}</span>&nbsp;{t(current.labelKey)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {YEARS_OPTIONS.map((o) => (
          <DropdownMenuItem key={o.value ?? "reader"} onClick={() => setMeta({ dateEra: o.value })} className="flex items-start gap-2">
            <span className="flex-1">
              <span className="block text-sm font-medium">{t(o.labelKey)}</span>
              <span className="block text-[10px] leading-tight text-muted-foreground">{t(o.descriptionKey)}</span>
            </span>
            {current.value === o.value && <Check className="mt-0.5 h-3.5 w-3.5 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * ThemePicker — opens a swatch dropdown of available theme presets and
 * sets `report.theme` on the designer store. Server-side, the save endpoint
 * gates `viz.theme_presets` (Team) — picking a non-default theme on Free
 * will fail at save time with a 402 surfaced as a destructive toast. We
 * deliberately keep the picker visible to everyone so Free users see what
 * they could unlock; the click→save→toast flow is the upgrade nudge.
 */
function ThemePicker() {
  const { t } = useT();
  const theme = useDesignerStore((s) => (s.report as any).theme as Theme | undefined);
  const setMeta = useDesignerStore((s) => s.updateReportMeta);
  const current = THEME_PRESETS[theme ?? "default"];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" title={t("designerToolbar.theme")}>
          <span
            aria-hidden
            className="mr-1.5 inline-block h-3.5 w-3.5 rounded-full ring-1 ring-border"
            style={{ background: current.swatch }}
          />
          <Palette className="mr-1.5 h-4 w-4" />
          {t(`themePreset.${current.slug}`)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {Object.values(THEME_PRESETS).map((p) => (
          <DropdownMenuItem
            key={p.slug}
            onClick={() => setMeta({ theme: p.slug } as any)}
            className="flex items-start gap-2"
          >
            <span
              aria-hidden
              className="mt-0.5 inline-flex shrink-0 overflow-hidden rounded-md ring-1 ring-border"
            >
              {p.palette.slice(0, 5).map((c, i) => (
                <span key={i} className="block h-3.5 w-2" style={{ background: c }} />
              ))}
            </span>
            <span className="flex-1">
              <span className="block text-sm font-medium">{t(`themePreset.${p.slug}`)}</span>
              <span className="block text-[10px] leading-tight text-muted-foreground">{t(`themePreset.${p.slug}.desc`)}</span>
            </span>
            {(theme ?? "default") === p.slug && <Check className="mt-0.5 h-3.5 w-3.5 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
