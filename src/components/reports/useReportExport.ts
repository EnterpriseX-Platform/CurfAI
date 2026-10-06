"use client";
import { useCallback, useState } from "react";
import { useT } from "@/lib/i18n/LocaleContext";
import { useToast } from "@/lib/toast";
import { exportFailureToast, fetchExport, reportExportUrl, type ExportFormat } from "@/lib/reporting/exportDownload";

export const EXPORT_FORMAT_LABEL: Record<ExportFormat, string> = { pdf: "PDF", xlsx: "Excel", docx: "Word", csv: "CSV" };

/**
 * Export a report as a file: the viewer and designer export menus, and
 * re-download on the history page. A failed export is a toast in the
 * current tab, never the route's raw JSON (see lib/reporting/exportDownload).
 *
 * Every format downloads, PDF included. PDF used to open inline in a new
 * tab, but a capture takes up to half a minute (longer when it queues for
 * the headless browser), so the tab would sit blank for that long, and on
 * a failure it would have to close again while the error showed up in the
 * tab the reader had just left.
 */
export function useReportExport(reportId: string) {
  const { t } = useT();
  const { push } = useToast();
  const [exporting, setExporting] = useState<ReadonlySet<ExportFormat>>(() => new Set());

  const exportFile = useCallback(async (format: ExportFormat, params?: Record<string, unknown>) => {
    setExporting((s) => new Set(s).add(format));
    try {
      const res = await fetchExport(reportExportUrl(reportId, format, params), `report.${format}`);
      if (res.ok) {
        saveBlob(res.blob, res.filename);
      } else {
        push(exportFailureToast(res, t, t("export.failedTitle").replace("{format}", EXPORT_FORMAT_LABEL[format])));
      }
    } finally {
      setExporting((s) => {
        const next = new Set(s);
        next.delete(format);
        return next;
      });
    }
  }, [reportId, t, push]);

  return {
    exportFile,
    isExporting: (format: ExportFormat) => exporting.has(format),
    anyExporting: exporting.size > 0,
  };
}

/** Hand a fetched file to the browser as a download. Also used by the schedules' "Run now". */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Not revoked in the same tick: some browsers still read the blob after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
