/**
 * The single source of truth for how a report is rendered.
 * Used by:
 *   - the viewer (interactive HTML)
 *   - the designer preview pane
 *   - the PDF export pipeline (Puppeteer opens a URL that renders this)
 *
 * One grid unit = ~40px tall x 1/12th of page width wide. That ratio is
 * what keeps the designer canvas visually close to the printed output.
 */
import { BlockRegistry } from "@/components/blocks";
import type { Block, Page, Report } from "@/lib/reporting/schema";
import type { Dataset } from "@/lib/reporting/interpolate";
import type { ProvenanceMap } from "@/lib/reporting/provenance";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { CurrencyProvider } from "@/components/providers/CurrencyProvider";
import { WhyProvider } from "@/components/blocks/WhyDrawer";
import { localizeReport } from "@/lib/reporting/localize";

const ROW_HEIGHT_PX = 40;
const COLUMNS = 12;

const PAGE_WIDTH_MM: Record<string, { portrait: number; landscape: number }> = {
  A4:     { portrait: 210, landscape: 297 },
  Letter: { portrait: 216, landscape: 279 },
  Legal:  { portrait: 216, landscape: 356 },
};
const PAGE_HEIGHT_MM: Record<string, { portrait: number; landscape: number }> = {
  A4:     { portrait: 297, landscape: 210 },
  Letter: { portrait: 279, landscape: 216 },
  Legal:  { portrait: 356, landscape: 216 },
};

/**
 * "paper" draws each page as the sheet it will print as (A4/Letter width,
 * white, 15mm margins) — the designer, PDF, share and embed surfaces all
 * want that fidelity. "canvas" is the interactive viewer: the same grid,
 * but laid straight on the app's ground at full width, cards separated by
 * their own borders — no sheet, no margins.
 */
export type ReportSurface = "paper" | "canvas";

function PageRenderer({
  page, report, dataset, params, print, pageIndex, totalPages, provenance, reportDbId, surface = "paper",
}: {
  page: Page;
  report: Report;
  dataset: Dataset;
  params: Record<string, unknown>;
  print?: boolean;
  pageIndex: number;
  totalPages: number;
  provenance?: ProvenanceMap;
  reportDbId?: string;
  surface?: ReportSurface;
}) {
  const widthMm = PAGE_WIDTH_MM[page.size][page.orientation];
  const heightMm = PAGE_HEIGHT_MM[page.size][page.orientation];
  const canvas = surface === "canvas" && !print;

  const maxRow = page.blocks.reduce((m, b) => Math.max(m, b.y + b.h), 0);

  // Sort blocks by visual reading order (top → bottom, left → right) so the
  // mobile single-column stack flows in the same order the author laid them
  // out on the canvas. Without this, two blocks at the same y would appear
  // in declaration order instead of left-to-right order.
  const sortedBlocks = [...page.blocks].sort((a, b) => (a.y - b.y) || (a.x - b.x));

  return (
    <section
      className={canvas
        ? "report-page report-page-responsive relative w-full"
        : "report-page report-page-responsive relative mx-auto bg-card shadow-sm"}
      style={canvas ? undefined : {
        // Use mm width via CSS variable so the responsive override (in
        // ReportDocument's <style> tag) can clamp to viewport on phones
        // without dropping the desktop A4 look.
        ["--page-width-mm" as any]: `${widthMm}mm`,
        width: `${widthMm}mm`,
        maxWidth: "100%",
        minHeight: print ? `${heightMm}mm` : undefined,
        padding: "15mm",
        breakAfter: print ? "page" : undefined,
      }}
    >
      {totalPages > 1 && (
        <div className="no-print mb-2 flex items-center justify-between text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          <span>{report.name}</span>
          <span>Page {pageIndex + 1} of {totalPages}</span>
        </div>
      )}
      <div
        className="report-grid relative"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${COLUMNS}, 1fr)`,
          gridAutoRows: `${ROW_HEIGHT_PX}px`,
          gap: canvas ? "14px" : "8px",
          minHeight: `${Math.max(maxRow, 1) * ROW_HEIGHT_PX}px`,
        }}
      >
        {sortedBlocks.map((block) => (
          <BlockCell key={block.id} block={block}>
            <RenderBlock block={block} report={report} dataset={dataset} params={params} print={print} provenance={provenance} reportDbId={reportDbId} />
          </BlockCell>
        ))}
      </div>
    </section>
  );
}

function BlockCell({ block, children }: { block: Block; children: React.ReactNode }) {
  return (
    <div
      data-block-id={block.id}
      data-block-type={block.type}
      data-block-h={block.h}
      style={{
        // Inline grid coords drive the desktop layout. The mobile media
        // query in ReportDocument's <style> override switches to flex
        // single-column flow so each block stacks full-width.
        gridColumn: `${block.x + 1} / span ${block.w}`,
        gridRow: `${block.y + 1} / span ${block.h}`,
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

/**
 * Resolves a block's registered Component and renders it. Exported so the
 * designer canvas (Canvas.tsx) can render blocks through the exact same
 * dispatch — including the "Unknown block" fallback — instead of keeping a
 * second copy that drifts from this one.
 */
export function RenderBlock(ctx: {
  block: Block;
  report: Report;
  dataset: Dataset;
  params: Record<string, unknown>;
  print?: boolean;
  provenance?: ProvenanceMap;
  reportDbId?: string;
}) {
  const entry = BlockRegistry[ctx.block.type];
  if (!entry) return <div className="text-xs text-destructive">Unknown block: {ctx.block.type}</div>;
  const C = entry.Component;
  return <C {...ctx} />;
}

export function ReportDocument({
  report, dataset, params, print, provenance, reportDbId,
  userPrefs, tenantBrand, tenantCurrency, locale, surface = "paper",
}: {
  report: Report;
  dataset: Dataset;
  params: Record<string, unknown>;
  print?: boolean;
  /** "paper" (default) draws printable sheets; "canvas" lays the grid on the
   *  app ground at full width — the interactive viewer's look. */
  surface?: ReportSurface;
  /** Trust Layer — per-query provenance. Renders as shield badges on data-bound blocks. */
  provenance?: ProvenanceMap;
  /** DB id of the report (for Ask / action routes). */
  reportDbId?: string;
  /** Personalization layer (Slice B/C). Optional — viewer falls back to
   *  report.theme when both are missing. */
  userPrefs?: { themeOverride?: string | null; mode?: string; density?: string; reducedMotion?: boolean };
  tenantBrand?: { defaultTheme?: string; defaultChartStyle?: string; customPalette?: string[]; logoUrl?: string; accentColor?: string };
  /** Tenant.currency — the fallback every currency-formatted block resolves
   *  to when the report itself has no currency override. Kept separate
   *  from tenantBrand: that panel is Business-gated, currency isn't. */
  tenantCurrency?: string | null;
  /** Content locale (see lib/reporting/localize.ts) — a different axis from
   *  the app's own UI language. Omit to render the report exactly as
   *  authored, ignoring any `i18n` overrides it carries. */
  locale?: string;
}) {
  // Resolve density / mode as data attrs on the wrapper so global CSS can
  // tighten paddings (density="compact") and apply dark mode independently
  // of the chart palette swap.
  const density = userPrefs?.density ?? "comfortable";
  const mode = userPrefs?.mode ?? "auto";
  const motion = userPrefs?.reducedMotion ? "reduce" : "auto";
  const doc = localizeReport(report, locale);
  return (
    <ThemeProvider
      reportTheme={(doc as any).theme}
      userOverride={userPrefs?.themeOverride ?? null}
      tenantDefault={tenantBrand?.defaultTheme ?? null}
      tenantCustomPalette={tenantBrand?.customPalette}
      reportChartStyle={(doc as any).chartStyle}
      tenantDefaultChartStyle={tenantBrand?.defaultChartStyle ?? null}
    >
    <CurrencyProvider reportCurrency={(doc as any).currency} tenantCurrency={tenantCurrency}>
    <WhyProvider>
      {/* Mobile-responsive overrides. Below 640px the rigid 12-col grid
          collapses into a single-column stack — every block becomes full
          width with auto-height so charts and tables don't get squashed
          into tiny tiles on a phone.
          IMPORTANT: use `dangerouslySetInnerHTML` instead of a child text
          node here. Server HTML-encodes `>` and `"` inside <style>
          children, but the client doesn't, which causes a hydration text
          mismatch under React 18. innerHTML bypasses the diff entirely.
          We deliberately keep the desktop + print path on the inline-
          style grid so PDF export pixel-matches the canvas exactly. */}
      <style dangerouslySetInnerHTML={{ __html: `
        @media (max-width: 640px) {
          .report-page-responsive {
            width: 100% !important;
            padding: 12px !important;
            box-shadow: none !important;
          }
          .report-page-responsive .report-grid {
            display: flex !important;
            flex-direction: column !important;
            gap: 12px !important;
            grid-auto-rows: initial !important;
            min-height: 0 !important;
          }
          .report-page-responsive .report-grid > div {
            grid-column: 1 / -1 !important;
            grid-row: auto !important;
            width: 100% !important;
            min-height: ${ROW_HEIGHT_PX * 4}px;
          }
          .report-page-responsive .report-grid > div[data-block-type="title"] { min-height: 0 !important; }
          .report-page-responsive .report-grid > div[data-block-type="text"]  { min-height: 0 !important; }
          .report-page-responsive .report-grid > div[data-block-type="divider"] { min-height: 0 !important; }
          .report-page-responsive .report-grid > div[data-block-type="callout"] { min-height: 80px !important; }
          .report-page-responsive .report-grid > div[data-block-type="kpi"] { min-height: 120px !important; }
          .report-page-responsive .report-grid > div[data-block-type="chart"] { min-height: 320px !important; }
          .report-page-responsive .report-grid > div[data-block-type="table"] { min-height: 280px !important; }
          .report-page-responsive .report-grid > div[data-block-type="map"] { min-height: 360px !important; }
          .report-page-responsive .report-grid > div[data-block-type="heatmap"] { min-height: 320px !important; }
          .report-page-responsive .report-grid > div[data-block-type="pivot"] { min-height: 280px !important; }
          .report-page-responsive .report-grid > div[data-block-type="pageBreak"] { display: none !important; }
        }
      ` }} />
      <div
        className={surface === "canvas" && !print
          ? "report-doc flex flex-col gap-8"
          : "report-doc flex flex-col items-center gap-6 bg-muted/40 p-6 print:bg-card print:p-0 sm:p-6 max-sm:p-0"}
        data-density={density}
        data-mode={mode}
        data-motion={motion}
      >
        {doc.pages.map((page, i) => (
          <PageRenderer
            key={page.id}
            page={page}
            report={doc}
            dataset={dataset}
            params={params}
            print={print}
            pageIndex={i}
            totalPages={doc.pages.length}
            provenance={provenance}
            reportDbId={reportDbId}
            surface={surface}
          />
        ))}
      </div>
    </WhyProvider>
    </CurrencyProvider>
    </ThemeProvider>
  );
}
