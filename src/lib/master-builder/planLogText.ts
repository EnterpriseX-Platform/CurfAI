/**
 * Master Builder's plan-job text in the reader's language, for the Build page
 * (AgentActivityLog, MasterBuilderEntry): the "what the AI is doing" lines
 * (AiJob.eventsJson) and the Build button's stage (AiJob.stage).
 *
 * The server writes each line in English with its dict key and values beside
 * it (planLog.ts); the page shows the key in the reader's language with
 * useT()'s t. No server imports and no dictionary: the client bundle uses it.
 */
export type PlanLogEntry = {
  ts: number;
  /** English, always — what a job stored before keys existed has only. */
  label: string;
  tone: "info" | "success" | "warning" | "error";
  key?: string;
  vars?: Record<string, string | number>;
};

export const PLAN_STAGE = {
  designing: "masterBuilder.stage.designing",
  foundation: "masterBuilder.stage.foundation",
  reports: "masterBuilder.stage.reports",
  surface: "masterBuilder.stage.surface",
  validating: "masterBuilder.stage.validating",
  done: "masterBuilder.stage.done",
  failed: "masterBuilder.stage.failed",
} as const;

export const fillPlanText = (s: string, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), s);

/** A log line in the reader's language (the stored English when it has no key the dictionary knows). */
export function localizePlanLog(e: PlanLogEntry, t: (key: string) => string): string {
  if (!e.key) return e.label;
  const text = t(e.key);
  return text !== e.key ? fillPlanText(text, e.vars) : e.label;
}
