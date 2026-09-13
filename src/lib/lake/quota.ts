/**
 * Lake quota helpers — enforce storage + table-count caps per tier.
 *
 * Reads tier from the Tenant row. Caps are defined here as the source of
 * truth — the marketing /pricing page should reference these constants too
 * once we wire it.
 *
 * Cap policy from ROADMAP-DATA-LAYER.md "Phase 1 — Tier gates":
 *   Community   100 MB     10 tables
 *   Growth      5 GB       100 tables
 *   Business    50 GB      unlimited
 *   Enterprise  unlimited  unlimited
 *
 * `null` for either field = no cap.
 *
 * The tier union is imported from billing.ts rather than restated here.
 * This file used to keep its own narrower copy that stopped at "business",
 * so an enterprise tenant missed the lookup and fell through to
 * `QUOTAS.community` — the SMALLEST cap, 100 MB and 10 tables, for the
 * most expensive plan. Sharing the type means adding a tier there fails
 * this Record until a row is added here too.
 */
import { prisma } from "@/lib/db";
import type { Tier } from "@/lib/billing";
import { lakeFileSize } from "./storage";

export type LakeQuota = {
  maxBytes: number | null;
  maxTables: number | null;
  tier: Tier;
};

const QUOTAS: Record<Tier, { maxBytes: number | null; maxTables: number | null }> = {
  community:  { maxBytes: 100 * 1024 * 1024,         maxTables: 10 },
  growth:     { maxBytes: 5 * 1024 * 1024 * 1024,    maxTables: 100 },
  business:   { maxBytes: 50 * 1024 * 1024 * 1024,   maxTables: null },
  enterprise: { maxBytes: null,                      maxTables: null },
};

export async function getQuotaForTenant(tenantId: string): Promise<LakeQuota> {
  const t = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { tier: true },
  });
  const tier = (t?.tier ?? "community") as Tier;
  // An unrecognised tier string still falls back to the smallest cap — that
  // is the safe direction for a value that shouldn't exist. Every REAL tier
  // now has a row, which is what this fallback was silently masking.
  const q = QUOTAS[tier] ?? QUOTAS.community;
  return { ...q, tier };
}

export type LakeUsage = {
  bytes: number;
  tables: number;
};

export async function getUsageForTenant(tenantId: string): Promise<LakeUsage> {
  const tables = await prisma.lakeTable.count({ where: { tenantId } });
  // Disk size is the source of truth; the cached sizeBytes column on the
  // Prisma rows is only used in the UI to avoid a stat per request.
  const bytes = lakeFileSize(tenantId);
  return { bytes, tables };
}

/**
 * Pre-write quota gate. Returns null when OK to proceed, or a human-
 * readable error message when the next ingest would exceed cap. Caller
 * passes the estimated additional bytes (file size or rows*avg) so we
 * fail BEFORE the write rather than after.
 */
export async function checkWriteAllowed(opts: {
  tenantId: string;
  /** Bytes about to be written. Use 0 for "I can't estimate" — we'll
   *  still gate on table count + the existing usage. */
  estimatedBytes?: number;
  /** Whether this write creates a new table (vs append to existing). */
  newTable?: boolean;
}): Promise<string | null> {
  const [quota, usage] = await Promise.all([
    getQuotaForTenant(opts.tenantId),
    getUsageForTenant(opts.tenantId),
  ]);

  if (quota.maxTables != null && opts.newTable && usage.tables >= quota.maxTables) {
    return `Lake table cap reached (${usage.tables}/${quota.maxTables} on ${quota.tier}). Drop a table or upgrade.`;
  }

  if (quota.maxBytes != null) {
    const after = usage.bytes + (opts.estimatedBytes ?? 0);
    if (after > quota.maxBytes) {
      return `Lake storage cap reached (${formatBytes(usage.bytes)}/${formatBytes(quota.maxBytes)} on ${quota.tier}). Free up space or upgrade.`;
    }
  }
  return null;
}

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
