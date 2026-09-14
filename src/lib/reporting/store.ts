"use client";
/**
 * Zustand store for the designer.
 * Wraps state in temporal() (zundo) so we get undo/redo with no extra wiring.
 */
import { create } from "zustand";
import { temporal } from "zundo";
import { BLOCK_META as BlockRegistry } from "@/components/blocks/registryMeta";
import {
  BlockConfigSchemas, type Block, type BlockType, type Report,
} from "@/lib/reporting/schema";

/**
 * A pre-configured block (or sequence of blocks) the user can drop in from the
 * Templates section of the palette. Each entry lays out below existing content
 * preserving its relative x/y so multi-block bundles stay aligned.
 */
export type BlockTemplateEntry = {
  type: BlockType;
  x: number;
  y: number;
  w: number;
  h: number;
  config: Record<string, unknown>;
};

type State = {
  report: Report;
  activePageId: string;
  selectedBlockId: string | null;
  configModalOpen: boolean;
  setConfigModalOpen: (open: boolean) => void;
  setReport: (r: Report) => void;
  selectBlock: (id: string | null) => void;
  addBlock: (type: BlockType, x?: number, y?: number) => void;
  addBlockTemplate: (entries: BlockTemplateEntry[], yOffset?: number) => void;
  updateBlockLayout: (id: string, layout: { x: number; y: number; w: number; h: number }) => void;
  updateBlockConfig: (id: string, patch: Record<string, unknown>) => void;
  updateBlockMeta: (id: string, patch: Record<string, unknown>) => void;
  removeBlock: (id: string) => void;
  duplicateBlock: (id: string) => void;
  updateReportMeta: (patch: Partial<Pick<Report, "name" | "description" | "category" | "theme" | "display">>) => void;
  addPage: () => void;
  removePage: (pageId: string) => void;
  setActivePage: (pageId: string) => void;
};

function defaultConfig(type: BlockType): any {
  const schema = BlockConfigSchemas[type] as any;
  try {
    return schema.parse({
      ...(type === "table" ? { queryId: "", columns: [] } : {}),
      ...(type === "kpi" ? { queryId: "", valueField: "" } : {}),
      ...(type === "chart" ? { queryId: "", xField: "", yFields: ["value"] } : {}),
      ...(type === "pivot" ? { queryId: "", rowField: "", colField: "", valueField: "" } : {}),
      ...(type === "heatmap" ? { queryId: "", valueField: "", mode: "calendar" } : {}),
      ...(type === "map" ? { queryId: "", regionField: "", valueField: "" } : {}),
      ...(type === "image" ? { src: "/logo.png" } : {}),
    });
  } catch {
    return {};
  }
}

export const useDesignerStore = create<State>()(
  temporal((set, get) => ({
    report: {
      version: 1,
      name: "Untitled",
      parameters: [],
      dataSources: [],
      pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [] }],
    },
    activePageId: "p1",
    selectedBlockId: null,
    configModalOpen: false,
    setConfigModalOpen: (open) => set({ configModalOpen: open }),

    setReport: (r) => set({ report: r, activePageId: r.pages[0]?.id ?? "p1", selectedBlockId: null }),
    selectBlock: (id) => set({ selectedBlockId: id }),

    addBlock: (type, x, y) => {
      const entry = BlockRegistry[type];
      const state = get();
      const page = state.report.pages.find((p) => p.id === state.activePageId);
      const autoY = page ? page.blocks.reduce((m, b) => Math.max(m, b.y + b.h), 0) : 0;
      const block: Block = {
        id: crypto.randomUUID(),
        type,
        x: x ?? 0,
        y: y ?? autoY,
        w: entry.defaultSize.w,
        h: entry.defaultSize.h,
        config: defaultConfig(type),
      } as Block;
      set((s) => ({
        report: {
          ...s.report,
          pages: s.report.pages.map((p) =>
            p.id === s.activePageId ? { ...p, blocks: [...p.blocks, block] } : p
          ),
        },
        selectedBlockId: block.id,
      }));
    },

    addBlockTemplate: (entries, yOffset) => {
      if (!entries.length) return;
      const state = get();
      const page = state.report.pages.find((p) => p.id === state.activePageId);
      const baseY = yOffset !== undefined ? yOffset : (page ? page.blocks.reduce((m, b) => Math.max(m, b.y + b.h), 0) : 0);
      const newBlocks: Block[] = entries.map((e) => ({
        id: crypto.randomUUID(),
        type: e.type,
        x: e.x,
        y: baseY + e.y,
        w: e.w,
        h: e.h,
        config: e.config as any,
      } as Block));
      set((s) => ({
        report: {
          ...s.report,
          pages: s.report.pages.map((p) =>
            p.id === s.activePageId ? { ...p, blocks: [...p.blocks, ...newBlocks] } : p
          ),
        },
        selectedBlockId: newBlocks[0].id,
      }));
    },

    updateBlockLayout: (id, layout) =>
      set((s) => ({
        report: {
          ...s.report,
          pages: s.report.pages.map((p) =>
            p.id === s.activePageId
              ? { ...p, blocks: p.blocks.map((b) => (b.id === id ? { ...b, ...layout } : b)) }
              : p
          ),
        },
      })),

    updateBlockMeta: (id, patch) =>
      set((s) => ({
        report: {
          ...s.report,
          pages: s.report.pages.map((p) =>
            p.id === s.activePageId
              ? { ...p, blocks: p.blocks.map((b) => (b.id === id ? ({ ...b, ...patch } as any) : b)) }
              : p
          ),
        },
      })),

    updateBlockConfig: (id, patch) =>
      set((s) => ({
        report: {
          ...s.report,
          pages: s.report.pages.map((p) =>
            p.id === s.activePageId
              ? {
                  ...p,
                  blocks: p.blocks.map((b) =>
                    b.id === id ? ({ ...b, config: { ...(b.config as any), ...patch } } as Block) : b
                  ),
                }
              : p
          ),
        },
      })),

    removeBlock: (id) =>
      set((s) => ({
        report: {
          ...s.report,
          pages: s.report.pages.map((p) =>
            p.id === s.activePageId ? { ...p, blocks: p.blocks.filter((b) => b.id !== id) } : p
          ),
        },
        selectedBlockId: s.selectedBlockId === id ? null : s.selectedBlockId,
      })),

    duplicateBlock: (id) => {
      const { report, activePageId } = get();
      const page = report.pages.find((p) => p.id === activePageId);
      const source = page?.blocks.find((b) => b.id === id);
      if (!source) return;
      const copy: Block = { ...source, id: crypto.randomUUID(), y: source.y + source.h };
      set({
        report: {
          ...report,
          pages: report.pages.map((p) =>
            p.id === activePageId ? { ...p, blocks: [...p.blocks, copy] } : p
          ),
        },
        selectedBlockId: copy.id,
      });
    },

    updateReportMeta: (patch) =>
      set((s) => ({ report: { ...s.report, ...patch } })),

    addPage: () => set((s) => {
      const newPage = { id: crypto.randomUUID(), size: "A4" as const, orientation: "portrait" as const, blocks: [] };
      return { report: { ...s.report, pages: [...s.report.pages, newPage] }, activePageId: newPage.id };
    }),

    removePage: (pageId) => set((s) => {
      if (s.report.pages.length <= 1) return s;
      const pages = s.report.pages.filter((pg) => pg.id !== pageId);
      const activePageId = s.activePageId === pageId ? pages[0].id : s.activePageId;
      return { report: { ...s.report, pages }, activePageId };
    }),

    setActivePage: (pageId) => set({ activePageId: pageId, selectedBlockId: null }),
  }), { limit: 100 })
);

import { useStore as useZustandStore } from "zustand";
export const useCanUndo = () =>
  useZustandStore(useDesignerStore.temporal, (s: any) => s.pastStates.length > 0);
export const useCanRedo = () =>
  useZustandStore(useDesignerStore.temporal, (s: any) => s.futureStates.length > 0);
