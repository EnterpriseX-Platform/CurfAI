/**
 * A dashboard card is a whole report ("<reportId>") or one block of a report ("<reportId>#<blockId>"). The key is what the
 * dashboard stores in its report list and what its layout and drill state are keyed by, so a block card needs no schema of
 * its own. Pure and client-safe: the manager, the viewer, the check and the routes all read keys through here.
 */
export type SlotRef = { reportId: string; blockId: string | null };

export function slotKey(reportId: string, blockId?: string | null): string {
  return blockId ? `${reportId}#${blockId}` : reportId;
}

export function parseSlotKey(key: string): SlotRef {
  const i = key.indexOf("#");
  return i < 0 ? { reportId: key, blockId: null } : { reportId: key.slice(0, i), blockId: key.slice(i + 1) || null };
}

/** Blocks that show data: a card for a heading, a paragraph, a picture or a divider would say nothing. */
export const CARD_BLOCK_TYPES = new Set(["kpi", "chart", "table", "pivot", "heatmap", "map", "cohort_retention", "funnel", "progress", "callout"]);

type BlockLike = { id: string; type: string; config?: unknown };
type DefinitionLike = { pages?: Array<{ blocks?: BlockLike[] }> };

/** The blocks of a report that can be a card, in page order. */
export function cardBlocks(def: DefinitionLike | null | undefined): BlockLike[] {
  return (def?.pages ?? []).flatMap((p) => p.blocks ?? []).filter((b) => CARD_BLOCK_TYPES.has(b.type));
}

export function findBlock(def: DefinitionLike | null | undefined, blockId: string): BlockLike | null {
  return cardBlocks(def).find((b) => b.id === blockId) ?? null;
}

/** What a block is called on a card: its own title or label, else its kind. */
export function blockLabel(block: BlockLike): string {
  const c = (block.config ?? {}) as Record<string, unknown>;
  for (const k of ["title", "label", "text"]) {
    const v = c[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return block.type;
}
