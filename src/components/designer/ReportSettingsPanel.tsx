"use client";
/**
 * ReportSettingsPanel — what the right-hand inspector shows when no block is
 * selected: the settings that apply to the whole report and change rarely
 * (how the viewer lays it out, how years are written, the theme), plus the
 * report's schedule, saved versions and story. They used to sit in the
 * designer toolbar as a row of dropdowns and unlabeled icons; here each one
 * gets its name and a line saying what it does.
 */
import Link from "next/link";
import { useState } from "react";
import {
  Settings2, LayoutDashboard, FileText, CalendarDays, Palette, Check,
  Clock, History, Sparkles, MousePointerClick, ChevronRight,
} from "lucide-react";
import { useDesignerStore } from "@/lib/reporting/store";
import { THEME_PRESETS } from "@/lib/reporting/themes";
import { reportDisplay, type Theme, type ReportDisplay } from "@/lib/reporting/schema";
import { eeClient } from "@/ee/client";
import { useT } from "@/lib/i18n/LocaleContext";
import { PanelSection } from "./PanelSection";
import { ScheduleDrawer } from "./ScheduleDrawer";

const STORY_MODE = !!eeClient.designer?.storyMode;

export function ReportSettingsPanel({ reportId }: { reportId?: string }) {
  const { t } = useT();
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Settings2 className="h-3.5 w-3.5" />
          </span>
          <span className="text-sm font-medium">{t("designer.settings.title")}</span>
        </div>
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
          <MousePointerClick className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t("designer.settings.hint")}
        </p>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        <DisplaySection />
        <YearStyleSection />
        <ThemeSection />
        {reportId && <MoreSection reportId={reportId} />}
      </div>
    </div>
  );
}

/** One choice in a single-select list: name, a line of description, a check when current. */
function Choice({
  selected, onSelect, label, description, leading,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  description?: string;
  leading?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors ${
        selected ? "border-primary/40 bg-primary-soft" : "border-border bg-background hover:bg-accent"
      }`}
    >
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-foreground">{label}</span>
        {description && <span className="mt-0.5 block text-2xs leading-snug text-muted-foreground">{description}</span>}
      </span>
      {selected && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />}
    </button>
  );
}

/**
 * How the viewer lays the report out: full-width dashboard grid, or the
 * A4 / Letter sheets it prints as. Exports and the designer canvas always
 * use the sheets; this only changes the interactive viewer.
 */
const DISPLAY_OPTIONS: Array<{ value: ReportDisplay; labelKey: string; descriptionKey: string; Icon: typeof LayoutDashboard }> = [
  { value: "dashboard", labelKey: "designerToolbar.display.dashboard", descriptionKey: "designerToolbar.display.dashboardDesc", Icon: LayoutDashboard },
  { value: "page",      labelKey: "designerShell.pageLabel",           descriptionKey: "designerToolbar.display.pageDesc",      Icon: FileText },
];

function DisplaySection() {
  const { t } = useT();
  const report = useDesignerStore((s) => s.report);
  const setMeta = useDesignerStore((s) => s.updateReportMeta);
  const current = reportDisplay(report);
  return (
    <PanelSection icon={LayoutDashboard} label={t("designer.settings.display")}>
      <p className="text-xs text-muted-foreground">{t("designerToolbar.displayTooltip")}</p>
      <div role="radiogroup" aria-label={t("designer.settings.display")} className="grid gap-1.5">
        {DISPLAY_OPTIONS.map((o) => (
          <Choice
            key={o.value}
            selected={current === o.value}
            onSelect={() => setMeta({ display: o.value })}
            label={t(o.labelKey)}
            description={t(o.descriptionKey)}
            leading={<o.Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          />
        ))}
      </div>
    </PanelSection>
  );
}

/**
 * How this report writes years for Thai readers. "Reader's choice" (unset)
 * follows each reader's Account preference; locking it to พ.ศ. or ค.ศ. makes
 * every reader, and every PDF and Excel file, show the same year — what a
 * regulatory or board report needs. Report.dateEra.
 */
const YEAR_OPTIONS: Array<{ value: "be" | "ce" | undefined; labelKey: string; descriptionKey: string }> = [
  { value: undefined, labelKey: "designer.settings.years.reader", descriptionKey: "designerToolbar.years.readerDesc" },
  { value: "be",      labelKey: "designer.settings.years.be",     descriptionKey: "designer.settings.years.beDesc" },
  { value: "ce",      labelKey: "designer.settings.years.ce",     descriptionKey: "designer.settings.years.ceDesc" },
];

function YearStyleSection() {
  const { t } = useT();
  const dateEra = useDesignerStore((s) => s.report.dateEra);
  const setMeta = useDesignerStore((s) => s.updateReportMeta);
  // The examples show this year, so the labels never go stale.
  const ce = new Date().getFullYear();
  const yearFor = (v: "be" | "ce" | undefined) => String(v === "be" ? ce + 543 : ce);
  return (
    <PanelSection icon={CalendarDays} label={t("designer.settings.years")} defaultOpen={false}>
      <p className="text-xs text-muted-foreground">{t("designer.settings.yearsHint")}</p>
      <div role="radiogroup" aria-label={t("designer.settings.years")} className="grid gap-1.5">
        {YEAR_OPTIONS.map((o) => (
          <Choice
            key={o.value ?? "reader"}
            selected={dateEra === o.value}
            onSelect={() => setMeta({ dateEra: o.value })}
            label={t(o.labelKey).replace("{year}", yearFor(o.value))}
            description={t(o.descriptionKey).replace("{year}", yearFor(o.value))}
          />
        ))}
      </div>
    </PanelSection>
  );
}

/**
 * Sets `report.theme`. Server-side, the save endpoint gates
 * `viz.theme_presets` — picking a non-default theme on a plan without it
 * fails at save time with a 402 surfaced as a destructive toast. The list
 * stays visible to everyone so they see what they could unlock; the
 * click→save→toast flow is the upgrade nudge.
 */
function ThemeSection() {
  const { t } = useT();
  const theme = useDesignerStore((s) => (s.report as any).theme as Theme | undefined);
  const setMeta = useDesignerStore((s) => s.updateReportMeta);
  return (
    <PanelSection icon={Palette} label={t("designerToolbar.theme")} defaultOpen={false}>
      <p className="text-xs text-muted-foreground">{t("designer.settings.themeHint")}</p>
      <div role="radiogroup" aria-label={t("designerToolbar.theme")} className="grid gap-1.5">
        {Object.values(THEME_PRESETS).map((p) => (
          <Choice
            key={p.slug}
            selected={(theme ?? "default") === p.slug}
            onSelect={() => setMeta({ theme: p.slug } as any)}
            label={t(`themePreset.${p.slug}`)}
            description={t(`themePreset.${p.slug}.desc`)}
            leading={
              <span aria-hidden className="mt-0.5 inline-flex shrink-0 overflow-hidden rounded-sm ring-1 ring-border">
                {p.palette.slice(0, 5).map((c, i) => (
                  <span key={i} className="block h-3.5 w-2" style={{ background: c }} />
                ))}
              </span>
            }
          />
        ))}
      </div>
    </PanelSection>
  );
}

/** Schedule, saved versions and Story — each a labelled row, not a bare icon. */
function MoreSection({ reportId }: { reportId: string }) {
  const { t } = useT();
  const name = useDesignerStore((s) => s.report.name);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const row = "flex w-full items-start gap-2 rounded-md border border-border bg-background px-2.5 py-2 text-left transition-colors hover:bg-accent";
  return (
    <PanelSection icon={Clock} label={t("designer.settings.more")} defaultOpen={false}>
      <div className="grid gap-1.5">
        <button type="button" onClick={() => setScheduleOpen(true)} className={row}>
          <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <RowText label={t("designerToolbar.schedule")} description={t("designer.settings.scheduleDesc")} />
        </button>
        <Link href={"/reports/" + reportId + "/history"} className={row}>
          <History className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <RowText label={t("reportHistory.breadcrumb")} description={t("designer.settings.historyDesc")} />
        </Link>
        {/* Story Mode — Business plan. On Cloud the page enforces the tier
            gate (renders an upgrade card below Business) so the entry stays
            visible as a discovery affordance; Community has no story page. */}
        {STORY_MODE && (
          <Link href={"/reports/" + reportId + "/story"} target="_blank" className={row}>
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <RowText label={t("designerToolbar.story")} description={t("designerToolbar.storyTooltip")} />
          </Link>
        )}
      </div>
      <ScheduleDrawer
        reportId={reportId}
        reportName={name || t("common.untitled")}
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
      />
    </PanelSection>
  );
}

function RowText({ label, description }: { label: string; description: string }) {
  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-foreground">{label}</span>
        <span className="mt-0.5 block text-2xs leading-snug text-muted-foreground">{description}</span>
      </span>
      <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" />
    </>
  );
}
