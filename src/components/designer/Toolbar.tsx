"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Undo2, Redo2, Save, Eye, Download, ChevronRight, ArrowLeft,
  Loader2, Check, FileSpreadsheet, FileText, FileCode, History, Clock, Palette, Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDesignerStore } from "@/lib/reporting/store";
import { DataDrawer } from "./DataDrawer";
import { ScheduleDrawer } from "./ScheduleDrawer";
import { useToast } from "@/lib/toast";
import { CurfLogo } from "@/components/common/CurfLogo";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { THEME_PRESETS } from "@/lib/reporting/themes";
import type { Theme } from "@/lib/reporting/schema";
import { SuggestChartButton } from "./SuggestChartButton";
import { eeClient } from "@/ee/client";

const PublishButton = eeClient.designer?.PublishButton ?? null;

type SaveState = "idle" | "saving" | "saved" | "error";

export function Toolbar({ reportId }: { reportId: string }) {
  const router = useRouter();
  const name = useDesignerStore((s) => s.report.name);
  const setMeta = useDesignerStore((s) => s.updateReportMeta);
  const report = useDesignerStore((s) => s.report);
  const { push } = useToast();
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
      let description = raw || "Request failed.";
      try {
        const json = JSON.parse(raw);
        description = json?.upgradeUrl
          ? `${json.error ?? "Request failed."} Upgrade at ${json.upgradeUrl}.`
          : json?.error ?? description;
      } catch { /* not JSON — keep the raw text */ }
      push({ variant: "destructive", title: "Save failed", description });
      return;
    }
    setSaveState("saved");
    push({ variant: "success", title: "Saved", description: "Report updated." });
    router.refresh();
    setTimeout(() => setSaveState("idle"), 1500);
  }

  return (
    <header className="flex items-center justify-between border-b border-border bg-background/90 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          asChild
          size="sm"
          variant="ghost"
          className="h-8 -ml-1 text-muted-foreground hover:text-foreground"
          title="Back to reports"
        >
          <Link href="/reports">
            <ArrowLeft className="mr-1.5 h-4 w-4" /> Reports
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

      <div className="flex items-center gap-1">
        <div className="mr-1 flex items-center gap-0.5">
          <Button size="icon" variant="ghost" onClick={undo} title="Undo">
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={redo} title="Redo">
            <Redo2 className="h-4 w-4" />
          </Button>
        </div>
        <DataDrawer />
        <SuggestChartButton reportId={reportId} />
        <ThemePicker />
        <Button size="sm" variant="ghost" onClick={() => setScheduleOpen(true)} title="Schedule deliveries">
          <Clock className="mr-1.5 h-4 w-4" /> Schedule
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <Link href={"/reports/" + reportId + "/history"}>
            <History className="mr-1.5 h-4 w-4" /> History
          </Link>
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <Link href={"/reports/" + reportId} target="_blank">
            <Eye className="mr-1.5 h-4 w-4" /> Preview
          </Link>
        </Button>
        {PublishButton && <PublishButton reportId={reportId} />}
        {/* Story Mode — Business plan. The page itself enforces the tier
            gate (renders an upgrade card on Free/Team) so the button stays
            visible to everyone as a discovery affordance. */}
        <Button size="sm" variant="ghost" asChild title="Auto-narrated walkthrough">
          <Link href={"/reports/" + reportId + "/story"} target="_blank">
            <Sparkles className="mr-1.5 h-4 w-4" /> Story
          </Link>
        </Button>
        <ExportMenu reportId={reportId} />
        <Button size="sm" onClick={save} disabled={saveState === "saving"}>
          {saveState === "saving" ? (
            <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Saving...</>
          ) : (
            <><Save className="mr-1.5 h-4 w-4" /> Save</>
          )}
        </Button>
      </div>
      <ScheduleDrawer
        reportId={reportId}
        reportName={name || "Untitled"}
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
      />
    </header>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === "idle") return null;
  if (state === "saving") return (
    <span className="ml-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" /> Saving...
    </span>
  );
  if (state === "saved") return (
    <span className="ml-1 inline-flex items-center gap-1 text-[11px] text-success">
      <Check className="h-3 w-3" /> Saved
    </span>
  );
  return <span className="ml-1 text-[11px] text-destructive">Save failed</span>;
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
  const theme = useDesignerStore((s) => (s.report as any).theme as Theme | undefined);
  const setMeta = useDesignerStore((s) => s.updateReportMeta);
  const current = THEME_PRESETS[theme ?? "default"];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" title="Theme">
          <span
            aria-hidden
            className="mr-1.5 inline-block h-3.5 w-3.5 rounded-full ring-1 ring-border"
            style={{ background: current.swatch }}
          />
          <Palette className="mr-1.5 h-4 w-4" />
          {current.label}
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
              <span className="block text-sm font-medium">{p.label}</span>
              <span className="block text-[10px] leading-tight text-muted-foreground">{p.description}</span>
            </span>
            {(theme ?? "default") === p.slug && <Check className="mt-0.5 h-3.5 w-3.5 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ExportMenu({ reportId }: { reportId: string }) {
  const { push } = useToast();
  const [csvExporting, setCsvExporting] = useState(false);

  // CSV, unlike pdf/xlsx/docx, has a real "nothing to export" case (no
  // table block on the report) and the API route reports it as a 400 JSON
  // error — a plain <a href> navigation dumped that raw JSON into the whole
  // tab instead of downloading anything. Same fetch+blob fix already
  // applied to the viewer's export menu (ReportViewerShell.tsx).
  async function exportCsv() {
    setCsvExporting(true);
    try {
      const r = await fetch("/api/reports/" + reportId + "/export/csv");
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: "Export failed." }));
        push({
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
      push({ variant: "destructive", title: "Couldn't export CSV", description: "Network error." });
    } finally {
      setCsvExporting(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Download className="mr-1.5 h-4 w-4" /> Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem asChild>
          <a href={"/api/reports/" + reportId + "/export/pdf"} target="_blank" rel="noreferrer">
            <FileText className="mr-2 h-4 w-4" /> PDF
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={"/api/reports/" + reportId + "/export/xlsx"}>
            <FileSpreadsheet className="mr-2 h-4 w-4" /> Excel
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={"/api/reports/" + reportId + "/export/docx"}>
            <FileText className="mr-2 h-4 w-4" /> Word
          </a>
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
}
