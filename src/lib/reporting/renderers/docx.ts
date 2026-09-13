/**
 * DOCX renderer. Emits heading + KPI list + tables for each Table block.
 * Charts/Images are omitted in V1 (adding them requires image buffers).
 */
import {
  AlignmentType, Document, Packer, Paragraph, HeadingLevel,
  Table, TableCell, TableRow, WidthType, TextRun, BorderStyle,
  Header, Footer, PageNumber,
} from "docx";
import { runReport, interpolate } from "@/lib/reporting/runner";
import { aggregate, formatCell, uncappedTableTitle } from "@/lib/reporting/format";
import type { Report } from "@/lib/reporting/schema";

export async function renderDocx(
  report: Report,
  params: Record<string, unknown>,
  currency?: string,
  /**
   * Rows to render instead of executing the report. For documents that are
   * ASSEMBLED rather than queried — the Master Builder data-requirements
   * manifest builds its own rows in memory and has no dataSources to run.
   * Omit it and the report executes as usual.
   */
  presetDataset?: Record<string, Array<Record<string, unknown>>>,
): Promise<Buffer> {
  // A Word export is a document people read, but its tables are still the
  // data — so lift the generator's display cap and emit every row.
  const dataset = presetDataset ?? (await runReport({ report, params, forExport: true }));
  const children: any[] = [];

  children.push(new Paragraph({
    text: report.name,
    heading: HeadingLevel.TITLE,
  }));
  if (report.description) {
    children.push(new Paragraph({
      children: [new TextRun({ text: report.description, italics: true, color: "666666" })],
    }));
  }
  children.push(new Paragraph({ text: "" }));

  for (const page of report.pages) {
    for (const b of page.blocks) {
      if (b.type === "title") {
        children.push(new Paragraph({
          text: interpolate(b.config.text, { params }),
          heading: HeadingLevel.HEADING_1,
        }));
        if (b.config.subtitle) {
          children.push(new Paragraph({
            children: [new TextRun({ text: interpolate(b.config.subtitle, { params }), color: "666666" })],
          }));
        }
      } else if (b.type === "text") {
        children.push(new Paragraph({
          text: interpolate(b.config.text, { params }),
          alignment: b.config.align === "center" ? AlignmentType.CENTER : b.config.align === "right" ? AlignmentType.RIGHT : AlignmentType.LEFT,
        }));
      } else if (b.type === "kpi") {
        const rows = dataset[b.config.queryId] ?? [];
        const v = rows[0]?.[b.config.valueField];
        children.push(new Paragraph({
          children: [
            new TextRun({ text: `${b.config.label}: `, bold: true }),
            new TextRun({ text: formatCell(v, b.config.format === "currency" ? "currency" : b.config.format === "percent" ? "percent" : "number", undefined, currency) }),
          ],
        }));
      } else if (b.type === "table") {
        const rows = dataset[b.config.queryId] ?? [];
        const heading = uncappedTableTitle(b.config.title, rows.length);
        if (heading) {
          children.push(new Paragraph({ text: heading, heading: HeadingLevel.HEADING_2 }));
        }
        const table = new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              tableHeader: true,
              children: b.config.columns.map((c) => new TableCell({
                shading: { fill: "EFEFEF" },
                children: [new Paragraph({ children: [new TextRun({ text: c.label, bold: true })] })],
              })),
            }),
            ...rows.map((r) => new TableRow({
              children: b.config.columns.map((c) => new TableCell({
                children: [new Paragraph({
                  text: formatCell(r[c.key], c.type, c.format, currency),
                  alignment: c.align === "right" || ["number", "currency", "percent"].includes(c.type)
                    ? AlignmentType.RIGHT
                    : c.align === "center"
                      ? AlignmentType.CENTER
                      : AlignmentType.LEFT,
                })],
              })),
            })),
            ...(b.config.showTotals && b.config.columns.some((c) => c.total !== "none") && rows.length > 0
              ? [new TableRow({
                  children: b.config.columns.map((c) => {
                    const agg = c.total !== "none" ? aggregate(rows, c.key, c.total) : null;
                    return new TableCell({
                      borders: { top: { style: BorderStyle.SINGLE, size: 6, color: "000000" } } as any,
                      children: [new Paragraph({
                        children: [new TextRun({
                          text: agg == null ? "" : formatCell(agg, c.type, c.format, currency),
                          bold: true,
                        })],
                        alignment: ["number", "currency", "percent"].includes(c.type)
                          ? AlignmentType.RIGHT
                          : AlignmentType.LEFT,
                      })],
                    });
                  }),
                })]
              : []),
          ],
        });
        children.push(table);
        children.push(new Paragraph({ text: "" }));
      } else if (b.type === "divider") {
        children.push(new Paragraph({ text: "", border: { bottom: { color: "CCCCCC", size: 6, style: BorderStyle.SINGLE } as any } }));
      }
    }
  }

  const doc = new Document({
    creator: "Curf",
    title: report.name,
    sections: [{
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.LEFT,
            children: [new TextRun({ text: report.name, bold: true, size: 18, color: "111827" })],
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [
              new TextRun({ text: "Page ", size: 16, color: "6B7280" }),
              new TextRun({ children: [PageNumber.CURRENT], size: 16, color: "6B7280" }),
              new TextRun({ text: " of ", size: 16, color: "6B7280" }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: "6B7280" }),
            ],
          })],
        }),
      },
      children,
    }],
  });

  const buf = await Packer.toBuffer(doc);
  return Buffer.from(buf);
}
