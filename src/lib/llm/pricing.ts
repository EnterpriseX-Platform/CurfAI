/**
 * Per-provider, per-1M-token rates (USD).
 *
 * Cost computed in micro-USD (1_000_000 = $1). Int storage holds three
 * decimal places without floating-point drift. Rates change rarely; a
 * redeploy is the right granularity.
 *
 * Add a new model: append to the right provider table. Unknown models
 * trigger a fuzzy-prefix match before giving up. If neither matches the
 * usage row records null cost — surfaced as "unknown cost" in the UI.
 */
import type { ProviderId } from "./types";

export type ModelRate = {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
  cacheCreatePer1M?: number;
};

const RATES: Record<ProviderId, Record<string, ModelRate>> = {
  anthropic: {
    "claude-sonnet-4-6": { inputPer1M: 3.0, outputPer1M: 15.0, cacheReadPer1M: 0.30, cacheCreatePer1M: 3.75 },
    "claude-sonnet-4-5": { inputPer1M: 3.0, outputPer1M: 15.0, cacheReadPer1M: 0.30, cacheCreatePer1M: 3.75 },
    "claude-sonnet-4":   { inputPer1M: 3.0, outputPer1M: 15.0, cacheReadPer1M: 0.30, cacheCreatePer1M: 3.75 },
    "claude-opus-4-6":   { inputPer1M: 15.0, outputPer1M: 75.0, cacheReadPer1M: 1.50, cacheCreatePer1M: 18.75 },
    "claude-opus-4":     { inputPer1M: 15.0, outputPer1M: 75.0, cacheReadPer1M: 1.50, cacheCreatePer1M: 18.75 },
    "claude-haiku-4-5":  { inputPer1M: 0.80, outputPer1M: 4.0, cacheReadPer1M: 0.08, cacheCreatePer1M: 1.0 },
  },
  openai: {
    // GPT-4o family
    "gpt-4o":             { inputPer1M: 2.50, outputPer1M: 10.0, cacheReadPer1M: 1.25 },
    "gpt-4o-mini":        { inputPer1M: 0.15, outputPer1M: 0.60, cacheReadPer1M: 0.075 },
    // GPT-4.1 family
    "gpt-4.1":            { inputPer1M: 2.0, outputPer1M: 8.0, cacheReadPer1M: 0.50 },
    "gpt-4.1-mini":       { inputPer1M: 0.40, outputPer1M: 1.60, cacheReadPer1M: 0.10 },
    // o-series reasoning
    "o3":                 { inputPer1M: 2.0, outputPer1M: 8.0, cacheReadPer1M: 0.50 },
    "o3-mini":            { inputPer1M: 1.10, outputPer1M: 4.40, cacheReadPer1M: 0.55 },
    "o4-mini":            { inputPer1M: 1.10, outputPer1M: 4.40, cacheReadPer1M: 0.275 },
  },
  gemini: {
    // 2.5 family
    "gemini-2.5-pro":     { inputPer1M: 1.25, outputPer1M: 10.0 },
    "gemini-2.5-flash":   { inputPer1M: 0.30, outputPer1M: 2.50 },
    "gemini-2.5-flash-lite": { inputPer1M: 0.10, outputPer1M: 0.40 },
    // 2.0 family
    "gemini-2.0-flash":   { inputPer1M: 0.10, outputPer1M: 0.40 },
    "gemini-2.0-flash-lite": { inputPer1M: 0.075, outputPer1M: 0.30 },
  },
  // Catch-all — covers Kimi/Together/OpenRouter/Groq/DeepSeek/Ollama/etc.
  // Pricing varies wildly by host, so we leave this empty and the
  // dashboard shows "unknown cost". Tenant admins paste their own
  // models; any matching key here is used; otherwise null cost.
  "openai-compatible": {
    // Moonshot (Kimi) list prices, confirmed live 2026-09-13 against
    // platform.kimi.ai/docs/pricing/chat and a real account (the account's
    // available-model list no longer includes the earlier kimi-k2 /
    // kimi-k2-turbo-preview / kimi-k2-thinking / moonshot-v1-* ids at all —
    // Moonshot sunset the whole moonshot-v1 line and kimi-k2.5 on
    // 2026-08-31). kimi-k3 is the current flagship; the k2.6/k2.7-code
    // lines are cheaper, faster, coding-leaning siblings. cacheReadPer1M
    // is Moonshot's "cache hit" rate; there's no separate cache-write
    // premium published, so cacheCreatePer1M is left to its default
    // (1.25x input) rather than guessed.
    "kimi-k3":                { inputPer1M: 3.00, outputPer1M: 15.00, cacheReadPer1M: 0.30 },
    "kimi-k2.7-code-highspeed": { inputPer1M: 1.90, outputPer1M: 8.00, cacheReadPer1M: 0.38 },
    "kimi-k2.7-code":         { inputPer1M: 0.95, outputPer1M: 4.00, cacheReadPer1M: 0.19 },
    "kimi-k2.6":              { inputPer1M: 0.95, outputPer1M: 4.00, cacheReadPer1M: 0.16 },
    "deepseek-chat":      { inputPer1M: 0.27, outputPer1M: 1.10 },
    "deepseek-reasoner":  { inputPer1M: 0.55, outputPer1M: 2.19 },
  },
};

export function computeMicroCost(opts: {
  provider: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
}): number | null {
  const table = RATES[opts.provider];
  if (!table) return null;
  let rate = table[opts.model];
  if (!rate) {
    // Fuzzy-match by family prefix so "gpt-4o-2024-11-20" maps to "gpt-4o".
    for (const k of Object.keys(table)) {
      if (opts.model.startsWith(k)) { rate = table[k]; break; }
    }
  }
  if (!rate) return null;
  const cacheRead = rate.cacheReadPer1M ?? rate.inputPer1M;
  const cacheCreate = rate.cacheCreatePer1M ?? rate.inputPer1M * 1.25;
  const usd =
    (opts.inputTokens / 1_000_000) * rate.inputPer1M +
    (opts.outputTokens / 1_000_000) * rate.outputPer1M +
    ((opts.cacheReadTokens ?? 0) / 1_000_000) * cacheRead +
    ((opts.cacheCreateTokens ?? 0) / 1_000_000) * cacheCreate;
  return Math.round(usd * 1_000_000);
}

/**
 * Cost for a call that is METERED against a workspace's AI credits — i.e.
 * one made on Curf's own key. Never null: a model the table doesn't know
 * is charged at the provider's dearest known rate (or Sonnet's, for a
 * provider with no table) so a new model can't run unmetered until
 * someone updates this file. Curf chooses the model on its own key, so in
 * practice this fallback only fires between a model launch and the
 * next deploy.
 */
export function computeMicroCostMetered(opts: Parameters<typeof computeMicroCost>[0]): number {
  const exact = computeMicroCost(opts);
  if (exact != null) return exact;
  const table = RATES[opts.provider] ?? {};
  const dearest = Object.values(table).sort((a, b) => b.outputPer1M - a.outputPer1M)[0] ?? RATES.anthropic["claude-sonnet-4-6"];
  console.warn(`[llm] no list price for ${opts.provider}/${opts.model}; metering at ${dearest.outputPer1M}/1M output`);
  const usd =
    (opts.inputTokens / 1_000_000) * dearest.inputPer1M +
    (opts.outputTokens / 1_000_000) * dearest.outputPer1M +
    ((opts.cacheReadTokens ?? 0) / 1_000_000) * (dearest.cacheReadPer1M ?? dearest.inputPer1M) +
    ((opts.cacheCreateTokens ?? 0) / 1_000_000) * (dearest.cacheCreatePer1M ?? dearest.inputPer1M * 1.25);
  return Math.round(usd * 1_000_000);
}

export function formatMicroUsd(microUsd: number | null | undefined): string {
  if (microUsd == null) return "—";
  const usd = microUsd / 1_000_000;
  if (usd === 0) return "$0";
  if (usd < 0.001) return `$${(usd * 100).toFixed(4)}¢`;
  if (usd < 0.01) return `${(usd * 100).toFixed(2)}¢`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString()}`;
}
