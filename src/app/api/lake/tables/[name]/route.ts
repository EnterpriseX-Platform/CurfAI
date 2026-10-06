/**
 * /api/lake/tables/[name]
 *   GET    — table schema + sample preview rows
 *   DELETE — drop the table from disk + remove the catalog row
 *
 * Tenant-scoped — name is matched against the LakeTable row inside the
 * caller's tenant only. There's no cross-tenant peek even with the right
 * name guess.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, requireAdminOrEditor } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { dropTable, previewRows, getTable, rowCount as countRows } from "@/lib/lake/tables";
import { lakeFileSize } from "@/lib/lake/storage";
import { bustLakeCacheForTenant } from "@/lib/lake/bust";
import { mergeGovernanceMetadata, parseSchemaJson } from "@/lib/lake/schemaGovernance";
import { lakeTableFor } from "@/lib/lake/tableAccess";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: { name: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Resolve via the catalog so we get the canonical (case-preserved) name
  // and the createdAt etc the user expects. A table the viewer can't read
  // answers "not found", so a hidden table doesn't reveal it exists.
  const access = await lakeTableFor(user, decodeURIComponent(params.name), "read");
  if (access instanceof NextResponse) return access;
  const { row, viewer } = access;

  // Column-level redaction (Phase 3). The schema is loaded from the
  // catalog row's schemaJson — that's the authoritative sensitivity-tag
  // store. We pass it through redaction.applyRedaction which mutates the
  // preview rows in place. Tenant admins always see unredacted values
  // (see redaction.ts threat model).
  const { applyRedaction, readsSensitiveData, redactSamples } = await import("@/lib/lake/redaction");

  const meta = await getTable(user.tenantId, row.name);
  // Prefer the cached row count from the catalog when on-disk count agrees
  // — it usually does. The disk number wins on disagreement (e.g. an
  // earlier ingest crashed mid-write).
  let diskCount = await countRows(user.tenantId, row.name);
  let rawPreview = await previewRows(user.tenantId, row.name, 50);
  let asOfResolved: string | null = null;
  let asOfMissed = false;

  // Time-travel: when ?asOf=<iso> is supplied, replace the live preview
  // with the closest snapshot ≤ that timestamp. Live + historical paths
  // share the same downstream redaction + projection.
  const asOfRaw = req.nextUrl.searchParams.get("asOf");
  if (asOfRaw) {
    const asOf = new Date(asOfRaw);
    if (!isNaN(asOf.getTime())) {
      const { readTableAsOf } = await import("@/lib/lake/timeTravel");
      const tt = await readTableAsOf({
        tenantId: user.tenantId, tableName: row.name, asOf, limit: 50,
      });
      if (tt) {
        rawPreview = tt.rows;
        diskCount = tt.rowCount;
        asOfResolved = tt.resolvedAt.toISOString();
      } else {
        asOfMissed = true;
      }
    }
  }

  // The catalog row's schemaJson has the authoritative sensitivity tags.
  // The on-disk inferred schema (from getTable) doesn't — it's just
  // type/sample. Merge: type from disk, sensitivity from catalog.
  // (mergeGovernanceMetadata, as the rows and formula routes build it; a
  // formula column's tags come from the columns it reads.)
  const catalogSchema = parseSchemaJson(row.schemaJson);
  const schema = mergeGovernanceMetadata(catalogSchema, meta?.columns ?? catalogSchema);

  // Redact per-role. Mutates preview in place, returns same array.
  const preview = applyRedaction(rawPreview, schema, viewer);

  // Audit any read that touched a sensitive column. Cheap — one row
  // per detail-page load when relevant.
  const sens = readsSensitiveData(viewer, schema);
  if (sens.any) {
    const { recordAudit } = await import("@/lib/audit");
    recordAudit({
      user, kind: "lake.table.read.sensitive", target: row.id, req,
      meta: { name: row.name, redactedColumns: sens.redactedColumns },
    });
  }

  return NextResponse.json({
    id: row.id,
    name: row.name,
    sourceKind: row.sourceKind,
    sourceConfig: safeJson(row.sourceConfigJson),
    // Each column's sample is a value from the table: masked like the rows.
    schema: redactSamples(schema, viewer),
    rowCount: diskCount,
    sizeBytes: row.sizeBytes,
    asOfResolved,
    asOfMissed,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    preview,
  });
}

export async function DELETE(req: NextRequest, { params }: { params: { name: string } }) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;

  // Dropping a table needs reading it first: one the caller can't see is not found.
  const access = await lakeTableFor(user, decodeURIComponent(params.name), "build");
  if (access instanceof NextResponse) return access;
  const { row } = access;

  // On-disk first so a partial failure leaves the catalog with a stale row
  // (recoverable via re-create) rather than the opposite (catalog says
  // "table is gone" but file is still there silently consuming quota).
  await dropTable(user.tenantId, row.name);
  await prisma.lakeTable.delete({ where: { id: row.id } });
  // Recompute size cache for any sibling rows so the quota readout reflects
  // the freed space immediately.
  const newSize = lakeFileSize(user.tenantId);
  await prisma.lakeTable.updateMany({
    where: { tenantId: user.tenantId },
    data: { sizeBytes: newSize },
  });

  recordAudit({ user, kind: "lake.table.delete", target: row.id, req, meta: { name: row.name } });
  // Cached query results that referenced this table are now stale.
  setImmediate(() => { void bustLakeCacheForTenant(user.tenantId); });
  return NextResponse.json({ ok: true });
}

function safeJson(s: string | null | undefined): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
