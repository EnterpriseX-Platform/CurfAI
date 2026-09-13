/**
 * /api/lake/tables/[name]/schema — POST schema-mutation actions.
 *
 * Body shape (discriminated by `action`):
 *   { action: "addColumn", name, defaultValue? }
 *   { action: "renameColumn", oldName, newName }
 *   { action: "dropColumn", name }
 *
 * Owner / admin only (same gate as visibility). After every successful
 * mutation we re-introspect the schema and refresh the LakeTable row's
 * cached schemaJson + bump updatedAt so the browser tab list reflects
 * the change without a hard reload.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { addColumn, renameColumn, dropColumn, retypeColumn, getTable, inferColumns, previewRows } from "@/lib/lake/tables";
import { ee } from "@/ee";
import { canBuild } from "@/lib/roles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("addColumn"), name: z.string().min(1).max(60), defaultValue: z.string().optional() }),
  z.object({ action: z.literal("renameColumn"), oldName: z.string().min(1).max(60), newName: z.string().min(1).max(60) }),
  z.object({ action: z.literal("dropColumn"), name: z.string().min(1).max(60) }),
  // Recovery path for a column inference got wrong (or that predates the
  // cleaning behaviour entirely — a table uploaded before it shipped still
  // has raw "$1,299.00"-style text on disk). "unknown" is excluded: it's
  // never a meaningful RETYPE target, only something a column starts as.
  z.object({
    action: z.literal("retype"),
    name: z.string().min(1).max(60),
    type: z.enum(["text", "number", "boolean", "date"]),
  }),
]);

export async function POST(req: NextRequest, { params }: { params: { name: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const row = await prisma.lakeTable.findFirst({
    where: { tenantId: user.tenantId, name: decodeURIComponent(params.name) },
  });
  if (!row) return NextResponse.json({ error: "Table not found" }, { status: 404 });

  const isOwner = row.ownerUserId === user.id;
  const isAdmin = user.role === "admin";
  // For tenant-wide tables (no owner), any editor can mutate the schema —
  // mirrors the existing data-source posture. For owner-only tables, only
  // owner / admin can change.
  if (row.ownerUserId && !isOwner && !isAdmin) {
    return NextResponse.json({ error: "Only the owner or an admin can change schema." }, { status: 403 });
  }
  if (!canBuild(user.role)) {
    return NextResponse.json({ error: "Editors only" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = ActionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  let retypeResult: { updated: number; unchanged: number } | undefined;
  try {
    if (parsed.data.action === "addColumn") {
      addColumn({ tenantId: user.tenantId, tableName: row.name, columnName: parsed.data.name, defaultValue: parsed.data.defaultValue });
    } else if (parsed.data.action === "renameColumn") {
      renameColumn({ tenantId: user.tenantId, tableName: row.name, oldName: parsed.data.oldName, newName: parsed.data.newName });
    } else if (parsed.data.action === "dropColumn") {
      dropColumn({ tenantId: user.tenantId, tableName: row.name, columnName: parsed.data.name });
    } else if (parsed.data.action === "retype") {
      retypeResult = retypeColumn({
        tenantId: user.tenantId, tableName: row.name,
        columnName: parsed.data.name, type: parsed.data.type,
      });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Schema change failed" }, { status: 400 });
  }

  // Refresh the cached schemaJson on the catalog row. Re-derived from the
  // actual (now-cleaned) data rather than trusting the requested retype
  // type verbatim — if most cells genuinely couldn't clean to the
  // requested type (a real mismatch, not just an inference miss), the
  // persisted type honestly reflects that instead of lying about it.
  const sample = previewRows(user.tenantId, row.name, 100);
  const fresh = sample.length > 0 ? inferColumns(sample) : (() => {
    // No rows — derive from PRAGMA via getTable's path.
    const meta = getTable(user.tenantId, row.name);
    return meta?.columns ?? [];
  })();
  await prisma.lakeTable.update({
    where: { id: row.id },
    data: { schemaJson: JSON.stringify(fresh), updatedAt: new Date() },
  });

  // Vector-DB: re-enqueue every column. The drain's textHash check
  // skips columns whose embedded text hasn't changed, so unchanged
  // columns cost zero embedding tokens — only the added/renamed one
  // actually re-embeds. Dropped columns' VectorEmbedding rows stay
  // until the vacuum pass runs (tracked separately).
  setImmediate(() => {
    void ee.vectorStore?.enqueueSchemaColEmbedBatch({
      tenantId: user.tenantId,
      tableId: row.id,
      columnNames: fresh.map((c) => c.name),
    });
  });

  recordAudit({
    user, kind: "lake.table.schema." + parsed.data.action, target: row.id, req,
    meta: { name: row.name, ...parsed.data, ...(retypeResult ? { retypeResult } : {}) },
  });

  return NextResponse.json({ ok: true, schema: fresh, ...(retypeResult ? { retypeResult } : {}) });
}
