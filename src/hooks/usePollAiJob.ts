import { useEffect, useRef, useState } from "react";
import type { PlanLogEntry } from "@/lib/master-builder/planLogText";

/**
 * Polls GET /api/ai-jobs/:id (C3) until the job resolves. Pass `null` to
 * stay idle — the typical flow is: kick off a job via its own POST
 * route, stash the returned jobId in state, then pass that state here.
 *
 * `stage`/`progressPct` come straight from the server at real
 * checkpoints the job's own code passed through — never a client-side
 * timer faking progress independently of what's actually happening.
 *
 * On "failed", every field the job's error envelope carried (e.g.
 * master_builder_plan's canSwitchModel/hint/supportedArchetypes) rides
 * along in `errorExtra` so a caller written against the old direct-call
 * error shape doesn't need special-casing.
 */
/** One line of an "agent activity" log — see PlanLogEntry in
 *  lib/master-builder/customPlanner.ts, whose shape this mirrors so a
 *  renderer needs no translation layer between them. */
export type AiJobLogEntry = PlanLogEntry;

export type AiJobPollState<T = unknown> = {
  status: "idle" | "running" | "done" | "failed";
  stage: string | null;
  /** The stage's dict key when the server knows one, for showing it in the reader's language. */
  stageKey: string | null;
  progressPct: number;
  result: T | null;
  error: string | null;
  errorExtra: Record<string, unknown>;
  /** Kept through running → done/failed so a UI showing "what happened"
   *  doesn't lose the log the instant the job resolves. */
  events: AiJobLogEntry[];
};

const IDLE: AiJobPollState<any> = {
  status: "idle", stage: null, stageKey: null, progressPct: 0, result: null, error: null, errorExtra: {}, events: [],
};

export function usePollAiJob<T = unknown>(jobId: string | null, opts?: { intervalMs?: number }): AiJobPollState<T> {
  const [state, setState] = useState<AiJobPollState<T>>(IDLE);
  const intervalMs = opts?.intervalMs ?? 1200;

  useEffect(() => {
    if (!jobId) {
      setState(IDLE);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setState({ status: "running", stage: null, stageKey: null, progressPct: 0, result: null, error: null, errorExtra: {}, events: [] });

    async function poll() {
      let j: any;
      try {
        const r = await fetch(`/api/ai-jobs/${jobId}`, { cache: "no-store" });
        j = await r.json();
        if (!r.ok) {
          if (!cancelled) setState({ status: "failed", stage: null, stageKey: null, progressPct: 0, result: null, error: j?.error ?? `HTTP ${r.status}`, errorExtra: {}, events: [] });
          return;
        }
      } catch {
        // Transient network hiccup — retry rather than failing the job
        // over a blip the underlying work never actually hit.
        if (!cancelled) timer = setTimeout(poll, intervalMs);
        return;
      }
      if (cancelled) return;

      const events: AiJobLogEntry[] = Array.isArray(j.events) ? j.events : [];
      if (j.status === "done") {
        setState({ status: "done", stage: j.stage ?? null, stageKey: j.stageKey ?? null, progressPct: 100, result: j.result ?? null, error: null, errorExtra: {}, events });
        return;
      }
      if (j.status === "failed") {
        const { id, kind, status, stage, stageKey, progressPct, result, error, events: _e, ...rest } = j;
        setState({ status: "failed", stage: stage ?? null, stageKey: stageKey ?? null, progressPct: progressPct ?? 0, result: null, error: error ?? "Job failed", errorExtra: rest, events });
        return;
      }
      setState({ status: "running", stage: j.stage ?? null, stageKey: j.stageKey ?? null, progressPct: j.progressPct ?? 0, result: null, error: null, errorExtra: {}, events });
      timer = setTimeout(poll, intervalMs);
    }
    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, intervalMs]);

  return state;
}
