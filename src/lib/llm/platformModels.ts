/**
 * The model Curf's own AI runs on for a workspace, by its subscription tier: a platform admin keeps a list of models
 * (PlatformModel) and picks one per tier (PlatformTierModel) at /admin/platform/models. A tier with no pick runs on the
 * CURF_LLM_* env model, so a deployment that never opens the page (the Community edition, a self-hosted instance)
 * behaves as before.
 *
 * Platform rows have no tenantId: they are read under withSystemDbContext, never through a workspace's filter. Read on
 * every model call, so they are cached for a short while; a save on the admin page clears this process's cache, and
 * other pods pick it up within CACHE_MS.
 */
import { prisma } from "@/lib/db";
import { withSystemDbContext } from "@/lib/dbContext";
import { decryptSecret } from "@/lib/secrets";
import type { ModelRate } from "./pricing";
import type { ProviderId } from "./types";

export const PLATFORM_PROVIDERS: ProviderId[] = ["anthropic", "openai", "gemini", "openai-compatible"];

export type PlatformModelCreds = {
  platformModelId: string;
  provider: ProviderId;
  apiKey: string;
  model: string;
  fastModel: string | null;
  baseUrl: string | null;
  thinkingOff: boolean;
  /** The metering rate the platform admin set; null = the list price in pricing.ts. */
  rate: ModelRate | null;
  /** A trial model: the app labels it so. */
  trial: boolean;
  /** Queue limits on this model's host (null = none); see LaneLimit in resilience.ts. */
  maxQueue: number | null;
  maxWaitSec: number | null;
};

const CACHE_MS = 30_000;
let cache: { at: number; byTier: Map<string, PlatformModelCreds> } | null = null;

export function clearPlatformModelCache(): void {
  cache = null;
}

/** The admin-set rate, when it has both an input and an output price. */
export function rateOf(m: { inputPer1M: number | null; outputPer1M: number | null; cacheReadPer1M: number | null }): ModelRate | null {
  if (m.inputPer1M == null || m.outputPer1M == null) return null;
  return { inputPer1M: m.inputPer1M, outputPer1M: m.outputPer1M, ...(m.cacheReadPer1M != null ? { cacheReadPer1M: m.cacheReadPer1M } : {}) };
}

async function load(): Promise<Map<string, PlatformModelCreds>> {
  const rows = await withSystemDbContext(() => prisma.platformTierModel.findMany({ include: { platformModel: true } }));
  const byTier = new Map<string, PlatformModelCreds>();
  for (const r of rows) {
    const m = r.platformModel;
    if (!(PLATFORM_PROVIDERS as string[]).includes(m.provider)) continue;
    const apiKey = decryptSecret(m.keyEnc);
    if (!apiKey) continue; // a key that no longer decrypts (rotated CURF secret): the tier falls back to env, not to a failing call
    byTier.set(r.tier, {
      platformModelId: m.id, provider: m.provider as ProviderId, apiKey, model: m.model,
      fastModel: m.fastModel || null, baseUrl: m.baseUrl || null, thinkingOff: m.thinkingOff, rate: rateOf(m),
      trial: m.trial, maxQueue: m.maxQueue, maxWaitSec: m.maxWaitSec,
    });
  }
  return byTier;
}

/** The platform model a tier runs on, or null for the env model. Never throws: a missing table or a read error means env. */
export async function platformModelForTier(tier: string | null | undefined): Promise<PlatformModelCreds | null> {
  try {
    if (!cache || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), byTier: await load() };
    return cache.byTier.get(tier || "community") ?? null;
  } catch {
    return null;
  }
}
