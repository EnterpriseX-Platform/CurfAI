/**
 * Google Gemini driver.
 *
 * Endpoint: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 * Auth:     ?key=<api-key> query string (POST body otherwise)
 *
 * Request: { contents: [{role, parts: [{text}]}], systemInstruction: { parts: [{text}] }, generationConfig: { maxOutputTokens, temperature, responseMimeType? } }
 * Response: { candidates: [{content: {parts: [{text}]}}], usageMetadata: { promptTokenCount, candidatesTokenCount } }
 *
 * Notes:
 *  - Gemini's role enum is "user" | "model" — we map "assistant" → "model".
 *  - System prompts go in `systemInstruction`, not the messages array.
 *  - JSON mode via generationConfig.responseMimeType = "application/json".
 *  - No prompt caching surfaced via the standard usageMetadata.
 */
import type { LlmDriver, LlmRequest, LlmResponse, DriverContext } from "../types";

export const geminiDriver: LlmDriver = {
  id: "gemini",
  label: "Google Gemini",
  defaultModel: "gemini-2.5-flash",
  credentialHint: "API key from aistudio.google.com — works for Gemini Pro/Flash/Lite.",
  consoleUrl: "https://aistudio.google.com/app/apikey",
  async call(req: LlmRequest, ctx: DriverContext): Promise<LlmResponse> {
    const t0 = Date.now();
    try {
      const contents = req.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        }));

      // Gemini collapses system-role messages into systemInstruction.
      const sysFromMessages = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const systemText = [req.system, sysFromMessages].filter(Boolean).join("\n\n");

      const generationConfig: any = {
        maxOutputTokens: req.maxTokens ?? 1024,
        temperature: req.temperature,
      };
      if (req.responseFormat === "json") {
        generationConfig.responseMimeType = "application/json";
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ctx.model)}:generateContent?key=${encodeURIComponent(ctx.apiKey)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents,
          systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
          generationConfig,
        }),
      });
      const durationMs = Date.now() - t0;
      if (!res.ok) {
        const body = (await res.text()).slice(0, 400);
        return {
          text: "",
          provider: "gemini",
          model: ctx.model,
          status: "failed",
          error: `HTTP ${res.status}: ${body}`,
          usage: { inputTokens: 0, outputTokens: 0 },
          durationMs,
        };
      }
      const j = await res.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
        modelVersion?: string;
      };
      const text = (j.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "").join("").trim();
      return {
        text,
        provider: "gemini",
        model: j.modelVersion ?? ctx.model,
        status: "ok",
        usage: {
          inputTokens: j.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: j.usageMetadata?.candidatesTokenCount ?? 0,
          cacheReadTokens: j.usageMetadata?.cachedContentTokenCount ?? 0,
        },
        durationMs,
      };
    } catch (e: any) {
      return {
        text: "",
        provider: "gemini",
        model: ctx.model,
        status: "failed",
        error: e?.message ?? String(e),
        usage: { inputTokens: 0, outputTokens: 0 },
        durationMs: Date.now() - t0,
      };
    }
  },
};
