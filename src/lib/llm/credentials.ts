/**
 * Resolve the active LLM credentials for a tenant.
 *
 * Lookup order:
 *   1. Tenant.llmProvider + llmKeyEnc + llmModel + llmBaseUrl (new shape)
 *   2. Legacy Tenant.anthropicKeyEnc (anthropic-only fallback)
 *   3. Environment variables — CURF_LLM_PROVIDER + CURF_LLM_KEY +
 *      CURF_LLM_MODEL (+ CURF_LLM_FAST_MODEL) + CURF_LLM_BASE_URL, OR provider-specific envs
 *      (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY).
 *
 * Returns null when no usable credentials exist anywhere — caller emits
 * a friendly "AI not configured" message.
 */
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/secrets";
import type { ProviderId } from "./types";

export type ResolvedCredentials = {
  provider: ProviderId;
  apiKey: string;
  model: string | null;
  /** Optional model for Q&A-shaped kinds (see FAST_KINDS in index.ts); null = use `model`. */
  fastModel: string | null;
  baseUrl: string | null;
  /** Where the credentials came from — useful for error messages and logs. */
  source: "tenant" | "tenant-legacy" | "env";
};

const VALID_PROVIDERS: ProviderId[] = ["anthropic", "openai", "gemini", "openai-compatible"];

function isProviderId(s: string | null | undefined): s is ProviderId {
  return !!s && (VALID_PROVIDERS as string[]).includes(s);
}

export async function getLlmCredentials(
  tenantId: string | null | undefined,
): Promise<ResolvedCredentials | null> {
  // 1. Tenant — new shape
  if (tenantId) {
    try {
      const t = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          llmProvider: true,
          llmKeyEnc: true,
          llmModel: true,
          llmFastModel: true,
          llmBaseUrl: true,
          anthropicKeyEnc: true,
        },
      });
      if (t) {
        const provider: ProviderId = isProviderId(t.llmProvider) ? t.llmProvider : "anthropic";
        if (t.llmKeyEnc) {
          const apiKey = decryptSecret(t.llmKeyEnc);
          if (apiKey) {
            return {
              provider,
              apiKey,
              model: t.llmModel || null,
              fastModel: t.llmFastModel || null,
              baseUrl: t.llmBaseUrl || null,
              source: "tenant",
            };
          }
        }
        // 2. Legacy anthropic key fallback (only meaningful when provider === anthropic)
        if (provider === "anthropic" && t.anthropicKeyEnc) {
          const apiKey = decryptSecret(t.anthropicKeyEnc);
          if (apiKey) {
            return {
              provider: "anthropic",
              apiKey,
              model: t.llmModel || null,
              fastModel: t.llmFastModel || null,
              baseUrl: null,
              source: "tenant-legacy",
            };
          }
        }
      }
    } catch {
      // Pre-db-push tolerance — fall through to env.
    }
  }

  // 3. Environment fallback. CURF_LLM_PROVIDER is the modern way; the
  // provider-specific envs (ANTHROPIC_API_KEY, OPENAI_API_KEY,
  // GEMINI_API_KEY) keep us back-compatible with single-provider deployments.
  const envProvider = process.env.CURF_LLM_PROVIDER;
  if (isProviderId(envProvider) && process.env.CURF_LLM_KEY) {
    return {
      provider: envProvider,
      apiKey: process.env.CURF_LLM_KEY,
      model: process.env.CURF_LLM_MODEL || null,
      fastModel: process.env.CURF_LLM_FAST_MODEL || null,
      baseUrl: process.env.CURF_LLM_BASE_URL || null,
      source: "env",
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.CURF_LLM_MODEL || null,
      fastModel: process.env.CURF_LLM_FAST_MODEL || null,
      baseUrl: null,
      source: "env",
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.CURF_LLM_MODEL || null,
      fastModel: process.env.CURF_LLM_FAST_MODEL || null,
      baseUrl: null,
      source: "env",
    };
  }
  if (process.env.GEMINI_API_KEY) {
    return {
      provider: "gemini",
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.CURF_LLM_MODEL || null,
      fastModel: process.env.CURF_LLM_FAST_MODEL || null,
      baseUrl: null,
      source: "env",
    };
  }

  return null;
}

/** Lightweight check used by isLlmEnabled() — true when any path can resolve a key. */
export function hasEnvLlm(): boolean {
  return !!(
    (process.env.CURF_LLM_PROVIDER && process.env.CURF_LLM_KEY) ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GEMINI_API_KEY
  );
}
