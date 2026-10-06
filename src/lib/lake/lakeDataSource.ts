/**
 * The workspace's lake DataSource — the one row every Curf Tables query
 * binds to (the runner reads the tenant's lake for kind "lake", whatever the
 * row is called).
 *
 * Seven paths used to get-or-create it by NAME: upsert on
 * (tenantId, "Curf Tables"). An admin who renamed that source got a second
 * lake source the next time a report or notebook was published, and a
 * non-lake connection someone had named "Curf Tables" was returned as-is,
 * so lake SQL was bound to a warehouse it doesn't belong to (FE-NB-07,
 * retest 2026-09-24). It is found by kind now — the same way the pipeline
 * runner, the lake-cache bust and the app view generator already did —
 * and only created when the workspace has none.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

const DEFAULT_NAME = "Curf Tables";

type Db = Pick<typeof prisma, "dataSource"> | Prisma.TransactionClient;

export async function findLakeDataSource(tenantId: string, db: Db = prisma): Promise<{ id: string } | null> {
  return db.dataSource.findFirst({
    where: { tenantId, kind: "lake" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
}

export async function ensureLakeDataSource(tenantId: string, db: Db = prisma): Promise<{ id: string }> {
  const existing = await findLakeDataSource(tenantId, db);
  if (existing) return existing;
  const create = (name: string) => db.dataSource.create({
    // The runner derives the lake path from tenantId; the connection string
    // is only there to read sensibly in the connections list.
    data: { tenantId, name, kind: "lake", connection: "lake://" + tenantId },
    select: { id: true },
  });
  try {
    return await create(DEFAULT_NAME);
  } catch {
    // (tenantId, name) is unique: either a concurrent request just created
    // the lake source, or a non-lake connection already holds the name.
    const raced = await findLakeDataSource(tenantId, db);
    if (raced) return raced;
    return create(`${DEFAULT_NAME} (lake)`);
  }
}
