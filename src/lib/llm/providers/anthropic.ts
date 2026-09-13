/**
 * Anthropic Messages API driver.
 *
 * Endpoint: https://api.anthropic.com/v1/messages
 * Auth:     x-api-key header
 * Versioning: anthropic-version: 2023-06-01
 *
 * Request shape: { model, max_tokens, system, messages: [{role, content}] }
 * Response shape: { content: [{type, text}], usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }, model }
 */
import type { LlmDriver, LlmRequest, LlmResponse, DriverContext } from "../types";

export const anthropicDriver: LlmDriver = {
  id: "anthropic",
  label: "Anthropic",
  defaultModel: "claude-sonnet-4-6",
  credentialHint: "API key from console.anthropic.com — starts with sk-ant-.",
  consoleUrl: "https://console.anthropic.com/settings/keys",
  async call(req: LlmRequest, ctx: DriverContext): Promise<LlmResponse> {
    const t0 = Date.now();
    try {
      // Anthropic doesn't natively support a "system" message in the
      // messages array — it goes into a top-level `system` field. We
      // join the request system prompt with any system-role messages
      // the caller passed.
      const sysMessages = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const conversation = req.messages.filter((m) => m.role !== "system");
      const system = [req.system, sysMessages].filter(Boolean).join("\n\n");

      // For JSON responseFormat: Anthropic has no native JSON mode, so
      // we coach via system prompt suffix. Callers still need to parse.
      const finalSystem = req.responseFormat === "json"
        ? system + "\n\nRespond with ONLY a single valid JSON object. No prose, no fences."
        : system;

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ctx.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: ctx.model,
          max_tokens: req.maxTokens ?? 1024,
          temperature: req.temperature,
          system: finalSystem || undefined,
          messages: conversation.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const durationMs = Date.now() - t0;
      if (!res.ok) {
        const body = (await res.text()).slice(0, 400);
        return {
          text: "",
          provider: "anthropic",
          model: ctx.model,
          status: "failed",
          error: `HTTP ${res.status}: ${body}`,
          usage: { inputTokens: 0, outputTokens: 0 },
          durationMs,
        };
      }
      const j = await res.json() as {
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
        model?: string;
      };
      const text = (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
      return {
        text,
        provider: "anthropic",
        model: j.model ?? ctx.model,
        status: "ok",
        usage: {
          inputTokens: j.usage?.input_tokens ?? 0,
          outputTokens: j.usage?.output_tokens ?? 0,
          cacheReadTokens: j.usage?.cache_read_input_tokens ?? 0,
          cacheCreateTokens: j.usage?.cache_creation_input_tokens ?? 0,
        },
        durationMs,
      };
    } catch (e: any) {
      return {
        text: "",
        provider: "anthropic",
        model: ctx.model,
        status: "failed",
        error: e?.message ?? String(e),
        usage: { inputTokens: 0, outputTokens: 0 },
        durationMs: Date.now() - t0,
      };
    }
  },
};
