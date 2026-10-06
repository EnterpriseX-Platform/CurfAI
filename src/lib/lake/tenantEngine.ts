/**
 * Which SQL engine a tenant's lake runs on, for code that ships in every
 * edition and only needs to pick a SQL spelling — a template's view, an LLM
 * prompt's dialect section. It reads Tenant.lakeEngine directly instead of
 * going through lib/lake/engine (paid-only); the resolver there caches per
 * process and is for code that has to OPEN the lake, which this doesn't.
 *
 * "duckdb" only for a tenant that has been migrated; anything else — including
 * a tenant row that can't be read — is "sqlite", the default.
 */
import { prisma } from "@/lib/db";

export type LakeEngineName = "sqlite" | "duckdb";

export async function tenantLakeEngine(tenantId: string): Promise<LakeEngineName> {
  const tenant = await prisma.tenant
    .findUnique({ where: { id: tenantId }, select: { lakeEngine: true } })
    .catch(() => null);
  return tenant?.lakeEngine === "duckdb" ? "duckdb" : "sqlite";
}
