"use client";
import { createContext, useContext } from "react";

/**
 * Drill-through bridge between block components and the viewer shell.
 *
 * Block components (currently ChartBlock) read this context. When a context
 * is provided AND the block has drilldown configured, clicks on data points
 * call onDrill(blockId, value) which the viewer turns into a slide-out
 * panel. When no context is provided (e.g. PDF/XLSX export, public share,
 * embed without drill-through) the block silently falls back to display-only.
 *
 * Keeping this as a context rather than threading callbacks through every
 * block keeps the ReportDocument renderer reusable across surfaces.
 */
export type DrillThroughHandler = (blockId: string, value: unknown) => void;

export const DrillThroughContext = createContext<DrillThroughHandler | null>(null);

export function useDrillThrough(): DrillThroughHandler | null {
  return useContext(DrillThroughContext);
}
