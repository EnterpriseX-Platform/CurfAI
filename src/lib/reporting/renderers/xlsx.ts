/**
 * XLSX renderer - layout-matching.
 *
 * Emits one "Report" sheet per page that mirrors the designer/viewer grid.
 * Native Excel elements (merged cells, real values, number formats) are used
 * wherever possible so tables and KPIs remain filterable/editable. Charts
 * and images are screenshotted from the live viewer with Puppeteer and
 * embedded as PNGs anchored to the matching cell range.
 *
 * A secondary "Data N" sheet is added for every table block so Excel users
 * get raw data for pivots / further analysis.
 */
import ExcelJS from "exceljs";
import { currencySymbol, DEFAULT_CURRENCY } from "@/lib/reporting/currency";
import type { DateStyle } from "@/lib/reporting/format";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { withBrowserPage } from "@/lib/reporting/renderers/headlessBrowser";
import { openReportViewer } from "@/lib/reporting/renderers/reportViewerPage";
import { runReportWithProof, ANONYMOUS_VIEWER, type RunViewer } from "@/lib/reporting/runner";
import { queryErrors } from "@/lib/reporting/queryRunState";
import { visibleReport } from "@/lib/reporting/visibleReport";
import { aggregate, uncappedTableTitle } from "@/lib/reporting/format";
import { interpolate } from "@/lib/reporting/interpolate";
import type { Block, Report } from "@/lib/reporting/schema";

/** Escape `&` in user strings so Excel's header/footer code parser
 *  doesn't treat e.g. 'Profit & Loss' as a formatting token. */
function escapeExcel(s: string): string { return (s || '').replace(/&/g, '&&'); }

// Grid layout - must stay in sync with ReportDocument.tsx.
const GRID_COLS = 12;

// Excel layout constants.
const EXCEL_COL_WIDTH = 12;
const ROWS_PER_GRID_ROW = 2;
const EXCEL_ROW_HEIGHT = 20;

type BlockImage = { pngBase64: string; widthPx: number; heightPx: number };

export type XlsxOptions = {
  reportId?: string;
  /** Owner of the report: its queries run inside this workspace (see
   *  RunContext.tenantId), and with reportId and viewer it mints the render
   *  token the viewer page requires for a `print=1` capture — see
   *  lib/reporting/renderToken.ts. */
  tenantId: string;
  authCookie?: string;
  /** ISO 4217 code — see lib/reporting/currency.ts. Defaults to DEFAULT_CURRENCY. */
  currency?: string;
  /** A downloaded file leaves the app entirely, so redaction matters here
   *  at least as much as on-screen — pass the requesting user's viewer.
   *  The chart screenshots render as this viewer too. Omitted, the file
   *  renders as nobody: blocks and data both. */
  viewer?: RunViewer;
  /** Reader's language + year style, report's dateEra already applied (resolveDateStyle). */
  dateStyle?: DateStyle;
};

export async function renderXlsx(
  report: Report,
  params: Record<string, unknown>,
  opts: XlsxOptions,
): Promise<Buffer> {
  // Also keeps the chart capture below from waiting on a block the viewer
  // page won't draw for this caller.
  report = visibleReport(report, opts.viewer);
  const numFmtCurrency = `"${currencySymbol(opts.currency ?? DEFAULT_CURRENCY)}"#,##0.00`;
  const dateFmts = excelDateFormats(opts.dateStyle);
  // A report a model wrote says so on every printed page's footer (ai.notice.short), in the reader's language.
  const lang: Locale = (LOCALES as readonly string[]).includes(opts.dateStyle?.locale ?? "") ? (opts.dateStyle!.locale as Locale) : "en";
  const aiFooter = report.quality?.authored === "ai" ? `&C${escapeExcel(t(lang, "ai.notice.short"))}` : "";
  // forExport lifts the generator's display cap: the laid-out dashboard
  // sheet stays bounded by its grid, but the per-table "Data" sheet that
  // accompanies it now carries every row rather than the first 500.
  const { dataset, provenance } = await runReportWithProof({ report, params, tenantId: opts.tenantId, forExport: true, viewer: opts.viewer ?? ANONYMOUS_VIEWER });
  // A query that failed is an empty array in the dataset. Rendered as-is it is a blank card /
  // an empty table in a file that then travels without any sign that something is missing.
  const notRun = queryErrors(provenance);

  const images: Record<string, BlockImage> = {};
  if (opts.reportId) {
    // A failed capture fails the export. It used to be logged and swallowed,
    // and the file went out with its charts missing as a 200 nobody had
    // reason to doubt. That's what concurrent exports produced on
    // 2026-09-23 (see headlessBrowser.ts).
    await captureBlockImages(opts.reportId, opts.tenantId, opts.viewer ?? ANONYMOUS_VIEWER, params, report, opts.authCookie ?? null, images);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "Curf";
  wb.created = new Date();

  for (let pIdx = 0; pIdx < report.pages.length; pIdx++) {
    const page = report.pages[pIdx];
    const name = report.pages.length === 1 ? "Report" : `Page ${pIdx + 1}`;
    const sheet = wb.addWorksheet(name, {
      pageSetup: {
        paperSize: (page.size === "A4" ? 9 : page.size === "Letter" ? 1 : 5) as any,
        orientation: page.orientation,
        fitToPage: true,
        margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
      },
      headerFooter: {
        // &L = left, &C = center, &R = right. &P = page, &N = total.
        oddHeader: `&L&"-,Bold"&12${escapeExcel(report.name)}&R&D`,
        oddFooter: `&L${escapeExcel(report.name)}${aiFooter}&RPage &P of &N`,
      },
      views: [{ showGridLines: false }],
    });

    for (let c = 1; c <= GRID_COLS; c++) sheet.getColumn(c).width = EXCEL_COL_WIDTH;

    const maxGridRow = page.blocks.reduce((m, b) => Math.max(m, b.y + b.h), 0);
    for (let r = 1; r <= maxGridRow * ROWS_PER_GRID_ROW + 2; r++) {
      sheet.getRow(r).height = EXCEL_ROW_HEIGHT;
    }

    for (const block of page.blocks) {
      placeBlock(sheet, block, dataset, params, numFmtCurrency, images[block.id], notRun, dateFmts);
    }
  }

  let tableIdx = 0;
  for (const page of report.pages) {
    for (const b of page.blocks) {
      if (b.type !== "table") continue;
      tableIdx++;
      addRawDataSheet(wb, b, dataset, tableIdx, numFmtCurrency, notRun, dateFmts);
    }
  }

  // useSharedStrings:false skips building/looking up the workbook-wide
  // shared-string table — at bulk row counts (the "Data N" sheet can carry
  // hundreds of thousands of rows) that table walk is a real chunk of
  // writeBuffer()'s cost. Inline strings round-trip identically (verified:
  // numFmt/font/fill survive a load-back) and cost ~0 extra file size.
  const buf = await wb.xlsx.writeBuffer({ useSharedStrings: false });
  return Buffer.from(buf);
}

function placeBlock(
  sheet: ExcelJS.Worksheet,
  block: Block,
  dataset: Record<string, Record<string, unknown>[]>,
  params: Record<string, unknown>,
  numFmtCurrency: string,
  image?: BlockImage,
  notRun: Record<string, string> = {},
  dateFmts: ExcelDateFormats = excelDateFormats(),
) {
  const startCol = block.x + 1;
  const endCol = block.x + block.w;
  const startRow = block.y * ROWS_PER_GRID_ROW + 1;
  const endRow = Math.max(startRow, (block.y + block.h) * ROWS_PER_GRID_ROW);

  const failedReason = (block.type === "kpi" || block.type === "table" || block.type === "chart") ? notRun[(block as any).config.queryId] : undefined;
  if (failedReason !== undefined) {
    return placeNotRun(sheet, block, failedReason, startRow, endRow, startCol, endCol);
  }

  switch (block.type) {
    case "title":     return placeTitle(sheet, block, params, startRow, endRow, startCol, endCol);
    case "text":      return placeText(sheet, block, params, startRow, endRow, startCol, endCol);
    case "kpi":       return placeKpi(sheet, block, dataset, startRow, endRow, startCol, endCol, numFmtCurrency);
    case "table":     return placeTable(sheet, block, dataset, startRow, endRow, startCol, endCol, numFmtCurrency, dateFmts);
    case "chart":
    case "image":     return placeImage(sheet, block, image, startRow, endRow, startCol, endCol);
    case "divider":   return placeDivider(sheet, startRow, endRow, startCol, endCol);
    case "pageBreak": sheet.getRow(endRow).addPageBreak(); return;
  }
}

function mergeAndGet(
  sheet: ExcelJS.Worksheet,
  r1: number, c1: number, r2: number, c2: number
): ExcelJS.Cell {
  if (r1 !== r2 || c1 !== c2) sheet.mergeCells(r1, c1, r2, c2);
  return sheet.getCell(r1, c1);
}

function placeNotRun(sheet: ExcelJS.Worksheet, block: any, reason: string, r1: number, r2: number, c1: number, c2: number) {
  const cell = mergeAndGet(sheet, r1, c1, r2, c2);
  const label = block.config?.label ?? block.config?.title ?? "";
  cell.value = {
    richText: [
      ...(label ? [{ text: `${label}\n`, font: { size: 10, bold: true, color: { argb: "FF6B7280" } } }] : []),
      { text: `\u26A0 This query didn't run: ${reason}`, font: { size: 10, color: { argb: "FFB91C1C" } } },
    ],
  };
  cell.alignment = { horizontal: "left", vertical: "top", wrapText: true, indent: 1 };
  applyCardBorder(sheet, r1, c1, r2, c2);
  fillRange(sheet, r1, c1, r2, c2, "FFFEF2F2");
}

function placeTitle(sheet: ExcelJS.Worksheet, block: any, params: any, r1: number, r2: number, c1: number, c2: number) {
  const text = interpolate(block.config.text, { params });
  const subtitle = block.config.subtitle ? interpolate(block.config.subtitle, { params }) : "";
  const cell = mergeAndGet(sheet, r1, c1, r2, c2);
  if (subtitle) {
    cell.value = {
      richText: [
        { text, font: { size: 20, bold: true, color: { argb: "FF111111" } } },
        { text: `\n${subtitle}`, font: { size: 11, color: { argb: "FF666666" } } },
      ],
    };
  } else {
    cell.value = text;
    cell.font = { size: 20, bold: true, color: { argb: "FF111111" } };
  }
  cell.alignment = { horizontal: block.config.align, vertical: "middle", wrapText: true };
}

function placeText(sheet: ExcelJS.Worksheet, block: any, params: any, r1: number, r2: number, c1: number, c2: number) {
  const cell = mergeAndGet(sheet, r1, c1, r2, c2);
  cell.value = interpolate(block.config.text, { params });
  cell.alignment = { horizontal: block.config.align, vertical: "top", wrapText: true };
  cell.font = { size: block.config.size === "sm" ? 10 : block.config.size === "lg" ? 14 : 11 };
}

function placeKpi(sheet: ExcelJS.Worksheet, block: any, dataset: any, r1: number, r2: number, c1: number, c2: number, numFmtCurrency: string) {
  const rows = dataset[block.config.queryId] ?? [];
  const v = rows[0] ? Number(rows[0][block.config.valueField]) : NaN;

  const midRow = Math.max(r1, Math.floor((r1 + r2) / 2));
  const labelCell = mergeAndGet(sheet, r1, c1, midRow, c2);
  labelCell.value = block.config.label;
  labelCell.alignment = { horizontal: "left", vertical: "bottom", indent: 1 };
  labelCell.font = { size: 10, color: { argb: "FF6B7280" } };

  const valueCell = mergeAndGet(sheet, midRow + 1, c1, r2, c2);
  valueCell.value = Number.isFinite(v) ? v : null;
  valueCell.alignment = { horizontal: "left", vertical: "top", indent: 1 };
  valueCell.font = { size: 22, bold: true, color: { argb: "FF111111" } };
  if (block.config.format === "currency") valueCell.numFmt = numFmtCurrency;
  else if (block.config.format === "percent") valueCell.numFmt = "0.0%";
  else valueCell.numFmt = "#,##0";

  applyCardBorder(sheet, r1, c1, r2, c2);
  fillRange(sheet, r1, c1, r2, c2, "FFFFFFFF");
}

function placeTable(sheet: ExcelJS.Worksheet, block: any, dataset: any, r1: number, r2: number, c1: number, c2: number, numFmtCurrency: string, dateFmts: ExcelDateFormats = excelDateFormats()) {
  const rows = (dataset[block.config.queryId] ?? []) as Array<Record<string, unknown>>;
  const cols = block.config.columns as any[];
  if (cols.length === 0) return;

  let r = r1;
  if (block.config.title) {
    const cell = mergeAndGet(sheet, r, c1, r, c2);
    cell.value = block.config.title;
    cell.font = { bold: true, size: 12 };
    r += 1;
  }

  const totalW = c2 - c1 + 1;
  const each = Math.max(1, Math.floor(totalW / cols.length));
  const colRanges = cols.map((_, i) => {
    const s = c1 + i * each;
    const e = i === cols.length - 1 ? c2 : c1 + (i + 1) * each - 1;
    return [s, e] as const;
  });

  for (let i = 0; i < cols.length; i++) {
    const [s, e] = colRanges[i];
    const cell = mergeAndGet(sheet, r, s, r, e);
    cell.value = cols[i].label;
    cell.font = { bold: true, color: { argb: "FF374151" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
    cell.alignment = {
      horizontal: cols[i].align ?? (["number", "currency", "percent"].includes(cols[i].type) ? "right" : "left"),
      vertical: "middle",
    };
    cell.border = { bottom: { style: "thin", color: { argb: "FFE5E7EB" } } };
  }
  r++;

  for (const dataRow of rows) {
    if (r > r2) break;
    for (let i = 0; i < cols.length; i++) {
      const [s, e] = colRanges[i];
      const cell = mergeAndGet(sheet, r, s, r, e);
      const raw = dataRow[cols[i].key];
      const isNum = ["number", "currency", "percent"].includes(cols[i].type);
      const isDate = cols[i].type === "date" || cols[i].type === "datetime";
      cell.value = isNum
        ? (raw == null || raw === "" ? null : Number(raw))
        : isDate ? excelDateValue(raw)
        : (raw == null ? null : String(raw));
      if (cols[i].type === "currency") cell.numFmt = numFmtCurrency;
      else if (cols[i].type === "percent") cell.numFmt = "0.0%";
      else if (cols[i].type === "number") cell.numFmt = "#,##0";
      else if (cols[i].type === "date") cell.numFmt = dateFmts.date;
      else if (cols[i].type === "datetime") cell.numFmt = dateFmts.datetime;
      cell.alignment = {
        horizontal: cols[i].align ?? (isNum ? "right" : "left"),
        vertical: "middle",
      };
      cell.border = { bottom: { style: "hair", color: { argb: "FFE5E7EB" } } };
    }
    r++;
  }

  if (block.config.showTotals && r <= r2 && cols.some((c: any) => c.total !== "none")) {
    for (let i = 0; i < cols.length; i++) {
      const [s, e] = colRanges[i];
      const cell = mergeAndGet(sheet, r, s, r, e);
      const isNum = ["number", "currency", "percent"].includes(cols[i].type);
      if (cols[i].total !== "none") {
        cell.value = aggregate(rows, cols[i].key, cols[i].total);
      }
      cell.font = { bold: true };
      cell.border = { top: { style: "thin", color: { argb: "FF111111" } } };
      if (cols[i].type === "currency") cell.numFmt = numFmtCurrency;
      else if (cols[i].type === "percent") cell.numFmt = "0.0%";
      else if (cols[i].type === "number") cell.numFmt = "#,##0";
      cell.alignment = {
        horizontal: cols[i].align ?? (isNum ? "right" : "left"),
        vertical: "middle",
      };
    }
  }
}

function placeImage(
  sheet: ExcelJS.Worksheet,
  block: any,
  image: BlockImage | undefined,
  r1: number, r2: number, c1: number, c2: number
) {
  if (image) {
    const imageId = sheet.workbook.addImage({ base64: image.pngBase64, extension: "png" });
    sheet.addImage(imageId, {
      tl: { col: c1 - 1, row: r1 - 1 } as any,
      br: { col: c2, row: r2 } as any,
      editAs: "oneCell",
    });
    return;
  }
  const cell = mergeAndGet(sheet, r1, c1, r2, c2);
  cell.value = block.type === "chart"
    ? (block.config.title ?? "(chart preview unavailable)")
    : "(image)";
  cell.alignment = { horizontal: "center", vertical: "middle" };
  cell.font = { italic: true, color: { argb: "FF9CA3AF" } };
  cell.border = {
    top:    { style: "dashed", color: { argb: "FFD1D5DB" } },
    bottom: { style: "dashed", color: { argb: "FFD1D5DB" } },
    left:   { style: "dashed", color: { argb: "FFD1D5DB" } },
    right:  { style: "dashed", color: { argb: "FFD1D5DB" } },
  };
}

function placeDivider(sheet: ExcelJS.Worksheet, r1: number, r2: number, c1: number, c2: number) {
  const mid = Math.floor((r1 + r2) / 2);
  for (let c = c1; c <= c2; c++) {
    const cell = sheet.getCell(mid, c);
    cell.border = { ...cell.border, bottom: { style: "thin", color: { argb: "FFD1D5DB" } } };
  }
}

function applyCardBorder(sheet: ExcelJS.Worksheet, r1: number, c1: number, r2: number, c2: number) {
  const border = { style: "thin" as const, color: { argb: "FFE5E7EB" } };
  for (let c = c1; c <= c2; c++) {
    const top = sheet.getCell(r1, c); top.border = { ...top.border, top: border };
    const bot = sheet.getCell(r2, c); bot.border = { ...bot.border, bottom: border };
  }
  for (let r = r1; r <= r2; r++) {
    const left  = sheet.getCell(r, c1); left.border  = { ...left.border,  left:  border };
    const right = sheet.getCell(r, c2); right.border = { ...right.border, right: border };
  }
}

function fillRange(sheet: ExcelJS.Worksheet, r1: number, c1: number, r2: number, c2: number, argb: string) {
  for (let r = r1; r <= r2; r++)
    for (let c = c1; c <= c2; c++)
      sheet.getCell(r, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function addRawDataSheet(
  wb: ExcelJS.Workbook,
  block: any,
  dataset: Record<string, Record<string, unknown>[]>,
  idx: number,
  numFmtCurrency: string,
  notRun: Record<string, string> = {},
  dateFmts: ExcelDateFormats = excelDateFormats(),
) {
  const rows = dataset[block.config.queryId] ?? [];
  // This sheet carries every row, so a "first N of M" heading would lie.
  const title = uncappedTableTitle(block.config.title, rows.length) ?? `Table ${idx}`;
  const sheetName = `Data ${idx} - ${title}`
    .slice(0, 31)
    .replace(/[*?:/\\[\]]/g, " ");
  const sheet = wb.addWorksheet(sheetName);
  const failedReason = notRun[block.config.queryId];
  if (failedReason !== undefined) {
    // Not an empty table — an empty table reads as "no rows".
    const note = sheet.getCell(1, 1);
    note.value = `\u26A0 This query didn't run, so there is no data here: ${failedReason}`;
    note.font = { bold: true, color: { argb: "FFB91C1C" } };
    sheet.getColumn(1).width = 90;
    return;
  }
  const cols = block.config.columns as any[];
  sheet.columns = cols.map((c) => ({
    header: c.label,
    key: c.key,
    width: Math.max(12, c.label.length + 2),
  }));
  const dateKeys = cols.filter((c) => c.type === "date" || c.type === "datetime").map((c) => c.key as string);
  for (const r of rows) {
    if (!dateKeys.length) { sheet.addRow(r); continue; }
    const out: Record<string, unknown> = { ...r };
    for (const k of dateKeys) out[k] = excelDateValue(r[k]);
    sheet.addRow(out);
  }

  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  cols.forEach((c, i) => {
    const col = sheet.getColumn(i + 1);
    if (c.type === "currency") col.numFmt = numFmtCurrency;
    else if (c.type === "percent") col.numFmt = "0.0%";
    else if (c.type === "number") col.numFmt = "#,##0";
    else if (c.type === "date") col.numFmt = dateFmts.date;
    else if (c.type === "datetime") col.numFmt = dateFmts.datetime;
  });

  if (block.config.showTotals && cols.some((c) => c.total !== "none") && rows.length > 0) {
    const totals = cols.reduce((acc: Record<string, unknown>, c) => {
      if (c.total !== "none") acc[c.key] = aggregate(rows, c.key, c.total);
      return acc;
    }, {});
    const tr = sheet.addRow(totals);
    tr.font = { bold: true };
    tr.border = { top: { style: "thin" } };
  }

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: cols.length },
  };
}

async function captureBlockImages(
  reportId: string,
  tenantId: string,
  // The chart screenshots are of data too, so they render as the same
  // viewer as the rest of the file.
  viewer: RunViewer,
  params: Record<string, unknown>,
  report: Report,
  authCookie: string | null,
  out: Record<string, BlockImage>
) {
  const blocks = report.pages.flatMap((pg) => pg.blocks).filter((b) => b.type === "chart" || b.type === "image");
  // Nothing to screenshot, so don't take a browser slot for nothing.
  if (blocks.length === 0) return;

  await withBrowserPage("xlsx", async (page) => {
    const viewport = { width: 900, height: 1400, deviceScaleFactor: 2 };
    await page.setViewport(viewport);
    // The page shows the blocks this viewer may see, so every block kept by
    // visibleReport() in renderXlsx, filtered as the same viewer, is there to
    // capture. The cron hands in a report already filtered narrower, and the
    // extra blocks the page shows then are never captured.
    await openReportViewer(page, "XLSX export", { reportId, tenantId, viewer, blocksAsViewer: true, params, authCookie });
    // Every screenshot below stays inside the viewport (captureBeyondViewport:
    // false). A block taller than the viewport would come out cropped, so
    // grow the viewport to fit the tallest one first. Only the height changes,
    // and the chart boxes are sized by the grid, so nothing redraws.
    const tallest = await page.evaluate(
      (ids: string[]) => Math.max(0, ...ids.map((id) => document.querySelector(`[data-block-id="${id}"]`)?.getBoundingClientRect().height ?? 0)),
      blocks.map((b) => b.id),
    );
    if (tallest > viewport.height) await page.setViewport({ ...viewport, height: Math.ceil(tallest) + 16 });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));

    for (const block of blocks) {
      // ReportDocument wraps every block in [data-block-id]. If one is
      // missing from a page that did render, this capture is wrong, and
      // shipping the file without that block would be too.
      const el = await page.$(`[data-block-id="${block.id}"]`);
      // captureBeyondViewport (Puppeteer's default) makes Chrome shrink the
      // window to 1x1 and back around the shot. Every Recharts container
      // measures 0x0 at that size and drops its chart, then redraws a few
      // hundred ms later. A shot that lands in that gap is an empty card.
      // Observed with the production image under load on 2026-09-23, by
      // putting a ResizeObserver on the chart containers. With it off,
      // nothing on the page moves during the shot.
      const png = el ? ((await el.screenshot({ type: "png", encoding: "base64", captureBeyondViewport: false })) as string) : "";
      const box = el ? await el.boundingBox() : null;
      if (!png || !box) {
        throw new Error(`XLSX export: couldn't capture ${block.type} block ${block.id} from report ${reportId}`);
      }
      out[block.id] = { pngBase64: png, widthPx: box.width, heightPx: box.height };
    }
  });
}

export type ExcelDateFormats = { date: string; datetime: string };

/**
 * Excel number formats for date columns. Everyone but a Thai reader keeps
 * the ISO-style look. A Thai reader gets Thai month names and, unless they
 * or the report chose Gregorian, Buddhist-era years through Excel's own
 * Thai Buddhist calendar: [$-107041E] = calendar 07 + locale 041E. Checked
 * in Excel 16 ("26 ก.ย. 2569"); the "bbbb" token does not do this there.
 */
export function excelDateFormats(style?: DateStyle): ExcelDateFormats {
  if (style?.locale !== "th") return { date: "yyyy-mm-dd", datetime: "yyyy-mm-dd hh:mm" };
  const cal = style.era === "ce" ? "[$-41E]" : "[$-107041E]";
  return { date: `${cal}d mmm yyyy`, datetime: `${cal}d mmm yyyy hh:mm` };
}

/**
 * A date column's value as a real Excel date — sortable and filterable,
 * where it used to be text Excel couldn't read as a date. Excel has no
 * time zones, so an ISO string keeps its written wall-clock time. Anything
 * unparseable stays as its text.
 */
export function excelDateValue(raw: unknown): Date | string | null {
  if (raw == null || raw === "") return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return String(raw);
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)));
  return isNaN(d.getTime()) ? String(raw) : d;
}
