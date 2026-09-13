/**
 * Shown by a block whose query returned nothing.
 *
 * Deliberately presentational — no designer store, no handlers. It used to
 * call useDesignerStore for click/double-click selection, which had two
 * problems:
 *
 *   1. It CRASHED every server-rendered surface. This component carries no
 *      "use client", and neither does ReportDocument, so on a public app at
 *      /apps/[slug] the hook ran on the server and threw "useDesignerStore
 *      is not a function" — blanking the whole page whenever any block had
 *      no data.
 *   2. The copy told whoever was looking to "double click here or use the
 *      properties panel", which is a designer instruction being shown to
 *      anonymous viewers of a published app and in exported PDFs.
 *
 * Nothing is lost in the designer: Canvas.tsx already binds onClick →
 * selectBlock and onDoubleClick → setConfigModalOpen on each block wrapper
 * (Canvas.tsx:165-166), so the handlers here were duplicates of the real
 * ones a level up.
 */
import { BlockRegistry } from "@/components/blocks";
import { BlockType } from "@/lib/reporting/schema";
import { EmptyState } from "@/components/common/EmptyState";
import { DICT } from "@/lib/i18n/dict";

export function BlockEmptyState({
  type, blockId, title, description,
}: {
  type: BlockType;
  blockId: string;
  title?: string;
  /**
   * Pre-translated override — most callers are Client Components with
   * `useT()` already in scope (KpiBlock, ChartBlock, TableBlock,
   * HeatmapBlock all pass `t("blockEmpty.noData")` here). Callers that
   * can't resolve a locale (this component is deliberately hook-free — see
   * below) fall back to the dict's English string, which is still a single
   * source of truth rather than a second hardcoded copy of the same text.
   */
  description?: string;
}) {
  const meta = BlockRegistry[type];
  const Icon = meta.icon;

  return (
    <div data-block-empty={blockId} className="h-full w-full">
      {/*
       * No `"use client"` here, and BlockEmptyState must stay hook-free:
       * it renders inside a public app's server-rendered report tree
       * (/apps/[slug]) as well as inside client blocks, and a hook here
       * once threw "useDesignerStore is not a function" and blanked the
       * whole public page. EmptyState itself is equally hook-free, so
       * this composition preserves that guarantee.
       */}
      <EmptyState
        icon={<Icon className="h-5 w-5" />}
        title={title ? title : meta.label}
        description={description ?? DICT.en["blockEmpty.noData"]}
        className="h-full"
      />
    </div>
  );
}
