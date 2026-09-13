/**
 * OpenAI Chat Completions driver.
 *
 * Endpoint: https://api.openai.com/v1/chat/completions
 * Auth:     Authorization: Bearer <key>
 *
 * Request: { model, messages: [{role, content}], max_tokens?, temperature?, response_format? }
 * Response: { choices: [{message:{content}}], usage: { prompt_tokens, completion_tokens, prompt_tokens_details: { cached_tokens } }, model }
 *
 * Notes:
 *  - System prompt becomes a "system" role message at the front of the array.
 *  - JSON mode set via response_format: { type: "json_object" }. The user
 *    message must contain the literal word "json" or the API errors —
 *    we append a hint when responseFormat='json' to satisfy this.
 *  - Cache-read tokens land in usage.prompt_tokens_details.cached_tokens.
 *    There's no cache_create — those are billed at the regular input
 *    rate, so we record cacheReadTokens only.
 */
import type { LlmDriver, LlmRequest, LlmResponse, DriverContext } from "../types";
import { guardedFetch } from "@/lib/security/ssrfGuard";

export const openaiDriver: LlmDriver = {
  id: "openai",
  label: "OpenAI",
  defaultModel: "gpt-4o-mini",
  credentialHint: "API key from platform.openai.com — starts with sk-.",
  consoleUrl: "https://platform.openai.com/api-keys",
  call: openaiCompatibleCall("openai", "https://api.openai.com/v1"),
};

/**
 * Shared call function used by both the OpenAI driver and the
 * openai-compatible driver. The protocol is identical; only the base URL
 * + provider id differ.
 */
export function openaiCompatibleCall(
  providerId: "openai" | "openai-compatible",
  defaultBaseUrl: string,
) {
  return async function call(req: LlmRequest, ctx: DriverContext): Promise<LlmResponse> {
    const t0 = Date.now();
    const baseUrl = (ctx.baseUrl ?? defaultBaseUrl).replace(/\/+$/, "");

    const messages: Array<{ role: string; content: string }> = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) messages.push({ role: m.role, content: m.content });

    // OpenAI JSON mode requires the literal word "json" in the user
    // turn. We patch in a one-line system reminder if responseFormat
    // is json. Cheap insurance against accidental 400s.
    //
    // When the caller asked for no reasoning (fast, Q&A-shaped kinds — see
    // isFastKind), also say so in words: a host without a `thinking`
    // switch (below) still gets the hint, and a verbose thinker that
    // ignores it would otherwise burn the whole max_tokens on hidden
    // reasoning_content and never write the JSON (REASONING_BUDGET_
    // EXHAUSTED below). Design work — Master Builder, instant views, the
    // agent — is routed to the reasoning model precisely so it CAN think;
    // it must not be told not to.
    let response_format: any = undefined;
    if (req.responseFormat === "json") {
      response_format = { type: "json_object" };
      messages.push({
        role: "system",
        content: req.reasoning === "off"
          ? "Respond with a single valid JSON object. Answer directly — do not use extended step-by-step reasoning or chain-of-thought."
          : "Respond with a single valid JSON object.",
      });
    }

    // The Kimi line pins temperature per model AND per mode — verified
    // live: kimi-k3 400s with "only 1 is allowed", kimi-k2.6 with
    // thinking disabled 400s with "only 0.6 is allowed". Forcing any one
    // value therefore breaks some combination; omitting the field lets
    // the server apply the value it insists on. Matched on the whole
    // "kimi-" family so a newer generation doesn't regress into this.
    let finalTemperature = req.temperature;
    if (ctx.model.includes("kimi-")) {
      finalTemperature = undefined;
    }

    // Hard wall-clock cap. Nothing here previously bounded the fetch at
    // all — a stuck provider could hang a synchronous, user-waiting
    // request indefinitely with no error, just a spinner. Fail fast and
    // clearly instead of leaving the caller guessing.
    //
    // 90s, not something tighter: reasoning ("thinking") models have
    // genuinely variable think time per request — the same model/prompt
    // pair that answers in 20s can legitimately need much longer on a
    // harder call, and cutting it off early trades a slow success for a
    // guaranteed failure. This is a ceiling against a truly stuck
    // request, not a target latency — Master Builder's own UI copy still
    // says "30-60 seconds" for the common case.
    // A caller with evidence that its path is slow (see LlmRequest.timeoutMs)
    // can raise this for itself without changing what a stuck request costs
    // everyone else. Clamped so a bad value can't hang a request forever.
    const REQUEST_TIMEOUT_MS = Math.min(Math.max(req.timeoutMs ?? 90_000, 5_000), 300_000);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    // A caller's own abort (client disconnected, Cancel pressed) ends the
    // fetch the same way the timeout does — no point paying for tokens
    // nobody will read.
    if (req.signal?.aborted) controller.abort();
    else req.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    // Reasoning switch, only where the host is known to accept one — an
    // unknown body field is a 400 on strict OpenAI-compatible servers.
    // Moonshot: Kimi K2.5+ think by default and expose `thinking`
    // (verified live: kimi-k2.6 with no switch spends the whole
    // max_tokens on reasoning_content, exactly like kimi-k3). OpenAI
    // o-series: `reasoning_effort`. Anything else: no field.
    const reasoningFields: Record<string, unknown> = {};
    if (req.reasoning === "off") {
      if (/moonshot\.(ai|cn)/.test(baseUrl) && ctx.model.includes("kimi-")) {
        reasoningFields.thinking = { type: "disabled" };
      } else if (providerId === "openai" && /^o\d/.test(ctx.model)) {
        reasoningFields.reasoning_effort = "low";
      }
    }

    try {
      const requestedMaxTokens = req.maxTokens ?? 1024;
      const res = await guardedFetch(baseUrl + "/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + ctx.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: ctx.model,
          messages,
          max_tokens: requestedMaxTokens,
          temperature: finalTemperature,
          response_format,
          ...reasoningFields,
        }),
        signal: controller.signal,
      });
      const durationMs = Date.now() - t0;
      if (!res.ok) {
        const body = (await res.text()).slice(0, 400);
        console.warn(`[llm:${providerId}] HTTP ${res.status} calling ${ctx.model}: ${body}`);
        return {
          text: "",
          provider: providerId,
          model: ctx.model,
          status: "failed",
          error: `HTTP ${res.status}: ${body}`,
          usage: { inputTokens: 0, outputTokens: 0 },
          durationMs,
        };
      }
      const j = await res.json() as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
        model?: string;
      };
      const text = (j.choices?.[0]?.message?.content ?? "").trim();
      const finishReason = j.choices?.[0]?.finish_reason;
      const reasoningChars = j.choices?.[0]?.message?.reasoning_content?.length ?? 0;

      // Some OpenAI-compatible reasoning ("thinking") models return their
      // chain-of-thought in a separate reasoning_content field and count it
      // against the SAME max_tokens budget as the final answer. On a large
      // prompt the model can spend the whole budget thinking and hit
      // finish_reason: "length" with reasoning_content full but the
      // visible content empty (or, with a bigger budget, present but cut
      // off mid-JSON) — a real request that produced nothing usable,
      // easy to mistake for a moderation block. Surfacing it as a plain
      // "failed" with a distinct, greppable error (REASONING_BUDGET_
      // EXHAUSTED, read by humanizeLlmError) beats silently retrying at a
      // bigger budget: retrying doubles an already 30-60s user-facing wait,
      // and in practice a model that exhausts its budget on a given prompt
      // tends to do so again at 4x the budget too — it's not a reliable fix,
      // just a slower failure. Fail fast; let the admin pick a different
      // sub-model (surfaced ahead of time by the Test Connection check).
      if (!text && finishReason === "length" && reasoningChars > 0) {
        console.warn(
          `[llm:${providerId}] ${ctx.model} exhausted ${requestedMaxTokens} max_tokens on reasoning ` +
          `(${reasoningChars} chars) before producing an answer — durationMs=${durationMs}`,
        );
        return {
          text: "",
          provider: providerId,
          model: j.model ?? ctx.model,
          status: "failed",
          error: `REASONING_BUDGET_EXHAUSTED: ${ctx.model} spent its entire token budget on internal reasoning and produced no answer.`,
          usage: {
            inputTokens: j.usage?.prompt_tokens ?? 0,
            outputTokens: j.usage?.completion_tokens ?? 0,
            cacheReadTokens: j.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          },
          durationMs,
        };
      }
      if (!text) {
        console.warn(
          `[llm:${providerId}] empty content from ${ctx.model} — finish_reason=${finishReason ?? "?"} ` +
          `reasoning_content=${reasoningChars ? `${reasoningChars} chars` : "none"} durationMs=${durationMs}`,
        );
      }
      return {
        text,
        provider: providerId,
        model: j.model ?? ctx.model,
        status: "ok",
        usage: {
          inputTokens: j.usage?.prompt_tokens ?? 0,
          outputTokens: j.usage?.completion_tokens ?? 0,
          cacheReadTokens: j.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        },
        durationMs,
      };
    } catch (e: any) {
      const durationMs = Date.now() - t0;
      const cancelled = e?.name === "AbortError" && !!req.signal?.aborted;
      const timedOut = e?.name === "AbortError" && !cancelled;
      if (cancelled) {
        return {
          text: "", provider: providerId, model: ctx.model, status: "failed",
          error: "Cancelled", usage: { inputTokens: 0, outputTokens: 0 }, durationMs,
        };
      }
      if (timedOut) {
        // Unlike the empty-content/reasoning-exhausted case above, an
        // abort never reaches the response-parsing code, so without this
        // there's no server-side trace at all of a timeout ever having
        // happened — worth knowing when a specific model/prompt pair is
        // running close to the ceiling.
        console.warn(`[llm:${providerId}] ${ctx.model} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      return {
        text: "",
        provider: providerId,
        model: ctx.model,
        status: "failed",
        error: timedOut ? `Request timed out after ${Math.round(durationMs / 1000)}s` : (e?.message ?? String(e)),
        usage: { inputTokens: 0, outputTokens: 0 },
        durationMs,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  };
}
