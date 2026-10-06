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
import { isFatalProviderError, isTransientHttpStatus, parseRetryAfter, streamingEnabled } from "../resilience";

/**
 * Reasoning-off switch, only where the host is known to accept one — an
 * unknown body field is a 400 on strict OpenAI-compatible servers.
 * Moonshot: Kimi K2.5+ think by default and expose `thinking` (verified
 * live: kimi-k2.6 with no switch spends the whole max_tokens on
 * reasoning_content, exactly like kimi-k3). The "-code" variants are the
 * exception within the same family — verified live, kimi-k2.7-code 400s
 * on the `thinking` field itself ("model does not support thinking"), not
 * on its value, because those builds never think at all and don't expose
 * the switch. OpenAI o-series: `reasoning_effort`. Anything else: no field.
 */
export function reasoningFieldsFor(
  providerId: "openai" | "openai-compatible",
  baseUrl: string,
  model: string,
): Record<string, unknown> {
  if (/moonshot\.(ai|cn)/.test(baseUrl) && model.includes("kimi-") && !model.includes("-code")) {
    return { thinking: { type: "disabled" } };
  }
  if (providerId === "openai" && /^o\d/.test(model)) {
    return { reasoning_effort: "low" };
  }
  return {};
}

/** undici's `fetch failed` and the socket errors under it (reset, refused, DNS, TLS, body cut off). */
export function isNetworkError(e: any): boolean {
  if (!e || e.name === "AbortError") return false;
  const code = String(e?.cause?.code ?? e?.code ?? "");
  if (/^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR_)/.test(code)) return true;
  return /fetch failed|terminated|socket hang up/i.test(String(e?.message ?? ""));
}

/** Longest a streaming response may go without a single byte before it is called stalled (CURF_LLM_IDLE_MS, default 60s). */
export function idleTimeoutMs(): number {
  const n = Math.floor(Number(process.env.CURF_LLM_IDLE_MS));
  return Number.isFinite(n) && n >= 5_000 ? n : 60_000;
}

export type ChatCompletion = {
  choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  model?: string;
  /** ms from the start of the read until the first content or reasoning token. */
  firstTokenMs?: number;
};

/**
 * Fold an OpenAI-style server-sent-event body into the one object a
 * non-streaming call returns. `onChunk` fires for every read, which is how
 * the caller tells a model that is still thinking from a connection that
 * has gone quiet. Reasoning tokens count as activity: a thinking model
 * emits them for minutes before the first answer token.
 *
 * Moonshot reports usage inside choices[0] on the last chunk rather than at
 * the top level; both are read.
 */
/** Thrown by readChatStream when `stopWhen` says the model has thought long enough without answering. */
export class ThinkingCapped extends Error {
  constructor(public reasoningChars: number) { super("thinking cap reached"); }
}

export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onChunk: () => void,
  stopWhen?: (reasoningChars: number, contentChars: number) => boolean,
): Promise<ChatCompletion> {
  const started = Date.now();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let finish: string | undefined;
  let model: string | undefined;
  let usage: ChatCompletion["usage"];
  let firstTokenMs: number | undefined;

  const handle = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let j: any;
    try { j = JSON.parse(data); } catch { return; }
    if (j.model) model = j.model;
    const u = j.usage ?? j.choices?.[0]?.usage;
    if (u) usage = u;
    const ch = j.choices?.[0];
    if (!ch) return;
    if (ch.finish_reason) finish = ch.finish_reason;
    const d = ch.delta;
    if (d) {
      if (typeof d.content === "string" && d.content) content += d.content;
      if (typeof d.reasoning_content === "string" && d.reasoning_content) reasoning += d.reasoning_content;
      if (firstTokenMs === undefined && (d.content || d.reasoning_content)) firstTokenMs = Date.now() - started;
    }
  };

  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk();
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handle(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
    }
    if (stopWhen?.(reasoning.length, content.length)) {
      await reader.cancel().catch(() => undefined);
      throw new ThinkingCapped(reasoning.length);
    }
  }
  handle(buf.trim());
  return {
    choices: [{ message: { content, reasoning_content: reasoning }, finish_reason: finish }],
    usage, model, firstTokenMs,
  };
}

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
    const stream = streamingEnabled();
    const IDLE_MS = idleTimeoutMs();
    const controller = new AbortController();
    // Why WE aborted (a caller's own abort is told apart by req.signal).
    let abortCause: "wall" | "idle" | null = null;
    const timeoutId = setTimeout(() => { abortCause = "wall"; controller.abort(); }, REQUEST_TIMEOUT_MS);
    // Streaming only: a connection that delivers nothing for IDLE_MS is dead
    // however much of the wall-clock ceiling is left — found in a minute,
    // not five. Reasoning tokens stream, so a model that is thinking is
    // not idle.
    let idleId: ReturnType<typeof setTimeout> | undefined;
    const touchIdle = () => {
      if (!stream) return;
      if (idleId) clearTimeout(idleId);
      idleId = setTimeout(() => { abortCause = "idle"; controller.abort(); }, IDLE_MS);
    };
    touchIdle();
    // A caller's own abort (client disconnected, Cancel pressed) ends the
    // fetch the same way the timeout does — no point paying for tokens
    // nobody will read.
    if (req.signal?.aborted) controller.abort();
    else req.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    // Opt-in cut-off for runaway thinking (LlmRequest.thinkingCap): chars at ~3.7 per token, only while no answer text has started.
    const capTokens = stream && req.reasoning !== "off" && req.thinkingCap && req.thinkingCap > 0 && (req.maxTokens ?? 0) >= 2000
      ? Math.floor((req.maxTokens ?? 0) * Math.min(req.thinkingCap, 1))
      : 0;
    const thinkingStop = capTokens > 0
      ? (reasoningChars: number, contentChars: number) => contentChars === 0 && reasoningChars > capTokens * 3.7
      : undefined;

    const reasoningFields = req.reasoning === "off"
      ? reasoningFieldsFor(providerId, baseUrl, ctx.model)
      : {};

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
          ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
          ...reasoningFields,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const durationMs = Date.now() - t0;
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
          httpStatus: res.status,
          // A 429 that says the account is out of credit is not throttling: retrying it only repeats the refusal.
          retryable: isTransientHttpStatus(res.status) && !isFatalProviderError(body),
          retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
        };
      }
      const j: ChatCompletion = stream && res.body
        ? await readChatStream(res.body, touchIdle, thinkingStop)
        : await res.json() as ChatCompletion;
      // After the body is read: a streamed response sends its headers at once, so timing it any earlier measured the wait for the first byte, not the answer.
      const durationMs = Date.now() - t0;
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
        ...(j.firstTokenMs !== undefined ? { firstTokenMs: j.firstTokenMs } : {}),
      };
    } catch (e: any) {
      const durationMs = Date.now() - t0;
      if (e instanceof ThinkingCapped) {
        console.warn(`[llm:${providerId}] ${ctx.model} thought for ${e.reasoningChars} chars (cap ${capTokens} tokens) without answering — stopped after ${Math.round(durationMs / 1000)}s`);
        return {
          text: "", provider: providerId, model: ctx.model, status: "failed",
          error: `REASONING_BUDGET_EXHAUSTED: ${ctx.model} was still thinking after ${Math.round(e.reasoningChars / 3.7)} tokens and was stopped early.`,
          usage: { inputTokens: 0, outputTokens: Math.round(e.reasoningChars / 3.7) },
          durationMs, thinkingCapped: true,
        };
      }
      const cancelled = e?.name === "AbortError" && !!req.signal?.aborted;
      const aborted = e?.name === "AbortError" && !cancelled;
      const timedOut = aborted && abortCause !== "idle";
      const stalled = aborted && abortCause === "idle";
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
      if (stalled) {
        console.warn(`[llm:${providerId}] ${ctx.model} stalled — no data for ${IDLE_MS / 1000}s (after ${Math.round(durationMs / 1000)}s)`);
      }
      return {
        text: "",
        provider: providerId,
        model: ctx.model,
        status: "failed",
        error: stalled
          ? `Request stalled — no data from the model for ${Math.round(IDLE_MS / 1000)}s (after ${Math.round(durationMs / 1000)}s)`
          : timedOut ? `Request timed out after ${Math.round(durationMs / 1000)}s` : (e?.message ?? String(e)),
        usage: { inputTokens: 0, outputTokens: 0 },
        durationMs,
        // A timeout, a stall or a dropped connection (undici's "fetch failed":
        // reset, DNS, TLS) is the transport's, not the prompt's — worth
        // another try. An SSRF refusal or a malformed URL is ours and will
        // not heal.
        timedOut,
        retryable: timedOut || stalled || isNetworkError(e),
      };
    } finally {
      clearTimeout(timeoutId);
      if (idleId) clearTimeout(idleId);
    }
  };
}
