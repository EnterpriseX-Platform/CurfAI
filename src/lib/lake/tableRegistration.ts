/**
 * The two halves of creating a Curf Tables table around the physical write:
 * checking the name is free before anything touches disk, and recording the
 * table everywhere the app reads from once it exists. Shared by the direct
 * upload route (POST /api/lake/tables) and the staged-upload import job
 * (lib/lake/importJob.ts), which write the rows differently but must agree
 * on everything around them.
 */
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { tenantWhere, type CurfSessionUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { ee } from "@/ee";
import { lakeFileSize, rejectPathLikeName, toSafeTableName } from "./storage";
import { ensureLakeDataSource } from "./lakeDataSource";
import { bustLakeCacheForTenant } from "./bust";
import type { LakeColumn } from "./tables";

/** Why `name` can't be used for a new table in this workspace, or null when it can. */
export async function newTableNameProblem(
  user: CurfSessionUser,
  name: string,
): Promise<{ status: 400 | 409; error: string } | null> {
  const pathLike = rejectPathLikeName(name);
  if (pathLike) return { status: 400, error: pathLike };

  // Reject duplicate names early — clearer error than the unique-constraint
  // violation that would otherwise surface as P2002.
  const existing = await prisma.lakeTable.findFirst({
    where: { ...tenantWhere(user), name },
    select: { id: true },
  });
  if (existing) {
    return {
      status: 409,
      error: `Table "${name}" already exists. Choose a different name or delete the existing one first.`,
    };
  }

  // The physical table name is toSafeTableName(name), which is many-to-one
  // ("Sales-2024", "Sales 2024" and "Sales_2024" all collapse to
  // "sales_2024"). Creating a table DROPs that physical table, so without
  // this check a low-privileged user could create a colliding catalog name
  // and destroy — then shadow — another table whose ACL they can't touch.
  const safeName = toSafeTableName(name);
  const siblings = await prisma.lakeTable.findMany({ where: tenantWhere(user), select: { name: true } });
  const collision = siblings.find((s: { name: string }) => toSafeTableName(s.name) === safeName);
  if (collision) {
    return {
      status: 409,
      error: `Table name "${name}" collides with existing table "${collision.name}" (both map to the same storage name). Pick a more distinct name.`,
    };
  }
  return null;
}

/**
 * Record a table that now exists on disk: the catalog row, the "Curf
 * Tables" data source the designer discovers it through, semantic-search
 * indexing, the audit event and the query cache. Call after the physical
 * write, so a failed write never leaves a catalog row pointing at nothing.
 */
export async function registerCreatedTable(opts: {
  user: CurfSessionUser;
  req?: NextRequest;
  name: string;
  sourceKind: "upload" | "manual";
  sourceConfig?: Record<string, unknown>;
  columns: LakeColumn[];
  rowCount: number;
  /** The catalog's description (Markdown) — what the table holds and over which period. */
  description?: string;
}) {
  const { user } = opts;
  const created = await prisma.lakeTable.create({
    data: {
      tenantId: user.tenantId,
      name: opts.name,
      sourceKind: opts.sourceKind,
      sourceConfigJson: opts.sourceConfig ? JSON.stringify(opts.sourceConfig) : null,
      schemaJson: JSON.stringify(opts.columns),
      rowCount: opts.rowCount,
      sizeBytes: lakeFileSize(user.tenantId),
      createdById: user.id,
      ...(opts.description ? { description: opts.description } : {}),
    },
  });

  // The designer's data picker discovers lake-backed tables through a single
  // "Curf Tables" DataSource per tenant (kind=lake). Idempotent, found by
  // kind — see lib/lake/lakeDataSource.ts.
  try {
    await ensureLakeDataSource(user.tenantId);
  } catch (e) {
    // Non-fatal — the lake table is already saved on disk; the user can
    // still reference it directly via SQL once we surface it in the picker.
    console.warn("[lake] failed to upsert Curf Tables DataSource:", e);
  }

  // Vector-DB: enqueue each column for semantic search ("Find by meaning"
  // on /tables). Fire-and-forget — the helper handles the CURF_VECTOR_DB
  // gate internally and never throws to the caller.
  setImmediate(() => {
    void ee.vectorStore?.enqueueSchemaColEmbedBatch({
      tenantId: user.tenantId,
      tableId: created.id,
      columnNames: opts.columns.map((c) => c.name),
    });
  });

  recordAudit({
    user,
    kind: "lake.table.create",
    target: created.id,
    req: opts.req,
    meta: { name: opts.name, sourceKind: opts.sourceKind, rows: opts.rowCount },
  });

  // Cached query results that read from this tenant's lake source are now
  // stale. Fire-and-forget — the 30s TTL still catches us as a fallback.
  setImmediate(() => { void bustLakeCacheForTenant(user.tenantId); });

  return created;
}
