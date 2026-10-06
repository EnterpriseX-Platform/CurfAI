/**
 * Master Builder's plan-job text, as the server writes it: the "what the AI is
 * doing" lines (AiJob.eventsJson) and the Build button's stage (AiJob.stage).
 *
 * The server keeps writing English — for logs, anything else that reads a
 * job, and every job stored before this — and puts each line's dict key and
 * values beside it; the Build page shows them in the reader's language
 * (planLogText.ts). A stage is stored as its English text; GET
 * /api/ai-jobs/:id sends its key beside it (planStageKey), so a job from
 * before this still reads.
 *
 * Server only: it reads the English dictionary. The client side is
 * planLogText.ts.
 */
import { t } from "@/lib/i18n/dict";
import { PLAN_STAGE, fillPlanText, type PlanLogEntry } from "./planLogText";

export { PLAN_STAGE, type PlanLogEntry };

/**
 * Silence after which a running plan job is called dead — its process went away. Lives here, not in
 * planJob.ts, because GET /api/ai-jobs/:id reads it and that route ships in the Community edition, which
 * keeps this file but not the paid planJob (scripts/community-export/manifest.json, excludeExcept).
 */
export const PLAN_JOB_STALE_MS = 5 * 60_000;

/** One log line: its key and values, and the English label they make. */
export function planLog(tone: PlanLogEntry["tone"], key: string, vars: Record<string, string | number> = {}): PlanLogEntry {
  return { ts: Date.now(), tone, key, vars, label: fillPlanText(t("en", key), vars) };
}

/** What the server stores in AiJob.stage: the stage's English text. */
export const planStage = (key: (typeof PLAN_STAGE)[keyof typeof PLAN_STAGE]) => t("en", key);

/** The dict key of a stored stage, for the reader's language; null for anything else. */
export function planStageKey(stage: string | null): string | null {
  if (!stage) return null;
  return Object.values(PLAN_STAGE).find((k) => t("en", k) === stage) ?? null;
}
