/**
 * OpenAI-compatible driver.
 *
 * Same protocol as OpenAI Chat Completions, but the user supplies the
 * base URL. Covers Together, OpenRouter, Groq, Kimi/Moonshot, DeepSeek,
 * Mistral, xAI (Grok), Fireworks, Perplexity, vLLM, Ollama, LM Studio,
 * and any host that implements the OpenAI Chat Completions API.
 *
 * The driver itself is just OpenAI's call function with a different
 * provider id and no hardcoded base URL — see openai.ts:openaiCompatibleCall.
 *
 * The base URL suggestions below populate a quick-pick in the settings
 * UI so admins don't have to remember each host's path. Kimi/Moonshot
 * has two regional endpoints (.cn for the China product, .ai for the
 * international one) — both are listed since which one an account can
 * reach depends on where the key was issued.
 */
import type { LlmDriver } from "../types";
import { openaiCompatibleCall } from "./openai";

export const openaiCompatibleDriver: LlmDriver = {
  id: "openai-compatible",
  label: "Custom (OpenAI-compatible)",
  // Confirmed live 2026-09-13 against a real Moonshot account: the
  // previous default here ("kimi-k2-0711-preview", and the K2/K2-Turbo/
  // K2-Thinking family generally) 404s — Moonshot sunset the whole
  // moonshot-v1 line and kimi-k2.5 on 2026-08-31, and the account's
  // available-model list no longer includes any of the pre-sunset ids
  // at all. kimi-k3 is the current flagship and is in the account's
  // model list on both regional endpoints — platform.kimi.ai (.ai) and
  // platform.kimi.com (.cn) publish the SAME model ids now (kimi-k3,
  // kimi-k2.6, kimi-k2.7-code, kimi-k2.7-code-highspeed), just priced in
  // USD vs RMB respectively. A tenant that left Model blank (as the
  // settings UI invites: "Leave blank to use the provider's default")
  // got a guaranteed failure on every call, not just the occasional
  // reasoning-budget flakiness — this is the fallback every such call
  // used, so it had to be a real, live model id.
  defaultModel: "kimi-k3",
  needsBaseUrl: true,
  credentialHint: "Any provider that speaks the OpenAI Chat Completions protocol — Kimi, DeepSeek, Mistral, xAI, Fireworks, Perplexity, Together, OpenRouter, Groq, vLLM, Ollama, LM Studio.",
  baseUrlSuggestions: [
    // Same model catalog on both endpoints as of 2026-09-13 (kimi-k3,
    // kimi-k2.6, kimi-k2.7-code, kimi-k2.7-code-highspeed) — only the
    // billing currency differs (USD vs RMB). lib/llm/pricing.ts only
    // holds USD rates, so a tenant on the China endpoint sees an
    // approximate USD-equivalent cost, not their real RMB bill.
    { label: "Kimi (Moonshot, Global)", url: "https://api.moonshot.ai/v1", defaultModel: "kimi-k3" },
    { label: "Kimi (Moonshot, China)",  url: "https://api.moonshot.cn/v1", defaultModel: "kimi-k3" },
    { label: "DeepSeek",        url: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat" },
    { label: "Mistral",         url: "https://api.mistral.ai/v1", defaultModel: "mistral-large-latest" },
    { label: "xAI (Grok)",      url: "https://api.x.ai/v1", defaultModel: "grok-4" },
    { label: "Fireworks",       url: "https://api.fireworks.ai/inference/v1", defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct" },
    { label: "Perplexity",      url: "https://api.perplexity.ai", defaultModel: "sonar" },
    { label: "Groq",            url: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b-versatile" },
    { label: "Together",        url: "https://api.together.xyz/v1", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
    { label: "OpenRouter",      url: "https://openrouter.ai/api/v1", defaultModel: "anthropic/claude-sonnet-4.5" },
    { label: "Ollama (local)",  url: "http://localhost:11434/v1", defaultModel: "llama3" },
    { label: "LM Studio",       url: "http://localhost:1234/v1", defaultModel: "local-model" },
  ],
  // No default base URL — caller MUST set ctx.baseUrl. callLLM() guards
  // this and returns a friendly error before we get here.
  call: openaiCompatibleCall("openai-compatible", ""),
};
