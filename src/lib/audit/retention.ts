/**
 * Audit log retention sweep.
 *
 * Per-tenant configuration is stored on `Tenant.auditRetentionJson` —
 * a JSON object mapping event-kind patterns to retention windows in
 * days:
 *
 *   {
 *     "*": 365,             // default — everything
 *     "signin": 90,         // exact match overrides default
 *     "export.*": 730       // prefix wildcard
 *   }
 *
 * Resolution: exact match wins, then longest prefix match, then "*".
 * If no match (and no "*"), the row is kept indefinitely — explicit
 * opt-in retention rather than implicit purge.
 *
 * The sweep runs from the cron tick once per UTC day at 03:00. It
 * iterates tenants, walks each tenant's distinct event kinds, and
 * deletes rows older than their resolved window. We delete kind-by-
 * kind rather than row-by-row so the DELETE clauses use the existing
 * (tenantId, kind) index.
 */
import { prisma } from "@/lib/db";

export type RetentionRule = {
  pattern: string;
  days: number;
  /** "exact" | "prefix" | "default" — for the resolveRule trace. */
  kind: "exact" | "prefix" | "default";
};

export type RetentionConfig = Record<string, number>;

/**
 * Find the retention days for a given event kind. Returns null when
 * no rule matches (= keep forever).
 */
export function resolveRetention(config: RetentionConfig, kind: string): RetentionRule | null {
  if (!config || typeof config !== "object") return null;
  // Exact match
  if (typeof config[kind] === "number" && config[kind] > 0) {
    return { pattern: kind, days: config[kind], kind: "exact" };
  }
  // Longest matching prefix wildcard ("export.*" matches "export.pdf").
  let best: RetentionRule | null = null;
  for (const [pattern, days] of Object.entries(config)) {
    if (!pattern.endsWith(".*")) continue;
    const stem = pattern.slice(0, -2); // strip ".*"
    if (kind.startsWith(stem + ".") || kind === stem) {
      if (typeof days !== "number" || days <= 0) continue;
      if (!best || stem.length > best.pattern.length - 2) {
        best = { pattern, days, kind: "prefix" };
      }
    }
  }
  if (best) return best;
  if (typeof config["*"] === "number" && config["*"] > 0) {
    return { pattern: "*", days: config["*"], kind: "default" };
  }
  return null;
}

/**
 * Sweep one tenant. Returns counts of {scanned, deleted} per kind.
 * Errors are caught per-kind so a malformed config or one bad delete
 * doesn't abort the whole sweep.
 */
export async function sweepTenantAuditLog(tenantId: string): Promise<{
  totalDeleted: number;
  byKind: Array<{ kind: string; deleted: number; days: number; pattern: string }>;
  configError?: string;
}> {
  const tenant = await prisma.tenant
    .findUnique({
      where: { id: tenantId },
      select: { auditRetentionJson: true },
    })
    .catch(() => null);
  if (!tenant) return { totalDeleted: 0, byKind: [] };

  let config: RetentionConfig = {};
  try {
    const parsed = JSON.parse(tenant.auditRetentionJson ?? "{}");
    if (parsed && typeof parsed === "object") config = parsed;
  } catch {
    return { totalDeleted: 0, byKind: [], configError: "Tenant auditRetentionJson is not valid JSON" };
  }

  // No retention configured → no-op.
  if (Object.keys(config).length === 0) return { totalDeleted: 0, byKind: [] };

  // Find every distinct event kind in this tenant. Cheap aggregate;
  // returns a small set even for huge tenants.
  let kinds: string[] = [];
  try {
    const rows: Array<{ kind: string }> = await prisma.auditEvent.findMany({
      where: { tenantId },
      distinct: ["kind"],
      select: { kind: true },
    });
    kinds = rows.map((r) => r.kind);
  } catch {
    return { totalDeleted: 0, byKind: [] };
  }

  const byKind: Array<{ kind: string; deleted: number; days: number; pattern: string }> = [];
  let totalDeleted = 0;
  for (const kind of kinds) {
    const rule = resolveRetention(config, kind);
    if (!rule) continue;
    const cutoff = new Date(Date.now() - rule.days * 24 * 60 * 60 * 1000);
    try {
      const r = await prisma.auditEvent.deleteMany({
        where: { tenantId, kind, createdAt: { lt: cutoff } },
      });
      if (r.count > 0) {
        byKind.push({ kind, deleted: r.count, days: rule.days, pattern: rule.pattern });
        totalDeleted += r.count;
      }
    } catch {
      // Skip this kind — maybe a rare DB error; the next sweep will
      // catch it.
    }
  }

  return { totalDeleted, byKind };
}

/**
 * Sweep every tenant. Run from the cron tick. Cheap when no retention
 * is configured (each tenant's sweep returns immediately).
 */
export async function sweepAllAuditLogs(): Promise<{
  tenantCount: number;
  totalDeleted: number;
}> {
  const tenants = await prisma.tenant
    .findMany({ select: { id: true } })
    .catch(() => []);
  let totalDeleted = 0;
  for (const t of tenants) {
    try {
      const r = await sweepTenantAuditLog(t.id);
      totalDeleted += r.totalDeleted;
    } catch {
      /* per-tenant failures don't stop the sweep */
    }
  }
  return { tenantCount: tenants.length, totalDeleted };
}
