"use client";
import { useMemo } from "react";
import GridLayout, { type Layout } from "react-grid-layout";
import { GripVertical, MousePointerClick, Database, PlayCircle, LayoutTemplate } from "lucide-react";
import { BlockRegistry } from "@/components/blocks";
import { BLOCK_TEMPLATES } from "@/lib/reporting/blockTemplates";
import { useDesignerStore } from "@/lib/reporting/store";
import type { Block, Page } from "@/lib/reporting/schema";
import type { Dataset } from "@/lib/reporting/interpolate";
import { RenderBlock } from "@/components/reports/ReportDocument";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { CurrencyProvider } from "@/components/providers/CurrencyProvider";
import { WhyProvider } from "@/components/blocks/WhyDrawer";
import { RulerH, RulerV } from "./Ruler";
import "react-grid-layout/css/styles.css";

const COLS = 12;
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

export function Canvas({
  dataset, params, showRulers = false, reportDbId, tenantBrand,
}: {
  dataset: Dataset;
  params: Record<string, unknown>;
  showRulers?: boolean;
  /** Workspace fallbacks — without these the canvas previews a different
   *  theme and chart style than the published report actually renders. */
  tenantBrand?: { defaultTheme?: string; defaultChartStyle?: string; customPalette?: string[] };
  /** DB id of the report being edited (for Ask/action routes on blocks). */
  reportDbId?: string;
}) {
  const report = useDesignerStore((s) => s.report);
  const activePageId = useDesignerStore((s) => s.activePageId);
  const selectedBlockId = useDesignerStore((s) => s.selectedBlockId);
  const selectBlock = useDesignerStore((s) => s.selectBlock);
  const setConfigModalOpen = useDesignerStore((s) => s.setConfigModalOpen);
  const addBlock = useDesignerStore((s) => s.addBlock);
  const addBlockTemplate = useDesignerStore((s) => s.addBlockTemplate);
  const updateLayout = useDesignerStore((s) => s.updateBlockLayout);

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
    <WhyProvider>
    <div className="mx-auto w-full" style={{ maxWidth: CANVAS_WIDTH + (showRulers ? 20 : 0) }}>
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
                <div className="h-full w-full p-2">
                  <RenderBlock block={block} report={report} dataset={dataset} params={params} print={false} reportDbId={reportDbId} />
                </div>
              </div>
            ))}
          </GridLayout>
        </div>
      </div>
      <p className={`mt-3 text-center text-[11px] text-muted-foreground ${showRulers ? "pl-5" : ""}`}>
        {page.size} · {page.orientation} · {pageMm.w}×{pageMm.h} mm
      </p>
    </div>
    </WhyProvider>
    </CurrencyProvider>
    </ThemeProvider>
  );
}

function BlockHeaderChip({ block, selected }: { block: Block; selected?: boolean }) {
  const label = BlockRegistry[block.type].label;
  return (
    <div
      title="Drag to move block"
      className={`drag-handle absolute left-0 top-0 z-10 flex cursor-grab items-center gap-1 rounded-br-md bg-primary/90 px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground transition-opacity active:cursor-grabbing ${
        selected ? "opacity-100" : "opacity-0 group-hover:opacity-90"
      }`}
    >
      <GripVertical className="h-3 w-3" />
      {label}
    </div>
  );
}

function EmptyCanvasGuide() {
  return (
    <div className="mx-auto flex max-w-lg min-h-[400px] flex-col items-center justify-center p-8 text-center">
      <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-8 ring-primary/5">
        <LayoutTemplate className="h-7 w-7" />
      </div>
      <h3 className="text-xl font-bold tracking-tight text-foreground">Let's build your first report!</h3>
      <p className="mt-2 mb-8 text-sm text-muted-foreground">
        Creating a report is as simple as 1, 2, 3. Follow these steps to get started:
      </p>

      <div className="grid w-full gap-4 sm:grid-cols-3">
        <div className="flex flex-col items-center text-center p-4 rounded-xl border border-border bg-card">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <MousePointerClick className="h-5 w-5" />
          </div>
          <h4 className="text-sm font-semibold">1. Pick & Drop</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Click or drag blocks like Charts, Tables, or text from the left panel onto this canvas.
          </p>
        </div>

        <div className="flex flex-col items-center text-center p-4 rounded-xl border border-border bg-card">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Database className="h-5 w-5" />
          </div>
          <h4 className="text-sm font-semibold">2. Connect Data</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Select a block to write its SQL query or connect an API using the properties on the right.
          </p>
        </div>

        <div className="flex flex-col items-center text-center p-4 rounded-xl border border-border bg-card">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <PlayCircle className="h-5 w-5" />
          </div>
          <h4 className="text-sm font-semibold">3. Preview</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Hit the &quot;Run&quot; button at the top to fetch your data and see the report come to life.
          </p>
        </div>
      </div>
    </div>
  );
}

