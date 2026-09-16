/**
 * Surface a table's last-refresh failure, when it has one.
 *
 * A LakeTable row has no direct link to the schedule that feeds it — the
 * correlation runs through sourceConfig (see originLabel.ts for the same
 * hints used the other direction) to whichever model actually tracks
 * that schedule's run history: SyncCursor (per sync-connector object),
 * LakeCdcSubscription (per CDC subscription), MaterializedView (per
 * saved result), or LakePull (per scheduled REST/SFTP pull). Upload,
 * webhook-push, and plain manual tables have no ongoing schedule at all,
 * so there's nothing to report — LakeTable.updatedAt already answers
 * "how long ago" for those, which is the whole story.
 *
 * Deliberately narrow: this reports FAILURE, not a four-state freshness
 * taxonomy. "Is it broken right now" is the question worth a red badge;
 * "how many minutes old" is already on every card via updatedAt.
 */
export type FreshnessIssue = {
  /** The underlying error message, truncated by the source itself. */
  error: string;
  /** ISO timestamp of the failed attempt, when known. */
  lastAttemptAt?: string;
};

export type FreshnessMaps = {
  /** Key: `${connectionId}|${sourceObject}` — one row per synced object. */
  syncCursors: Map<string, { lastRunAt: Date | string | null; lastError: string | null }>;
  /** Key: LakeCdcSubscription.targetLakeTable (== the LakeTable's own name). */
  cdcSubs: Map<string, { lastRunAt: Date | string | null; lastStatus: string | null; lastError: string | null }>;
  /** Key: MaterializedView.id. */
  materializedViews: Map<string, { lastRunAt: Date | string | null; lastStatus: string | null; lastError: string | null }>;
  /** Key: LakePull.id. */
  pulls: Map<string, { lastRunAt: Date | string | null; lastStatus: string | null; lastError: string | null }>;
};

export function emptyFreshnessMaps(): FreshnessMaps {
  return { syncCursors: new Map(), cdcSubs: new Map(), materializedViews: new Map(), pulls: new Map() };
}

export function freshnessIssueFor(
  tableName: string,
  sourceKind: string,
  sourceConfig: Record<string, unknown> | null | undefined,
  maps: FreshnessMaps,
): FreshnessIssue | null {
  const cfg = sourceConfig ?? {};

  if (cfg.kind === "cdc") {
    const sub = maps.cdcSubs.get(tableName);
    if (!sub) return null;
    if (sub.lastError || sub.lastStatus === "failed") return toIssue(sub.lastError, sub.lastRunAt);
    return null;
  }

  if (cfg.kind === "materialized_view" && isStr(cfg.mvId)) {
    const mv = maps.materializedViews.get(cfg.mvId);
    if (!mv) return null;
    if (mv.lastError || mv.lastStatus === "failed") return toIssue(mv.lastError, mv.lastRunAt);
    return null;
  }

  if (cfg.provenance === "sync" && isStr(cfg.connectionId) && isStr(cfg.sourceObject)) {
    const cur = maps.syncCursors.get(`${cfg.connectionId}|${cfg.sourceObject}`);
    if (!cur?.lastError) return null;
    return toIssue(cur.lastError, cur.lastRunAt);
  }

  if ((sourceKind === "rest_pull" || sourceKind === "sftp_pull") && isStr(cfg.pullId)) {
    const pull = maps.pulls.get(cfg.pullId);
    if (!pull) return null;
    if (pull.lastError || pull.lastStatus === "failed") return toIssue(pull.lastError, pull.lastRunAt);
    return null;
  }

  return null;
}

/**
 * Single-table variant of freshnessIssueFor() for the detail page, which
 * only ever needs one table's answer and shouldn't pay for building the
 * whole tenant's maps just to look up one entry. Prisma is imported
 * dynamically so this module stays importable from a client component
 * (TablesManager.tsx uses the other exports from this file) without
 * pulling a server-only dependency into that bundle.
 */
export async function freshnessIssueForOne(
  tenantId: string,
  tableName: string,
  sourceKind: string,
  sourceConfig: Record<string, unknown> | null | undefined,
): Promise<FreshnessIssue | null> {
  const cfg = sourceConfig ?? {};
  try {
    const { prisma } = await import("@/lib/db");

    if (cfg.kind === "cdc") {
      const sub = await (prisma as any).lakeCdcSubscription.findFirst({
        where: { tenantId, targetLakeTable: tableName },
        select: { lastRunAt: true, lastStatus: true, lastError: true },
      });
      if (sub && (sub.lastError || sub.lastStatus === "failed")) return toIssue(sub.lastError, sub.lastRunAt);
      return null;
    }
    if (cfg.kind === "materialized_view" && isStr(cfg.mvId)) {
      const mv = await prisma.materializedView.findFirst({
        where: { id: cfg.mvId, tenantId },
        select: { lastRunAt: true, lastStatus: true, lastError: true },
      });
      if (mv && (mv.lastError || mv.lastStatus === "failed")) return toIssue(mv.lastError, mv.lastRunAt);
      return null;
    }
    if (cfg.provenance === "sync" && isStr(cfg.connectionId) && isStr(cfg.sourceObject)) {
      const cur = await prisma.syncCursor.findUnique({
        where: { connectionId_objectName: { connectionId: cfg.connectionId, objectName: cfg.sourceObject } },
        select: { lastError: true, lastRunAt: true },
      });
      if (cur?.lastError) return toIssue(cur.lastError, cur.lastRunAt);
      return null;
    }
    if ((sourceKind === "rest_pull" || sourceKind === "sftp_pull") && isStr(cfg.pullId)) {
      const pull = await prisma.lakePull.findFirst({
        where: { id: cfg.pullId, tenantId },
        select: { lastRunAt: true, lastStatus: true, lastError: true },
      });
      if (pull && (pull.lastError || pull.lastStatus === "failed")) return toIssue(pull.lastError, pull.lastRunAt);
      return null;
    }
  } catch {
    // Model absent (Community edition) or pre `prisma db push` — same
    // "nothing to report" outcome as no schedule existing at all.
    return null;
  }
  return null;
}

function isStr(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function toIssue(error: string | null, lastRunAt: Date | string | null): FreshnessIssue {
  return {
    error: error ?? "Last run failed.",
    lastAttemptAt: lastRunAt ? (typeof lastRunAt === "string" ? lastRunAt : lastRunAt.toISOString()) : undefined,
  };
}
