/**
 * A lake table's rows as one viewer may see them.
 *
 * previewRows() reads a table raw. Anything that shows those rows to a person
 * (the table page) or hands them to a model (instant views, auto-generate,
 * Master Builder, the report generator's inventory) goes through here, so it
 * gets what the Tables API gives the same viewer: nothing from a table
 * they can't read (lib/lake/acl.ts canRead: owner-only, or restricted to
 * roles they don't hold — admins included), and sensitivity-tagged columns
 * masked (lib/lake/redaction.ts). A model can't be trusted to keep a sample
 * row to itself: it quotes them in captions, titles and answers.
 *
 * Type inference over a sample (the schema and typed-conversion routes) never
 * shows the rows to anyone, so it keeps reading raw.
 */
import { canRead } from "@/lib/lake/acl";
import { applyRedaction, redactionMaskFor, shouldRedact } from "@/lib/lake/redaction";
import { previewRows } from "@/lib/lake/tables";
import { parseSchemaJson } from "@/lib/lake/schemaGovernance";
import type { RunViewer } from "@/lib/reporting/runner";

type TableRow = { name: string; tenantId: string; ownerUserId: string | null; visibleToRolesJson: string; schemaJson: string };

const lakeViewer = (tenantId: string, viewer: RunViewer) => ({
  id: viewer.id, tenantId, role: viewer.isAdmin ? "admin" : "member", roleSlugs: viewer.roles,
});
const redactionViewer = (viewer: RunViewer) => ({ id: viewer.id, role: viewer.isAdmin ? "admin" : "member", roleSlugs: viewer.roles });

/** Whether `viewer` may read `table` at all. */
export function canReadTable(table: TableRow, viewer: RunViewer): boolean {
  return canRead(lakeViewer(table.tenantId, viewer), table);
}

/** The table's first rows as `viewer` may see them; null when they can't read it. */
export async function previewRowsFor(table: TableRow, viewer: RunViewer, limit = 50): Promise<Array<Record<string, unknown>> | null> {
  if (!canReadTable(table, viewer)) return null;
  const rows = await previewRows(table.tenantId, table.name, limit);
  return applyRedaction(rows, parseSchemaJson(table.schemaJson), redactionViewer(viewer));
}

/**
 * Columns with each `sample` masked where `viewer`'s rows would be. The
 * sensitivity tags come from the catalog row (`table.schemaJson`), which is
 * where they're kept: the lake file's own column list (getTable) has none.
 */
export function columnsFor<C extends { name: string; sample?: unknown }>(columns: C[], table: Pick<TableRow, "schemaJson">, viewer: RunViewer): C[] {
  const rv = redactionViewer(viewer);
  const masked = new Map(parseSchemaJson(table.schemaJson).filter((c) => shouldRedact(rv, c)).map((c) => [c.name, c]));
  return columns.map((c) => {
    const tag = masked.get(c.name);
    return tag && c.sample != null ? { ...c, sample: redactionMaskFor(tag.sensitivity!) } : c;
  });
}
