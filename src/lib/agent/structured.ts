/**
 * Structured generation — ask a model for a schema-valid artifact and
 * actually get one back.
 *
 *   const r = await generateStructured({
 *     tenantId, kind: "master_builder_design",
 *     schema: BuildPlan,
 *     system: SYSTEM_PROMPT(tables),
 *     prompt: userPrompt,
 *     normalise: (raw) => normalisePlan(raw, userPrompt),
 *   });
 *   if (r.ok) use(r.value);
 *
 * ── Why this is a sibling of runLoop.ts and not part of it ──────────
 *
 * `runAgent` orchestrates a TOOL-USING conversation: discover, query,
 * act, answer. Its loop condition is "did the model ask for another
 * tool". A planner has no tools to call — it has exactly one job, which
 * is to emit an object that survives a strict Zod parse. Its loop
 * condition is "did the artifact validate". Same module, different
 * primitive; folding one into the other would give both a control flow
 * that fits neither.
 *
 * ── The gap this closes ────────────────────────────────────────────
 *
 * Every structured-output call site in Curf (designCustomPlan,
 * iterateBuild, autoCurf) followed the same shape: call the model once,
 * extract JSON, run a hand-written repair pass, strict-parse, and on
 * failure return an error string to the HUMAN. Zod had already produced
 * a precise, machine-readable diagnosis — `approvalChain.0 — Expected
 * object, received string` — and that diagnosis was rendered into a chat
 * bubble and thrown away. It never went back to the model, which is the
 * one party that could act on it.
 *
 * Observed cost of that gap, twice in a row on the same request: an
 * Operate template with an approval step failed because the model wrote
 * `approvalChain: ["manager approval"]` where the schema wants
 * `[{step, kind, value}]`. A single repair turn quoting the error is
 * very likely to fix that class of mistake; the model is not confused
 * about the domain, only about the shape.
 *
 * The hand-written repair passes (normalisePlan, iterator's repairDelta)
 * stay and still run FIRST — a local coercion costs nothing, while a
 * repair turn costs a round-trip. This layer is the backstop for the
 * mistakes nobody has written a rule for yet, which is by definition the
 * ones that reach production.
 *
 * ── generateStaged ─────────────────────────────────────────────────
 *
 * The second failure mode a repair loop can't touch: asking for too much
 * at once. designCustomPlan requested an entire BuildPlan — tables,
 * reports with full block layouts, watchers, Operate templates, brief,
 * app, engines, tour steps — in one response, and every model on a
 * slower provider blew its budget or the 90s ceiling before emitting
 * anything. Decomposition turns one impossible call into several easy
 * ones, each validated on its own, each cheap to repair.
 *
 * Nothing here throws. `callLLM` never throws, and neither do we —
 * callers check `ok` and read `error`, same contract as the rest of the
 * LLM layer.
 */
import type { z } from "zod";
import { callLLM } from "@/lib/llm";
import { humanizeLlmError } from "@/lib/llm/humanizeError";
import { isFatalProviderError } from "@/lib/llm/resilience";
import type { LlmMessage } from "@/lib/llm/types";

export type StructuredUsage = { inputTokens: number; outputTokens: number };

export type StructuredResult<T> =
  | {
      ok: true;
      value: T;
      /** LLM round-trips spent, including repairs. 1 = clean first pass. */
      attempts: number;
      /** True when the first attempt failed validation and a repair turn rescued it. */
      repaired: boolean;
      /** The model's raw text for the attempt that validated — callers
       *  persist this as the audit record of what was actually said. */
      raw: string;
      usage: StructuredUsage;
      model: string;
    }
  | {
      ok: false;
      error: string;
      /**
       * Why it failed, so a caller can escalate intelligently rather than
       * string-matching an error message:
       *   not_configured — no provider/key; nothing to retry.
       *   transport      — the model never produced an answer (timeout,
       *                    reasoning budget spent). A repair turn can't
       *                    help; this is the signal that the request was
       *                    too big for this model, and the cue to
       *                    decompose it via generateStaged.
       *   invalid_shape  — the model answered but couldn't hit the schema
       *                    even after repair. Usually the wrong sub-model.
       */
      failureKind: "not_configured" | "transport" | "invalid_shape";
      attempts: number;
      usage: StructuredUsage;
      /** generateStaged only: the validated output of every stage that
       *  finished before the failure, keyed by stage name. Hand it back as
       *  `resumeFrom` to pick up at the stage that failed. */
      completedStages?: Record<string, unknown>;
      /** Raw text of the last attempt, when there was one. Absent for a
       *  transport failure, where the model never answered at all. */
      raw?: string;
      /** Passed through from humanizeLlmError so existing error UI keeps working. */
      notConfigured?: boolean;
      canSwitchModel?: boolean;
      /** The provider refused for a reason no retry fixes (out of credit, suspended) — callers that retry must not. */
      fatal?: boolean;
      /** Formatted Zod issues from the final attempt, when it got that far. */
      issues?: string[];
    };

/**
 * Generic binds to the SCHEMA, not to a bare value type: a Zod schema
 * carrying `.default()`s has an input type that differs from its output
 * type, and `z.ZodType<T>` (whose Input defaults to Output) then infers
 * the pre-defaults shape. `z.infer<S>` always names the parsed side,
 * which is what a caller actually receives.
 */
export type GenerateStructuredOptions<S extends z.ZodTypeAny> = {
  tenantId: string | null;
  /** Usage-dashboard label. Repair turns are recorded as `${kind}.repair`. */
  kind: string;
  userId?: string | null;
  schema: S;
  system: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Per-request wait ceiling; see LlmRequest.timeoutMs. */
  timeoutMs?: number;
  /** See LlmRequest.thinkingCap / retryTimeouts — passed to every model call. */
  thinkingCap?: number;
  retryTimeouts?: boolean;
  /**
   * The caller's abort signal (usually the HTTP request's). Passed to every
   * model call, and no further attempt starts once it fires — a client that
   * went away shouldn't keep a billed generation running for nobody.
   */
  signal?: AbortSignal;
  /**
   * Local coercion run before every validation attempt — the existing
   * hand-written repair passes plug in here. Mutates in place, same as
   * normalisePlan/repairDelta already do. Runs before the strict parse on
   * the first attempt AND on each repaired response, so a repair turn
   * that fixes one field can't reintroduce a mistake this already handles.
   */
  normalise?: (raw: any) => void;
  /**
   * Repair round-trips allowed after the first attempt. Default 1 — two
   * total calls. Above 2 is rarely worth it: a model that has been told
   * precisely what's wrong twice and still can't produce the shape is
   * usually the wrong model for the task, and each attempt costs the
   * caller real wall-clock against a request timeout.
   */
  repairAttempts?: number;
  onProgress?: (event: StructuredProgressEvent) => void;
};

export type StructuredProgressEvent =
  | { kind: "attempt_start"; attempt: number; repair: boolean }
  | { kind: "invalid"; attempt: number; issues: string[] }
  /** Retrying the same request with a bigger output ceiling — see the
   *  reasoning-budget note in generateStructured. */
  | { kind: "widened"; attempt: number; maxTokens: number }
  | { kind: "ok"; attempt: number };

/** Tolerant JSON extraction — strips code fences and surrounding prose. */
export function extractJson(text: string): string {
  // Greedy so a JSON object inside a longer reply still parses.
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1");
  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  if (first < 0 || last <= first) return stripped.trim();
  return stripped.slice(first, last + 1);
}

/**
 * True when a reply's JSON stops before its outermost object closes — the
 * model ran out of output, it didn't write bad JSON. Counts brackets outside
 * strings rather than looking at the last character: a reply cut off just
 * after an inner object (`…"tableName": "x" }`) ends in "}" too, and was
 * being sent a repair turn that can only truncate in the same place again.
 */
export function looksTruncatedJson(text: string): boolean {
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1");
  const first = stripped.indexOf("{");
  if (first < 0) return false;
  let depth = 0, inString = false, escaped = false;
  for (let i = first; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
    } else if (ch === "\"") inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") { depth--; if (depth === 0) return false; }
  }
  return true;
}

/** Read the value the model actually emitted at a Zod issue's path. */
function valueAtPath(root: unknown, path: Array<string | number>): unknown {
  let cur: any = root;
  for (const seg of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[seg as any];
  }
  return cur;
}

/** One-line preview of a value, short enough to sit in a prompt. */
function preview(v: unknown): string {
  if (v === undefined) return "(missing)";
  if (v === null) return "null";
  if (typeof v === "string") return v.length > 60 ? JSON.stringify(v.slice(0, 60) + "…") : JSON.stringify(v);
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === "object") return `object{${Object.keys(v as object).slice(0, 4).join(",")}}`;
  return String(v);
}

/**
 * Render Zod issues as repair instructions. Each line carries the path,
 * what the schema wanted, and — the part that makes a model actually fix
 * it rather than guess — what it emitted there instead.
 */
export function formatIssues(issues: z.ZodIssue[], raw: unknown, limit = 12): string[] {
  return issues.slice(0, limit).map((i) => {
    const path = i.path.length > 0 ? i.path.join(".") : "(root)";
    const got = preview(valueAtPath(raw, i.path as Array<string | number>));
    return `${path} — ${i.message} (you sent: ${got})`;
  });
}

const REPAIR_PREAMBLE =
  "Your previous response did not match the required schema. " +
  "Fix ONLY the problems listed below and return the COMPLETE corrected " +
  "JSON object — not a diff, not an explanation, not a fragment. Keep " +
  "every part that was already valid exactly as it was.";

function repairMessage(issues: string[]): string {
  return `${REPAIR_PREAMBLE}\n\nProblems:\n${issues.map((s) => `  - ${s}`).join("\n")}`;
}

/**
 * Generate one schema-valid object, repairing on validation failure.
 *
 * Attempt 1 is the plain request. If JSON parsing or the strict parse
 * fails, the model is shown its own output plus the precise diagnosis and
 * asked to correct it — up to `repairAttempts` times.
 */
export async function generateStructured<S extends z.ZodTypeAny>(
  opts: GenerateStructuredOptions<S>,
): Promise<StructuredResult<z.infer<S>>> {
  const repairAttempts = Math.max(0, opts.repairAttempts ?? 1);
  const usage: StructuredUsage = { inputTokens: 0, outputTokens: 0 };

  // Grows by two entries per repair: the model's failed answer, then the
  // diagnosis. Keeping the failed answer in context is the point — the
  // model corrects what it can see, and re-deriving the whole artifact
  // from the prompt alone is exactly the expensive thing we're avoiding.
  const messages: LlmMessage[] = [{ role: "user", content: opts.prompt }];

  let lastIssues: string[] = [];
  let lastRaw = "";
  let model = "";

  // Reasoning models spend their output budget thinking BEFORE emitting a
  // token of the answer, so an exhausted budget means the ceiling was the
  // binding constraint — the model never got to answer at all. Shrinking
  // the request doesn't help there (and decomposition, which lowers the
  // per-call ceiling, actively hurts); widening it does. One widened retry,
  // once, then we stop guessing.
  let maxTokens = opts.maxTokens ?? 2000;
  let widened = false;

  // Repair turns actually SENT — not loop iterations. A widened retry burns
  // an iteration without ever asking the model to fix anything, so counting
  // iterations let it silently consume the repair budget: widen on attempt 1,
  // invalid on attempt 2, `2 > 1` → give up, having never sent the repair the
  // log said was being sent. Budget widening and schema repair address
  // different failures and must not compete for the same allowance.
  let repairsSent = 0;

  // +1 slot so the one budget-widening retry always has room of its own.
  for (let attempt = 1; attempt <= repairAttempts + 2; attempt++) {
    const isRepair = messages.length > 1;
    if (opts.signal?.aborted) {
      return { ok: false, error: "Cancelled.", failureKind: "transport", attempts: attempt - 1, usage };
    }
    opts.onProgress?.({ kind: "attempt_start", attempt, repair: isRepair });

    const resp = await callLLM({
      tenantId: opts.tenantId,
      userId: opts.userId ?? null,
      kind: isRepair ? `${opts.kind}.repair` : opts.kind,
      system: opts.system,
      messages,
      model: opts.model,
      maxTokens,
      timeoutMs: opts.timeoutMs,
      thinkingCap: opts.thinkingCap,
      retryTimeouts: opts.retryTimeouts,
      signal: opts.signal,
      // Repairs run colder than the original: this turn is a correction
      // against a stated spec, not a design decision, and sampling
      // variety is what produced the broken shape in the first place.
      temperature: isRepair ? 0 : (opts.temperature ?? 0.4),
      responseFormat: "json",
    });

    usage.inputTokens += resp.usage?.inputTokens ?? 0;
    usage.outputTokens += resp.usage?.outputTokens ?? 0;
    model = resp.model || model;

    // Transport-level failure (not configured, timeout, reasoning budget).
    // A repair turn can't help — the model never answered. Surface it with
    // the same envelope the call sites already branch on.
    if (resp.status !== "ok" || !resp.text) {
      // Budget exhausted with nothing emitted: give the same request more
      // room rather than treating it as a dead end. Once only — a model
      // that can't answer inside a widened ceiling isn't going to.
      if (!widened && (resp.error ?? "").includes("REASONING_BUDGET_EXHAUSTED")) {
        widened = true;
        maxTokens = Math.min(Math.round(maxTokens * 3), 8000);
        opts.onProgress?.({ kind: "widened", attempt, maxTokens });
        continue;
      }
      const h = humanizeLlmError(resp.error);
      return {
        ok: false,
        error: h.message,
        failureKind: h.notConfigured ? "not_configured" : "transport",
        notConfigured: h.notConfigured,
        canSwitchModel: h.canSwitchModel,
        fatal: isFatalProviderError(resp.error),
        attempts: attempt,
        usage,
      };
    }

    const rawText = resp.text;
    lastRaw = rawText;
    let parsed: any;
    try {
      parsed = JSON.parse(extractJson(rawText));
    } catch (e: any) {
      // Distinguish "cut off" from "malformed". A response that simply
      // stops — no closing brace — ran out of output budget mid-emit, and
      // a repair turn is the wrong answer: asked to fix it, the model
      // re-emits the same artifact and truncates at the same place. That
      // needs a bigger ceiling. Observed as `Expected ',' or ']' after
      // array element at position 4316` on a stage capped at 1600 tokens.
      const looksTruncated = looksTruncatedJson(rawText);
      if (looksTruncated && !widened) {
        widened = true;
        maxTokens = Math.min(Math.round(maxTokens * 3), 8000);
        opts.onProgress?.({ kind: "widened", attempt, maxTokens });
        continue;
      }
      lastIssues = [`(root) — the response was not valid JSON: ${e?.message ?? String(e)}`];
      opts.onProgress?.({ kind: "invalid", attempt, issues: lastIssues });
      if (repairsSent >= repairAttempts) break;
      messages.push({ role: "assistant", content: rawText });
      messages.push({ role: "user", content: repairMessage(lastIssues) });
      repairsSent++;
      continue;
    }

    // Local coercions first — free, and they shrink what the model is
    // asked to fix to only the genuinely novel mistakes.
    try {
      opts.normalise?.(parsed);
    } catch {
      /* a normaliser must never sink the attempt — let the parse judge */
    }

    const validated = opts.schema.safeParse(parsed);
    if (validated.success) {
      opts.onProgress?.({ kind: "ok", attempt });
      return {
        ok: true,
        value: validated.data,
        attempts: attempt,
        repaired: attempt > 1,
        raw: rawText,
        usage,
        model,
      };
    }

    lastIssues = formatIssues(validated.error.issues, parsed);
    opts.onProgress?.({ kind: "invalid", attempt, issues: lastIssues });
    if (repairsSent >= repairAttempts) break;
    messages.push({ role: "assistant", content: rawText });
    messages.push({ role: "user", content: repairMessage(lastIssues) });
    repairsSent++;
  }

  return {
    ok: false,
    error:
      `The AI could not produce a valid result after ${repairAttempts + 1} attempt${repairAttempts === 0 ? "" : "s"}.\n` +
      `(AI ไม่สามารถสร้างผลลัพธ์ที่ถูกต้องได้หลังจากพยายาม ${repairAttempts + 1} ครั้ง)\n\n` +
      `Details: ${lastIssues.join("; ")}`,
    // A model that answered but couldn't hit the shape twice is a
    // plausible sub-model problem, so offer the same switch-model retry
    // the transport failures do.
    failureKind: "invalid_shape",
    canSwitchModel: true,
    issues: lastIssues,
    raw: lastRaw || undefined,
    attempts: repairAttempts + 1,
    usage,
  };
}

// ── Staged generation ───────────────────────────────────────────────

export type Stage = {
  /** Key this stage's output is filed under for later stages + assemble(). */
  name: string;
  schema: z.ZodTypeAny;
  system: string;
  /** Built fresh each run so a stage can quote earlier stages' output. */
  prompt: (prior: Record<string, any>) => string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  thinkingCap?: number;
  normalise?: (raw: any) => void;
};

export type StagedProgressEvent =
  | { kind: "stage_start"; name: string; index: number; total: number }
  /** `value` is the stage's validated output and `durationMs` its wall time, so a caller can checkpoint it as it lands. */
  | { kind: "stage_ok"; name: string; index: number; attempts: number; value: unknown; durationMs: number }
  | { kind: "stage_failed"; name: string; index: number; error: string; failureKind: "not_configured" | "transport" | "invalid_shape"; durationMs: number }
  /** A stage taken from `resumeFrom` instead of being generated again. */
  | { kind: "stage_reused"; name: string; index: number }
  /**
   * A single stage's own generateStructured call is a full attempt/repair/
   * widen loop in miniature — without this, "widened the ceiling" and
   * "repairing a bad approvalChain" are real, informative moments that
   * happen and are then thrown away. Wrapped with stage context so a
   * listener (a UI activity log, primarily) can render "Stage 2 of 3:
   * widened the budget" rather than just "widened", which means nothing
   * without knowing which of several LLM calls it happened in.
   */
  | { kind: "stage_attempt"; name: string; index: number; event: StructuredProgressEvent };

export type GenerateStagedOptions<S extends z.ZodTypeAny> = {
  tenantId: string | null;
  kind: string;
  userId?: string | null;
  model?: string;
  stages: Stage[];
  /** Combine the validated stage outputs into the final artifact shape. */
  assemble: (prior: Record<string, any>) => unknown;
  /** The assembled artifact is validated once more as a whole. */
  finalSchema: S;
  finalNormalise?: (raw: any) => void;
  repairAttempts?: number;
  onProgress?: (event: StagedProgressEvent) => void;
  /**
   * Stage outputs from an earlier run that failed part-way (its
   * `completedStages`). Reused only as an unbroken prefix, and only while
   * each still passes its stage schema: a stage after one that runs fresh
   * was designed against output that no longer exists, so it runs fresh too.
   */
  resumeFrom?: Record<string, unknown>;
};

/**
 * Run several small structured generations in sequence, each validated on
 * its own, then assemble and validate the whole.
 *
 * Each stage sees every earlier stage's *validated* output, so stage 2
 * designs reports against the tables stage 1 actually produced rather
 * than tables it hopes exist — which is also why a stage failure stops
 * the run: everything downstream would be built on a gap.
 *
 * The final validation is not redundant. Stage schemas are necessarily
 * partial, so cross-field invariants that span stages (a report naming a
 * table, a watcher naming a report) are only checkable once assembled.
 */
export async function generateStaged<S extends z.ZodTypeAny>(
  opts: GenerateStagedOptions<S>,
): Promise<StructuredResult<z.infer<S>>> {
  const usage: StructuredUsage = { inputTokens: 0, outputTokens: 0 };
  const prior: Record<string, any> = {};
  let attempts = 0;
  let model = "";

  let reusing = !!opts.resumeFrom;
  for (let i = 0; i < opts.stages.length; i++) {
    const stage = opts.stages[i];
    if (reusing && opts.resumeFrom && stage.name in opts.resumeFrom) {
      const again = stage.schema.safeParse(opts.resumeFrom[stage.name]);
      if (again.success) {
        prior[stage.name] = again.data;
        opts.onProgress?.({ kind: "stage_reused", name: stage.name, index: i });
        continue;
      }
    }
    reusing = false;
    opts.onProgress?.({ kind: "stage_start", name: stage.name, index: i, total: opts.stages.length });
    const stageStarted = Date.now();

    const r = await generateStructured({
      tenantId: opts.tenantId,
      userId: opts.userId,
      kind: `${opts.kind}.${stage.name}`,
      schema: stage.schema,
      system: stage.system,
      prompt: stage.prompt(prior),
      model: opts.model,
      maxTokens: stage.maxTokens,
      temperature: stage.temperature,
      timeoutMs: stage.timeoutMs,
      thinkingCap: stage.thinkingCap,
      normalise: stage.normalise,
      onProgress: (event) => opts.onProgress?.({ kind: "stage_attempt", name: stage.name, index: i, event }),
      repairAttempts: opts.repairAttempts,
    });

    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    attempts += r.attempts;

    if (!r.ok) {
      opts.onProgress?.({ kind: "stage_failed", name: stage.name, index: i, error: r.error, failureKind: r.failureKind, durationMs: Date.now() - stageStarted });
      return {
        ok: false,
        error: `Stage "${stage.name}" failed. ${r.error}`,
        failureKind: r.failureKind,
        notConfigured: r.notConfigured,
        canSwitchModel: r.canSwitchModel,
        fatal: r.fatal,
        issues: r.issues,
        attempts,
        usage,
        completedStages: { ...prior },
      };
    }

    model = r.model || model;
    prior[stage.name] = r.value;
    opts.onProgress?.({ kind: "stage_ok", name: stage.name, index: i, attempts: r.attempts, value: r.value, durationMs: Date.now() - stageStarted });
  }

  const assembled = opts.assemble(prior);
  try {
    opts.finalNormalise?.(assembled);
  } catch {
    /* same policy as generateStructured — let the parse judge */
  }

  const validated = opts.finalSchema.safeParse(assembled);
  if (!validated.success) {
    const issues = formatIssues(validated.error.issues, assembled);
    return {
      ok: false,
      error:
        "The staged plan didn't fit together.\n" +
        "(แผนที่สร้างเป็นขั้นตอนไม่สามารถประกอบเข้าด้วยกันได้)\n\n" +
        `Details: ${issues.join("; ")}`,
      failureKind: "invalid_shape",
      canSwitchModel: true,
      issues,
      attempts,
      usage,
    };
  }

  return {
    ok: true,
    value: validated.data,
    attempts,
    // More round-trips than stages means at least one stage needed repairing.
    repaired: attempts > opts.stages.length,
    raw: JSON.stringify(assembled),
    usage,
    model,
  };
}
