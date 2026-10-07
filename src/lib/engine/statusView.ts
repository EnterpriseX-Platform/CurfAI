/**
 * The status panel's checklist, worked out from the engine's answer. Pure and client-safe (the type is only a shape).
 *
 * The checks depend on each other: the engine cannot accept Curf's identity if it cannot be reached, and cannot
 * place the person in the right workspace if it does not accept it. So the first step that fails is shown as
 * failed and every later one as "not checked", rather than a column of misleading red marks.
 */
export type StatusInput = {
  ok: boolean;
  latencyMs: number;
  source: "platform" | "workspace";
  reachable: boolean;
  acceptsIdentity: boolean;
  workspaceMatches: boolean | null;
  views?: number;
  problem?: string;
  hint?: string;
};

export type StepId = "reachable" | "identity" | "workspace" | "views";
export type StepState = "pass" | "fail" | "skipped" | "attention";
export type Step = { id: StepId; state: StepState; /** latency for "reachable", the count for "views". */ value?: number };

export const STEP_IDS: StepId[] = ["reachable", "identity", "workspace", "views"];

export function statusSteps(s: StatusInput): Step[] {
  const steps: Step[] = [];
  let blocked = false;
  const run = (id: StepId, passed: boolean | null, value?: number): void => {
    if (blocked || passed === null) { steps.push({ id, state: "skipped" }); return; }
    if (!passed) { blocked = true; steps.push({ id, state: "fail" }); return; }
    steps.push({ id, state: "pass", value });
  };
  run("reachable", s.reachable, s.latencyMs);
  run("identity", s.reachable ? s.acceptsIdentity : null);
  run("workspace", s.acceptsIdentity ? s.workspaceMatches : null);
  if (blocked || typeof s.views !== "number") {
    steps.push({ id: "views", state: "skipped" });
  } else {
    // No published views is not a fault, but there is nothing for a report to be built on yet.
    steps.push({ id: "views", state: s.views > 0 ? "pass" : "attention", value: s.views });
  }
  return steps;
}

export type HintSegment = { text: string; code: boolean };

/** Engine setting names in a hint (CURF_ENGINE_SECURITY_CLAIMS_TENANT) are picked out so they can be shown in monospace. */
export function splitHint(hint: string): HintSegment[] {
  const segments: HintSegment[] = [];
  const re = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
  let last = 0;
  for (const m of hint.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) segments.push({ text: hint.slice(last, at), code: false });
    segments.push({ text: m[0], code: true });
    last = at + m[0].length;
  }
  if (last < hint.length) segments.push({ text: hint.slice(last), code: false });
  return segments;
}

/** The settings named in a hint, each once. */
export function hintSettings(hint: string): string[] {
  return [...new Set(splitHint(hint).filter((s) => s.code).map((s) => s.text))];
}
