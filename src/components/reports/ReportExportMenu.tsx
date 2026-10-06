"use client";
import { Download, FileCode, FileSpreadsheet, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/lib/i18n/LocaleContext";
import type { ExportFormat } from "@/lib/reporting/exportDownload";
import { EXPORT_FORMAT_LABEL, useReportExport } from "./useReportExport";

const FORMATS: Array<{ format: ExportFormat; Icon: typeof FileText }> = [
  { format: "pdf", Icon: FileText },
  { format: "xlsx", Icon: FileSpreadsheet },
  { format: "docx", Icon: FileText },
  { format: "csv", Icon: FileCode },
];

/** The Export menu in the report viewer's header and the designer's toolbar.
 *  `params` are the viewer's current filters; the designer exports the
 *  report's defaults. */
export function ReportExportMenu({ reportId, params }: { reportId: string; params?: Record<string, unknown> }) {
  const { t } = useT();
  const { exportFile, isExporting, anyExporting } = useReportExport(reportId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* The menu closes on select, so the trigger is what shows an
            export is still running. */}
        <Button size="sm" variant="outline" aria-busy={anyExporting}>
          {anyExporting
            ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            : <Download className="mr-1.5 h-4 w-4" />}
          {t("export.menu")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {FORMATS.map(({ format, Icon }) => (
          <DropdownMenuItem
            key={format}
            onSelect={() => void exportFile(format, params)}
            disabled={isExporting(format)}
            className="cursor-pointer"
          >
            {isExporting(format)
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <Icon className="mr-2 h-4 w-4" />}
            {EXPORT_FORMAT_LABEL[format]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
