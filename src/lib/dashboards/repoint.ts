/**
 * When Master Builder replaces a report, a dashboard's cards of it move to the new one (lib/dashboards/slotKey.ts). A whole
 * report just changes id. A block card keeps its block when the new design still has a block of that id; a new design has
 * its own block ids, so otherwise the card falls back to the whole new report rather than pointing at a block that is gone.
 * Pure: the applier supplies the new report's block ids and writes the result.
 */
import { parseSlotKey, slotKey } from "./slotKey";

export type RepointedCards = { reportIdsJson: string; slotLayoutJson: string; fellBack: number };

export function repointCards(args: {
  reportIdsJson: string | null | undefined;
  slotLayoutJson: string | null | undefined;
  fromId: string;
  toId: string;
  hasBlock: (blockId: string) => boolean;
}): RepointedCards {
  const { fromId, toId, hasBlock } = args;
  const mapKey = (key: string): string => {
    const r = parseSlotKey(key);
    if (r.reportId !== fromId) return key;
    return slotKey(toId, r.blockId && hasBlock(r.blockId) ? r.blockId : null);
  };

  let fellBack = 0;
  let reportIdsJson = args.reportIdsJson ?? "";
  try {
    const keys: unknown = JSON.parse(reportIdsJson);
    if (Array.isArray(keys) && keys.every((k) => typeof k === "string")) {
      const seen = new Set<string>();
      const next: string[] = [];
      for (const k of keys as string[]) {
        const nk = mapKey(k);
        if (parseSlotKey(k).reportId === fromId && parseSlotKey(k).blockId && !parseSlotKey(nk).blockId) fellBack += 1;
        if (seen.has(nk)) continue;
        seen.add(nk);
        next.push(nk);
      }
      reportIdsJson = JSON.stringify(next);
    }
  } catch { /* unreadable: leave it as it was */ }

  let slotLayoutJson = args.slotLayoutJson ?? "";
  try {
    const layout: unknown = JSON.parse(slotLayoutJson);
    if (layout && typeof layout === "object" && !Array.isArray(layout)) {
      const next: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(layout as Record<string, unknown>)) {
        const nk = mapKey(k);
        if (!(nk in next)) next[nk] = v;
      }
      slotLayoutJson = JSON.stringify(next);
    }
  } catch { /* unreadable: leave it as it was */ }

  return { reportIdsJson, slotLayoutJson, fellBack };
}
