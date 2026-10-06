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
import { BLOCK_META as BlockRegistry } from "./registryMeta";
import { BlockType } from "@/lib/reporting/schema";
import { EmptyState } from "@/components/common/EmptyState";
import type { QueryNotRun } from "@/lib/reporting/queryRunState";
import { AlertTriangle } from "lucide-react";

export function BlockEmptyState({
  type, blockId, title, typeLabel, description, notRun,
}: {
  type: BlockType;
  blockId: string;
  title?: string;
  /**
   * The block type's name in the reader's language (`t("blockType.<type>")`),
   * shown when the block has no title of its own.
   */
  typeLabel: string;
  /**
   * What to say, in the reader's language: every caller is a client block
   * with `useT()` in scope (`t("blockEmpty.noData")`, or the failed /
   * restricted text when `notRun` is set). This component stays hook-free
   * (see below), and it has no dictionary of its own: that would ship every
   * language to the browser.
   */
  description: string;
  /**
   * Set when the block is empty because its query did NOT run (it failed, or
   * the viewer can't see its source) rather than because it returned nothing.
   * "No data to show yet" is a lie in that case: it reads as "come back later"
   * where the truth is "this is broken". The caller passes the matching
   * translated `description`; the reason itself is shown verbatim.
   */
  notRun?: QueryNotRun;
}) {
  const Icon = BlockRegistry[type].icon;

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
        compact={!!notRun}
        icon={notRun ? <AlertTriangle className="h-4 w-4" /> : <Icon className="h-5 w-5" />}
        title={title ? title : typeLabel}
        description={description}
        preview={notRun ? (
          <div
            role="alert"
            data-block-not-run={notRun.kind}
            // The block may be a short fixed-height slot: clamp to two lines, full text on hover.
            title={notRun.reason}
            className={`mx-auto line-clamp-2 max-w-sm break-words rounded-md border px-2 py-1 font-mono text-[11px] leading-snug ${
              notRun.kind === "failed" ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-warning/30 bg-warning/5 text-warning"
            }`}
          >
            {notRun.reason}
          </div>
        ) : undefined}
        className="h-full"
      />
    </div>
  );
}
