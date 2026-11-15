/**
 * The cards of a dashboard (lib/dashboards/slotKey.ts) that point at something real in this workspace: the report is theirs
 * and, for a block card, the block is still in it. Kept in the order given. Shared by the create and update routes so the
 * two cannot disagree about what a dashboard may hold.
 */
import { prisma } from "@/lib/db";
import { findBlock, parseSlotKey } from "./slotKey";

export async function validSlotKeys(tenantId: string, keys: string[]): Promise<string[]> {
  const refs = keys.map((k) => ({ key: k, ...parseSlotKey(k) }));
  const needDefinition = new Set(refs.filter((r) => r.blockId).map((r) => r.reportId));
  const rows = await prisma.report.findMany({
    where: { id: { in: [...new Set(refs.map((r) => r.reportId))] }, tenantId },
    select: { id: true, definition: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return refs
    .filter((r) => {
      const row = byId.get(r.reportId);
      if (!row) return false;
      if (!r.blockId) return true;
      if (!needDefinition.has(r.reportId)) return false;
      try { return !!findBlock(JSON.parse(row.definition), r.blockId); } catch { return false; }
    })
    .map((r) => r.key);
}
