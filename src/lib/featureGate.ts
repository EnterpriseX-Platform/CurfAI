/**
 * Server-side feature gate.
 *
 * FEATURE_TIERS — "what tier do I need to use feature X" — lives in
 * lib/featureTiers.ts, which is pure so client components can import it.
 * This module adds featureGate(), the async 402 responder API routes call,
 * and re-exports the matrix so server code keeps a single import. Client
 * code must import lib/featureTiers.ts instead: this module reaches lib/db
 * through lib/billing (db.clientBundle.test.ts).
 *
 * This sits one layer above `requireTier()` from lib/billing.ts:
 *   - lib/billing.ts answers "does this user's tenant have at least Growth?"
 *   - lib/featureGate.ts answers "does this user's tenant have access to
 *     the Postgres connector / kiosk tokens / AI chart captions / …?"
 */
import type { NextResponse } from "next/server";
import type { CurfSessionUser } from "@/lib/auth";
import { requireTier } from "@/lib/billing";
import { planForTier, UPGRADE_URL } from "@/lib/plans";
import { FEATURE_TIERS, humanizeFeatureKey, type FeatureKey } from "@/lib/featureTiers";

export { FEATURE_TIERS, featureAvailable, humanizeFeatureKey } from "@/lib/featureTiers";
export type { FeatureKey } from "@/lib/featureTiers";

/**
 * Server-side gate. Returns null when the tenant has access; otherwise a
 * 402 NextResponse the API handler should return immediately.
 *
 *   const block = await featureGate(user, "connector.snowflake");
 *   if (block) return block;
 *
 * The 402 body adds `feature` + a human label so the client can render a
 * targeted upgrade prompt instead of a generic "upgrade required" toast.
 */
export async function featureGate(
  user: CurfSessionUser,
  key: FeatureKey,
): Promise<NextResponse | null> {
  const required = FEATURE_TIERS[key];
  const block = await requireTier(user, required);
  if (!block) return null;
  // requireTier already produced a 402 with currentTier/requiredTier/upgradeUrl;
  // we re-emit with feature context. We don't await/parse the original body —
  // we already know the values that went into it from FEATURE_TIERS.
  const NextResponse = (await import("next/server")).NextResponse;
  return NextResponse.json(
    {
      error: `${humanizeFeatureKey(key)} requires the ${planForTier(required).name} plan.`,
      feature: key,
      featureLabel: humanizeFeatureKey(key),
      requiredTier: required,
      upgradeUrl: UPGRADE_URL,
    },
    { status: 402 },
  );
}
