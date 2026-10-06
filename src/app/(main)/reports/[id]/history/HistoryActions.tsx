"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { RotateCcw, FileDown, Loader2 } from "lucide-react";
import { useToast } from "@/lib/toast";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/LocaleContext";
import { useReportExport } from "@/components/reports/useReportExport";
import type { ExportFormat } from "@/lib/reporting/exportDownload";

export function HistoryActions({
  kind, reportId, version, format, runParams,
}: {
  kind: "restore" | "redownload";
  reportId: string;
  version?: number;
  format?: string;
  runParams?: Record<string, unknown>;
}) {
  const { t } = useT();
  const { push } = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const { exportFile, isExporting } = useReportExport(reportId);

  async function restore() {
    if (!confirm(t("reportHistory.restoreConfirm").replace("{n}", String(version)))) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/reports/${reportId}/versions/${version}/restore`, { method: "POST" });
      if (!r.ok) {
        push({ variant: "destructive", title: t("reportHistory.restoreFailed"), description: await r.text() });
        return;
      }
      push({ variant: "success", title: t("reportHistory.restored").replace("{n}", String(version)) });
      router.refresh();
    } finally { setBusy(false); }
  }

  if (kind === "restore") {
    return (
      <Button size="sm" variant="ghost" onClick={restore} disabled={busy} className="h-7 px-2 text-xs">
        {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1 h-3.5 w-3.5" />}
        {t("reportHistory.restore")}
      </Button>
    );
  }
  // A run's format is one of the export routes' (the page hides this for html runs).
  const fmt = format as ExportFormat;
  const downloading = isExporting(fmt);
  return (
    <Button size="sm" variant="ghost" onClick={() => void exportFile(fmt, runParams)} disabled={downloading} className="h-7 px-2 text-xs">
      {downloading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <FileDown className="mr-1 h-3.5 w-3.5" />}
      {t("reportHistory.redownloadLabel")}
    </Button>
  );
}
