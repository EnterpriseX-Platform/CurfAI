/**
 * GET /api/ai-jobs/:id
 *
 * Tenant-scoped read of one AiJob row (C3) — the generic polling target
 * for any background AI call that returns a jobId instead of blocking
 * the request, mirroring the "create a row, fire work in the
 * background, client polls" shape /api/master-builder/[id] already
 * established for MasterBuild. See src/hooks/usePollAiJob.ts for the
 * client side of this contract.
 *
 * On status="done", `result` holds the job's return value (kind-
 * specific shape). On status="failed", the job's error envelope is
 * spread onto the top-level response — for kind="master_builder_plan"
 * that's the same {error, canSwitchModel, hint, supportedArchetypes}
 * shape the route used to return synchronously, so callers written
 * against the old direct-call contract need no special-casing.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, tenantWhere } from "@/lib/auth";
import { LAKE_IMPORT_JOB_KIND, LAKE_IMPORT_STALE_MS } from "@/lib/lake/importJob";
import { PLAN_JOB_STALE_MS, planStageKey } from "@/lib/master-builder/planLog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Kinds that write progress often enough that long silence means the job died. */
const STALE_AFTER_MS: Record<string, number> = {
  [LAKE_IMPORT_JOB_KIND]: LAKE_IMPORT_STALE_MS,
  // The plan job heartbeats every 30s; five silent minutes means its process is gone.
  master_builder_plan: PLAN_JOB_STALE_MS,
};

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let job = await prisma.aiJob.findFirst({
    where: { id: params.id, ...tenantWhere(user) },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  // A job runs inside the server process that started it; if that process
  // restarts (a deploy, an eviction) the row stays "running" forever and
  // the caller polls a job nobody is doing. For a kind that writes progress
  // regularly, silence past its threshold means exactly that — say so.
  const staleAfter = STALE_AFTER_MS[job.kind];
  if (job.status === "running" && staleAfter != null && Date.now() - job.updatedAt.getTime() > staleAfter) {
    job = await prisma.aiJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        stage: "Stopped",
        errorJson: JSON.stringify({
          error: "This stopped before it finished — the server restarted while it was running. Start it again.",
          // A plan job checkpoints each finished stage on its row; hand them back so Continue picks up there.
          ...staleResumeEnvelope(job),
        }),
      },
    });
  }

  let result: unknown = null;
  let errorEnvelope: Record<string, unknown> = {};
  let events: unknown[] = [];
  if (job.status === "done" && job.resultJson) {
    try { result = JSON.parse(job.resultJson); } catch { /* leave null */ }
  }
  if (job.status === "failed") {
    try { errorEnvelope = job.errorJson ? JSON.parse(job.errorJson) : {}; }
    catch { errorEnvelope = {}; }
    if (typeof errorEnvelope.error !== "string") errorEnvelope.error = "Job failed";
  }
  if (job.eventsJson) {
    try {
      const parsed = JSON.parse(job.eventsJson);
      if (Array.isArray(parsed)) events = parsed;
    } catch { /* leave [] */ }
  }

  return NextResponse.json({
    id: job.id,
    kind: job.kind,
    status: job.status,
    stage: job.stage,
    // The Build page shows a Master Builder stage in the reader's language.
    stageKey: planStageKey(job.stage),
    progressPct: job.progressPct,
    result,
    events,
    ...errorEnvelope,
  });
}

/** A stalled plan job's checkpoint, in the shape its failure envelope uses (prompt + completedStages). */
function staleResumeEnvelope(job: { kind: string; resultJson: string | null }): Record<string, unknown> {
  if (job.kind !== "master_builder_plan" || !job.resultJson) return {};
  try {
    const cp = JSON.parse(job.resultJson)?.checkpoint;
    if (typeof cp?.prompt === "string" && cp.stages && typeof cp.stages === "object" && Object.keys(cp.stages).length > 0) {
      return { prompt: cp.prompt, completedStages: cp.stages };
    }
  } catch { /* unreadable — nothing to resume */ }
  return {};
}
