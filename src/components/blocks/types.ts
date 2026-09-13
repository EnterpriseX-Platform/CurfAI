import type { Block, Report } from "@/lib/reporting/schema";
import type { Dataset } from "@/lib/reporting/interpolate";
import type { ProvenanceMap } from "@/lib/reporting/provenance";

/** Props every block component receives. */
export type BlockRenderContext = {
  block: Block;
  report: Report;
  dataset: Dataset;
  params: Record<string, unknown>;
  /** true when rendering inside the PDF/export pipeline — disables interactivity. */
  print?: boolean;
  /** Per-query provenance records (Trust Layer). Missing during designer preview. */
  provenance?: ProvenanceMap;
  /** DB id of the report (for Ask / action routes). Missing during designer preview. */
  reportDbId?: string;
  /** true when this block is the sole content of an already-carded container
   *  (e.g. a Dashboard grid cell, which shows its own title/border/status
   *  badge) — the block should skip its own outer border/padding and title
   *  header instead of nesting a second frame around the same content. */
  bare?: boolean;
};
