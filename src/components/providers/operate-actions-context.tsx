"use client";
import { createContext, useContext } from "react";

/**
 * Operate-actions bridge between block components and the viewer shell.
 *
 * Mirrors the DrillThroughContext pattern, but for Curf Operate. When a
 * chart bar / pie slice / table cell is clicked, the block calls
 * `onAction({...})` if the context is provided. The viewer shell turns
 * that into a popover listing matching ActionTemplate recipes (filtered
 * by `triggerKind=chart_click` on the server) and, on selection, opens
 * the existing New Request dialog with the row prefilled.
 *
 * When no context is provided (PDF export, public share, embed surfaces
 * that don't ship Operate), blocks silently fall back to display-only —
 * same gracefulness as DrillThroughContext.
 */
export type OperateActionRequest = {
  reportId: string;
  blockId: string;
  /** The full row object the user clicked. */
  row: Record<string, unknown>;
  /** The x-axis field key (e.g. "province", "month"). */
  field?: string;
  /** The x-axis value (e.g. "นครราชสีมา", "2026-04"). */
  value?: unknown;
  /** Viewport coordinates, optional — used to anchor the popover near the cursor. */
  anchor?: { x: number; y: number };
};

export type OperateActionsHandler = (req: OperateActionRequest) => void;

export const OperateActionsContext = createContext<OperateActionsHandler | null>(null);

export function useOperateActions(): OperateActionsHandler | null {
  return useContext(OperateActionsContext);
}

/**
 * Phase 11 (uplift) — a second, narrower bridge alongside the one above.
 * Where OperateActionsContext answers "which templates apply to a clicked
 * row" (chart_click scoping, picker-first), this answers "is there ONE
 * template whose outcome ledger (F5) points at this exact KPI" — the
 * cross-reference BriefKpiCard's contextual Act button uses to name itself
 * after the template it will open, instead of a generic "⚡ Act". Returns
 * null when no provider is mounted (same graceful degrade) or when no
 * template's outcome matches.
 */
export type OperateKpiMatch = { templateId: string; templateName: string };
export type OperateKpiMatchLookup = (reportId: string, blockId: string) => OperateKpiMatch | null;

export const OperateKpiMatchContext = createContext<OperateKpiMatchLookup | null>(null);

export function useOperateKpiMatch(): OperateKpiMatchLookup | null {
  return useContext(OperateKpiMatchContext);
}

/** Opens the New Request dialog directly against a known template — no
 *  chart_click picker, since the caller already knows which one it wants. */
export type OpenMatchedRequest = (
  templateId: string,
  prefillInput: Record<string, unknown>,
  reportId: string,
  blockId: string,
) => void;

export const OpenMatchedRequestContext = createContext<OpenMatchedRequest | null>(null);

export function useOpenMatchedRequest(): OpenMatchedRequest | null {
  return useContext(OpenMatchedRequestContext);
}
