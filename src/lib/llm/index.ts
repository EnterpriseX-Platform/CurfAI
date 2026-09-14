/**
 * Unified LLM entrypoint.
 *
 *   const r = await callLLM({
 *     tenantId, kind: "ask",
 *     system: "You are Curf, an analyst…",
 *     messages: [{ role: "user", content: "Why is Q3 down?" }],
 *     maxTokens: 600,
 *   });
 *
 * Resolves the active provider (anthropic/openai/gemini/openai-compatible),
 * dispatches to the right driver, records token usage to the LlmTokenUsage
 * table for the /admin/usage dashboard, and returns a uniform LlmResponse.
 *
 * Caller code never references provider-specific endpoints, headers, or
 * payload shapes. The only place provider knowledge lives is here +
 * lib/llm/providers/.
 */
import { prisma } from "@/lib/db";
import { anthropicDriver } from "./providers/anthropic";
import { openaiDriver } from "./providers/openai";
import { geminiDriver } from "./providers/gemini";
import { openaiCompatibleDriver } from "./providers/openai-compatible";
import { getLlmCredentials } from "./credentials";
import { computeMicroCost, computeMicroCostMetered } from "./pricing";
import { hasEnvLlm } from "./credentials";
import { llmTokens } from "@/lib/metrics";
import { requireAiCredits } from "@/lib/billing";
import type { NextResponse } from "next/server";
import type { LlmDriver, LlmRequest, LlmResponse, ProviderId } from "./types";

const DRIVERS: Record<ProviderId, LlmDriver> = {
  anthropic: anthropicDriver,
  openai: openaiDriver,
  gemini: geminiDriver,
  "openai-compatible": openaiCompatibleDriver,
};

export function getDriver(id: ProviderId): LlmDriver {
  return DRIVERS[id];
}

export function listDrivers(): LlmDriver[] {
  return Object.values(DRIVERS);
}

/** Friendly "AI not configured" reply shape used by callers when needed. */
export function notConfiguredResponse(req: LlmRequest): LlmResponse {
  return {
    text: "",
    provider: "anthropic",
    model: "",
    status: "failed",
    error: "AI is not configured for this workspace. Set a provider + key in Tenant Settings → LLM.",
    usage: { inputTokens: 0, outputTokens: 0 },
    durationMs: 0,
  };
}

/** True when any path can resolve credentials (env or tenant). */
export function isLlmEnabled(): boolean {
  if ((process.env.CURF_LLM ?? "").toLowerCase() === "off") return false;
  return hasEnvLlm();
}

/**
 * Run an LLM call with full provider abstraction + usage recording.
 *
 * Errors are NEVER thrown — the response always returns; check
 * `status === 'failed'` and `error` for failure paths. This matches the
 * style of the legacy direct-fetch sites it replaces (so refactors are
 * one-for-one without introducing new try/catch boilerplate).
 */
/**
 * Ceiling for the one widened retry after REASONING_BUDGET_EXHAUSTED.
 *
 * Chosen to clear the thinking budget of the reasoning models we've seen
 * (Kimi's exhaust well past 800) while still bounding a runaway generation.
 * Deliberately below the plan-generation ceilings in lib/agent/structured.ts,
 * which retries far larger JSON payloads and manages its own escalation.
 */
const REASONING_RETRY_CEILING = 4000;

/**
 * Which calls go to the tenant's fast model when one is configured.
 * "Fast" = a grounded, short-output task — a question over a data summary,
 * a caption, a one-line digest, a form draft — where a reasoning model
 * spends its whole budget thinking about nothing and answers in 30 s.
 * Everything else (Master Builder plan/design/iterate, report generation,
 * instant views, the agent, template authoring) is design work and keeps
 * `llmModel`. Match by prefix so new sub-kinds of a family inherit it.
 */
const FAST_KIND_PREFIXES = [
  "ask", "why", "caption", "operate_suggest", "operate.document_draft", "brief", "story", "digest",
  "watcher", "watcherSuggest", "suggest", "document_qa", "marketplace", "forecast", "dashboard.recommend_kpis", "search", "qa",
];

export function isFastKind(kind: string): boolean {
  return FAST_KIND_PREFIXES.some((p) => kind === p || kind.startsWith(p + ".") || kind.startsWith(p + "_"));
}

/**
 * The 402 an API route should return before it makes a model call on the
 * workspace's behalf, or null when the call may proceed. Only calls on
 * Curf's own key (env credentials) draw down the workspace's AI credits;
 * a workspace on its own key is never metered.
 */
export async function requireAiCreditsFor(tenantId: string): Promise<NextResponse | null> {
  const creds = await getLlmCredentials(tenantId);
  if (!creds || creds.source !== "env") return null;
  return requireAiCredits(tenantId);
}

export const AI_CREDITS_EXHAUSTED = "AI_CREDITS_EXHAUSTED";

export async function callLLM(req: LlmRequest): Promise<LlmResponse> {
  const creds = await getLlmCredentials(req.tenantId);
  if (!creds) return notConfiguredResponse(req);

  // Every call on Curf's key is metered here, so a feature that forgets
  // its route-level check still can't spend past the allowance.
  if (creds.source === "env" && req.tenantId) {
    const block = await requireAiCredits(req.tenantId);
    if (block) {
      const body = await block.json().catch(() => ({}));
      return {
        text: "",
        provider: creds.provider,
        model: "",
        status: "failed",
        error: `${AI_CREDITS_EXHAUSTED}: ${body?.error ?? "AI credits for this month are used up."}`,
        usage: { inputTokens: 0, outputTokens: 0 },
        durationMs: 0,
      };
    }
  }

  const driver = DRIVERS[creds.provider];
  if (!driver) {
    return {
      text: "",
      provider: creds.provider,
      model: "",
      status: "failed",
      error: `No driver registered for provider ${creds.provider}.`,
      usage: { inputTokens: 0, outputTokens: 0 },
      durationMs: 0,
    };
  }

  // openai-compatible: the driver needs a base URL; refuse politely if
  // the tenant didn't set one rather than dispatch to "" and 404.
  if (driver.needsBaseUrl && !creds.baseUrl) {
    return {
      text: "",
      provider: creds.provider,
      model: "",
      status: "failed",
      error: "OpenAI-compatible provider requires a base URL — set one in Tenant Settings → LLM.",
      usage: { inputTokens: 0, outputTokens: 0 },
      durationMs: 0,
    };
  }

  // Resolve model: request override > tenant fast model (Q&A-shaped kinds
  // only, when configured) > tenant llmModel > driver default. Fast kinds
  // also ask the provider not to think (see LlmRequest.reasoning) — on
  // Moonshot even the K2 line thinks by default, so a fast model alone
  // doesn't buy the speed.
  const fast = isFastKind(req.kind);
  const model = req.model || (fast ? creds.fastModel : null) || creds.model || driver.defaultModel;
  if (fast && req.reasoning === undefined) req = { ...req, reasoning: "off" };

  // Dispatch.
  let resp = await driver.call(req, {
    apiKey: creds.apiKey,
    baseUrl: creds.baseUrl,
    model,
  });

  // One widened retry when a reasoning model spends its whole budget
  // thinking and emits nothing.
  //
  // Call sites size maxTokens for the answer they expect — 120 for a chart
  // caption, 200 for a 280-character narrative — which is correct for a
  // non-reasoning model and fatal for a reasoning one, where hidden thinking
  // tokens are drawn from the SAME ceiling before any visible output. The
  // result is a feature that silently never works on that model, and a user
  // being told their key is missing.
  //
  // Retrying is close to free: maxTokens is a cap, not a reservation, and
  // providers bill for tokens actually generated. An undersized ceiling
  // costs a total failure; a generous one costs nothing unless the model
  // really does use it. Done here rather than by editing every call site so
  // a new one can't reintroduce it — and lib/agent/structured.ts keeps its
  // own wider escalation for the much larger plan payloads.
  const askedFor = req.maxTokens ?? 0;
  if (
    resp.status === "failed" &&
    (resp.error ?? "").includes("REASONING_BUDGET_EXHAUSTED") &&
    askedFor > 0 &&
    askedFor < REASONING_RETRY_CEILING
  ) {
    resp = await driver.call(
      { ...req, maxTokens: REASONING_RETRY_CEILING },
      { apiKey: creds.apiKey, baseUrl: creds.baseUrl, model },
    );
  }

  // Record usage. Best-effort — we never let a logging failure poison
  // the user-facing response. Use setImmediate so token write doesn't
  // add to the request latency.
  if (req.tenantId) {
    const tenantId = req.tenantId;
    llmTokens.inc?.(
      { tenant: tenantId, kind: req.kind },
      resp.usage.inputTokens + resp.usage.outputTokens,
    );
    setImmediate(() => {
      // A call on Curf's key draws down AI credits, so its cost must never
      // be null; a workspace's own key is only reported, never metered.
      const microCostUsd = (creds.source === "env" ? computeMicroCostMetered : computeMicroCost)({
        provider: resp.provider,
        model: resp.model,
        inputTokens: resp.usage.inputTokens,
        outputTokens: resp.usage.outputTokens,
        cacheReadTokens: resp.usage.cacheReadTokens,
        cacheCreateTokens: resp.usage.cacheCreateTokens,
      });
      prisma.llmTokenUsage.create({
        data: {
          tenantId,
          userId: req.userId ?? undefined,
          kind: req.kind,
          provider: resp.provider,
          model: resp.model,
          inputTokens: resp.usage.inputTokens,
          outputTokens: resp.usage.outputTokens,
          cacheReadTokens: resp.usage.cacheReadTokens ?? 0,
          cacheCreateTokens: resp.usage.cacheCreateTokens ?? 0,
          microCostUsd,
          keySource: creds.source === "env" ? "platform" : "tenant",
          reportId: req.reportId ?? null,
          durationMs: resp.durationMs,
          status: resp.status,
          errorKind: resp.status === "failed" ? classifyError(resp.error) : null,
        },
      }).catch(() => null);
    });
  }

  return resp;
}

function classifyError(err: string | undefined): string {
  if (!err) return "unknown";
  const e = err.toLowerCase();
  if (e === "cancelled") return "cancelled"; // caller aborted (see LlmRequest.signal) — not a provider fault
  if (e.includes("rate") && e.includes("limit")) return "rate_limit";
  if (e.includes("timeout") || e.includes("aborted")) return "timeout";
  if (e.includes("401") || e.includes("invalid") && e.includes("key")) return "invalid_key";
  if (e.includes("403")) return "forbidden";
  if (e.includes("400")) return "bad_request";
  if (e.includes("500") || e.includes("502") || e.includes("503")) return "server_error";
  return "unknown";
}

export type { LlmRequest, LlmResponse, LlmMessage, ProviderId } from "./types";
