"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import GridLayout, { type Layout } from "react-grid-layout";
import { GripVertical, MousePointerClick, Database, PlayCircle, LayoutTemplate } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { BlockRegistry } from "@/components/blocks";
import { BLOCK_TEMPLATES } from "@/lib/reporting/blockTemplates";
import { useDesignerStore } from "@/lib/reporting/store";
import type { Block, Page } from "@/lib/reporting/schema";
import type { Dataset } from "@/lib/reporting/interpolate";
import { RenderBlock } from "@/components/reports/ReportDocument";
import { localizeBlock, missingTranslation } from "@/lib/reporting/localize";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { CurrencyProvider } from "@/components/providers/CurrencyProvider";
import { DateStyleProvider } from "@/components/providers/DateStyleProvider";
import { WhyProvider } from "@/components/blocks/WhyDrawer";
import { RulerH, RulerV } from "./Ruler";
import "react-grid-layout/css/styles.css";

const COLS = 12;
const PHONE_MAX = 768;        // px — below this the page is scaled to fit instead of scrolled
const ROW_HEIGHT = 40;
const CANVAS_WIDTH = 820;
const PAPER_PADDING = 28;     // px — white border around the grid
const PAPER_PADDING_TOP = 32; // px — slightly taller top padding

// Page physical sizes (mm)
const PAGE_SIZE_MM: Record<string, { w: number; h: number }> = {
  A4:     { w: 210, h: 297 },
  Letter: { w: 216, h: 279 },
  Legal:  { w: 216, h: 356 },
};

/**
 * The page is drawn at a fixed width (CANVAS_WIDTH). On a phone it is scaled down to fit rather than
 * scrolled sideways, and react-grid-layout is told the scale (`transformScale`) so dragging and resizing stay accurate.
 * Returns the scale (never above 1) and the page's scaled height, which the outer box needs because a transform does
 * not change the space an element takes.
 */
function useFitScale(fullWidth: number, ready: boolean) {
  const boxRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const box = boxRef.current;
    const page = pageRef.current;
    if (!box || !page || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      // Phones only: on a wider screen the designer's own scrolling area handles a page wider than its column.
      const next = window.innerWidth < PHONE_MAX ? Math.min(1, box.clientWidth / fullWidth) : 1;
      setScale((prev) => (Math.abs(prev - next) < 0.001 ? prev : next));
      setHeight(page.offsetHeight * next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(page);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, [fullWidth, ready]);
  return { boxRef, pageRef, scale, height: scale < 1 ? height : null };
}

export function Canvas({
  dataset, params, showRulers = false, reportDbId, tenantBrand, readAs,
}: {
  /** Show the page in this content language (en, th, zh), the way a reader in it sees it. Unset: as written. */
  readAs?: string;
  dataset: Dataset;
  params: Record<string, unknown>;
  showRulers?: boolean;
  /** Workspace fallbacks — without these the canvas previews a different
   *  theme and chart style than the published report actually renders. */
  tenantBrand?: { defaultTheme?: string; defaultChartStyle?: string; customPalette?: string[] };
  /** DB id of the report being edited (for Ask/action routes on blocks). */
  reportDbId?: string;
}) {
  const { t } = useT();
  const report = useDesignerStore((s) => s.report);
  const activePageId = useDesignerStore((s) => s.activePageId);
  const selectedBlockId = useDesignerStore((s) => s.selectedBlockId);
  const selectBlock = useDesignerStore((s) => s.selectBlock);
  const setConfigModalOpen = useDesignerStore((s) => s.setConfigModalOpen);
  const addBlock = useDesignerStore((s) => s.addBlock);
  const addBlockTemplate = useDesignerStore((s) => s.addBlockTemplate);
  const updateLayout = useDesignerStore((s) => s.updateBlockLayout);
  const fit = useFitScale(CANVAS_WIDTH + (showRulers ? 20 : 0), report.pages.some((p) => p.id === activePageId));

  const page: Page | undefined = report.pages.find((p) => p.id === activePageId);
  const layout: Layout[] = useMemo(
    () => (page?.blocks ?? []).map((b) => ({ i: b.id, x: b.x, y: b.y, w: b.w, h: b.h })),
    [page?.blocks]
  );

  if (!page) return null;

  const pageMm = page.orientation === "landscape"
    ? { w: PAGE_SIZE_MM[page.size].h, h: PAGE_SIZE_MM[page.size].w }
    : PAGE_SIZE_MM[page.size];

  const gridWidth = CANVAS_WIDTH - 2 * PAPER_PADDING;
  // Approximate grid height based on tallest block
  const maxRow = page.blocks.reduce((m, b) => Math.max(m, b.y + b.h), 0);
  const gridHeight = Math.max(maxRow * ROW_HEIGHT, 400);

  // If a block is selected, compute its mm range for ruler highlight.
  const selectedBlock = selectedBlockId ? page.blocks.find((b) => b.id === selectedBlockId) : null;
  const mmPerGridCol = pageMm.w / COLS;           // mm per grid column (page width)
  const pxPerGridRow = ROW_HEIGHT;                // px per grid row (visual)
  // Convert px → mm for vertical highlight: ratio of grid height to page height in mm
  // is approximate; clamp to page height.
  const pxPerMmVertical = gridHeight / pageMm.h;
  const hlXStart = selectedBlock ? selectedBlock.x * mmPerGridCol : undefined;
  const hlXEnd   = selectedBlock ? (selectedBlock.x + selectedBlock.w) * mmPerGridCol : undefined;
  const hlYStart = selectedBlock ? (selectedBlock.y * pxPerGridRow) / pxPerMmVertical : undefined;
  const hlYEnd   = selectedBlock ? ((selectedBlock.y + selectedBlock.h) * pxPerGridRow) / pxPerMmVertical : undefined;

  return (
    <ThemeProvider
      reportTheme={(report as any).theme}
      tenantDefault={tenantBrand?.defaultTheme ?? null}
      tenantCustomPalette={tenantBrand?.customPalette}
      reportChartStyle={(report as any).chartStyle}
      tenantDefaultChartStyle={tenantBrand?.defaultChartStyle ?? null}
    >
    <CurrencyProvider reportCurrency={(report as any).currency}>
    <DateStyleProvider reportEra={report.dateEra}>
    <WhyProvider>
    <div ref={fit.boxRef} className="mx-auto w-full" style={{ maxWidth: CANVAS_WIDTH + (showRulers ? 20 : 0), height: fit.height ?? undefined }}>
    <div ref={fit.pageRef} style={{ width: CANVAS_WIDTH + (showRulers ? 20 : 0), transform: fit.scale < 1 ? `scale(${fit.scale})` : undefined, transformOrigin: "top left" }}>
      {showRulers && (
        <div className="flex">
          <div style={{ width: 20 }} />
          <div className="flex">
            <div style={{ width: PAPER_PADDING }} />
            <RulerH
              widthPx={gridWidth}
              pageWidthMm={pageMm.w}
              highlightStartMm={hlXStart}
              highlightEndMm={hlXEnd}
            />
            <div style={{ width: PAPER_PADDING }} />
          </div>
        </div>
      )}

      <div className="flex">
        {showRulers && (
          <div style={{ width: 20, paddingTop: PAPER_PADDING_TOP }}>
            <RulerV
              heightPx={gridHeight}
              pageHeightMm={pageMm.h * (gridHeight / (pageMm.h * pxPerMmVertical))}
              highlightStartMm={hlYStart}
              highlightEndMm={hlYEnd}
            />
          </div>
        )}

        {/* Paper + grid */}
        <div
          className="relative rounded-xl bg-card shadow-lg ring-1 ring-border"
          style={{ padding: `${PAPER_PADDING_TOP}px ${PAPER_PADDING}px`, width: CANVAS_WIDTH, minHeight: "500px" }}
          onClick={(e) => { if (e.target === e.currentTarget) selectBlock(null); }}
        >
          {page.blocks.length === 0 && (
            <div className="absolute inset-0 z-0 flex items-center justify-center pt-8 pointer-events-none">
              <EmptyCanvasGuide />
            </div>
          )}
          <GridLayout
            className="layout z-10"
            style={{ minHeight: "450px" }}
            layout={layout}
            cols={COLS}
            rowHeight={ROW_HEIGHT}
            width={gridWidth}
            transformScale={fit.scale}
            margin={[8, 8]}
            containerPadding={[0, 0]}
            isDraggable
            isResizable
            isDroppable
            droppingItem={{ i: "__dropping-elem__", w: 4, h: 2 }}
            draggableHandle=".drag-handle"
            draggableCancel=".no-drag"
            onDrop={(layout, layoutItem, _event) => {
              const e = _event as DragEvent;
              const data = e.dataTransfer?.getData("application/json");
              if (!data) return;
              try {
                const parsed = JSON.parse(data);
                if (parsed.isTemplate) {
                  const tpl = BLOCK_TEMPLATES.find((t) => t.id === parsed.id);
                  if (tpl) addBlockTemplate(tpl.blocks, layoutItem.y);
                } else if (parsed.type && BlockRegistry[parsed.type as keyof typeof BlockRegistry]) {
                  addBlock(parsed.type, layoutItem.x, layoutItem.y);
                }
              } catch (err) {
                // Ignore parse errors from other drag sources
              }
            }}
            onLayoutChange={(next) => {
              for (const item of next) {
                const current = page.blocks.find((b) => b.id === item.i);
                if (!current) continue;
                if (current.x !== item.x || current.y !== item.y || current.w !== item.w || current.h !== item.h) {
                  updateLayout(item.i, { x: item.x, y: item.y, w: item.w, h: item.h });
                }
              }
            }}
          >
            {page.blocks.map((block) => (
              <div
                key={block.id}
                onClick={(e) => { e.stopPropagation(); selectBlock(block.id); }}
                onDoubleClick={(e) => { e.stopPropagation(); selectBlock(block.id); setConfigModalOpen(true); }}
                data-selected={selectedBlockId === block.id || undefined}
                className="group block-card relative overflow-hidden rounded-lg border border-border bg-card"
              >
                <BlockHeaderChip block={block} selected={selectedBlockId === block.id} />
                {readAs && missingTranslation(report, block, readAs) === "partial" && (
                  <span className="absolute bottom-1.5 right-2 z-10 rounded border border-dashed border-warning bg-warning/10 px-1.5 text-2xs text-warning">
                    {t("designerReadAs.missing").replace("{lang}", t(`designerReadAs.${readAs}`))}
                  </span>
                )}
                <div className="h-full w-full p-2">
                  <RenderBlock block={readAs ? localizeBlock(block, readAs) : block} report={report} dataset={dataset} params={params} print={false} reportDbId={reportDbId} />
                </div>
              </div>
            ))}
          </GridLayout>
        </div>
      </div>
      {readAs && page.blocks.some((b) => missingTranslation(report, b, readAs) === "none") && (
        <p className="mt-3 text-center text-xs text-warning">{t("designerReadAs.none").split("{lang}").join(t(`designerReadAs.${readAs}`))}</p>
      )}
      <p className={`mt-3 text-center text-2xs text-muted-foreground ${showRulers ? "pl-5" : ""}`}>
        {page.size} · {t(page.orientation === "landscape" ? "designerShell.landscape" : "designerShell.portrait")} · {pageMm.w}×{pageMm.h} mm
      </p>
    </div>
    </div>
    </WhyProvider>
    </DateStyleProvider>
    </CurrencyProvider>
    </ThemeProvider>
  );
}

function BlockHeaderChip({ block, selected }: { block: Block; selected?: boolean }) {
  const { t } = useT();
  return (
    <div
      title={t("canvas.dragToMove")}
      className={`drag-handle absolute left-0 top-0 z-10 flex cursor-grab items-center gap-1 rounded-br-md bg-primary/90 px-1.5 py-0.5 text-2xs font-medium text-primary-foreground transition-opacity active:cursor-grabbing ${
        selected ? "opacity-100" : "opacity-0 group-hover:opacity-90"
      }`}
    >
      <GripVertical className="h-3 w-3" />
      {t(`blockType.${block.type}`)}
    </div>
  );
}

function EmptyCanvasGuide() {
  const { t } = useT();
  return (
    <div className="mx-auto flex max-w-lg min-h-[400px] flex-col items-center justify-center p-8 text-center">
      <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <LayoutTemplate className="h-7 w-7" />
      </div>
      <h3 className="text-xl font-bold tracking-tight text-foreground">{t("canvas.empty.title")}</h3>
      <p className="mt-2 mb-8 text-sm text-muted-foreground">{t("canvas.empty.subtitle")}</p>

      <div className="grid w-full gap-4 sm:grid-cols-3">
        <div className="flex flex-col items-center text-center p-4 rounded-xl border border-border bg-card">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <MousePointerClick className="h-5 w-5" />
          </div>
          <h4 className="text-sm font-semibold">{t("canvas.empty.step1")}</h4>
          <p className="mt-1 text-xs text-muted-foreground">{t("canvas.empty.step1Desc")}</p>
        </div>

        <div className="flex flex-col items-center text-center p-4 rounded-xl border border-border bg-card">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Database className="h-5 w-5" />
          </div>
          <h4 className="text-sm font-semibold">{t("canvas.empty.step2")}</h4>
          <p className="mt-1 text-xs text-muted-foreground">{t("canvas.empty.step2Desc")}</p>
        </div>

        <div className="flex flex-col items-center text-center p-4 rounded-xl border border-border bg-card">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <PlayCircle className="h-5 w-5" />
          </div>
          <h4 className="text-sm font-semibold">{t("canvas.empty.step3")}</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("canvas.empty.step3Desc").replace("{run}", t("designerShell.run"))}
          </p>
        </div>
      </div>
    </div>
  );
}

