/**
 * Entitlements — what a Curf operator agreed with one workspace outside
 * self-serve billing: a contract tier or a granted trial, with optional
 * overrides of the plan's limits (TenantEntitlement).
 *
 * This is the pure half, like lib/plans.ts: validation and arithmetic only, no
 * server imports, so a client form can reuse the same schema the server
 * checks. The database reads are in lib/billing.ts (loadTenantPlan), which is
 * where every quota already looks the workspace's plan up.
 *
 * An override is a non-negative whole number or "unlimited". It replaces the
 * plan's number for that one limit and nothing else; a limit left out stays
 * the plan's own. Overrides stop applying the moment `validUntil` passes.
 */
import { z } from "zod";
import { planForTier, TIER_LEVEL, type Plan, type PlanFeatures, type Tier } from "@/lib/plans";

export const ENTITLEMENT_SOURCES = ["contract", "trial"] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

const Limit = z.union([z.number().int().min(0).max(1_000_000_000_000), z.literal("unlimited")]);

/** Every limit an operator can override, with a label for the console. */
export const LIMIT_FIELDS = [
  { key: "reports", label: "Reports", unit: "count" },
  { key: "dashboards", label: "Dashboards", unit: "count" },
  { key: "apps", label: "Analytic Apps", unit: "count" },
  { key: "watchersMax", label: "Watchers", unit: "count" },
  { key: "masterBuildsPerMonth", label: "Master Builder builds / month", unit: "count" },
  { key: "agentBriefsMax", label: "Scheduled agent briefs", unit: "count" },
  { key: "seatlessPeople", label: "People without a seat", unit: "count" },
  { key: "lineMessages", label: "LINE messages / month", unit: "count" },
  { key: "shareLinksMax", label: "Live share links", unit: "count" },
  { key: "aiCredits", label: "AI credits / month (total)", unit: "credits" },
  { key: "lakeBytes", label: "Lake storage", unit: "bytes" },
  { key: "lakeTables", label: "Lake tables", unit: "count" },
  { key: "documentBytes", label: "Document storage", unit: "bytes" },
  { key: "documents", label: "Documents", unit: "count" },
] as const;
export type LimitKey = (typeof LIMIT_FIELDS)[number]["key"];

export const LimitOverridesSchema = z.object({
  reports: Limit.optional(),
  dashboards: Limit.optional(),
  apps: Limit.optional(),
  watchersMax: Limit.optional(),
  masterBuildsPerMonth: Limit.optional(),
  agentBriefsMax: Limit.optional(),
  seatlessPeople: Limit.optional(),
  lineMessages: Limit.optional(),
  shareLinksMax: Limit.optional(),
  /** The workspace's whole monthly allowance; replaces the plan's per-seat formula. */
  aiCredits: Limit.optional(),
  lakeBytes: Limit.optional(),
  lakeTables: Limit.optional(),
  documentBytes: Limit.optional(),
  documents: Limit.optional(),
}).strict();

export type LimitOverrides = z.infer<typeof LimitOverridesSchema>;

/** Overrides as stored: anything unreadable counts as none rather than failing a quota check. */
export function parseLimitOverrides(json: string | null | undefined): LimitOverrides {
  if (!json) return {};
  try {
    const r = LimitOverridesSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : {};
  } catch {
    return {};
  }
}

/** "unlimited" → Infinity, the way plans.ts spells it. */
export function limitValue(v: number | "unlimited"): number {
  return v === "unlimited" ? Infinity : v;
}

/** A lake/document cap as those modules store it: null = no cap. */
export function capValue(v: number | "unlimited" | undefined, planCap: number | null): number | null {
  if (v === undefined) return planCap;
  return v === "unlimited" ? null : v;
}

const FEATURE_KEYS = [
  "reports", "dashboards", "apps", "watchersMax", "masterBuildsPerMonth", "agentBriefsMax",
  "seatlessPeople", "lineMessages", "shareLinksMax",
] as const satisfies readonly (keyof PlanFeatures)[];

/** The plan with this workspace's overrides laid over it. The plan itself is not changed. */
export function applyLimitOverrides(plan: Plan, overrides: LimitOverrides): Plan {
  const features: PlanFeatures = { ...plan.features, aiCredits: { ...plan.features.aiCredits } };
  for (const k of FEATURE_KEYS) {
    const v = overrides[k];
    if (v !== undefined) features[k] = limitValue(v);
  }
  if (overrides.aiCredits !== undefined) {
    features.aiCredits = { base: limitValue(overrides.aiCredits), perEditor: 0, perViewer: 0 };
  }
  return { ...plan, features };
}

/** Whether an entitlement still applies at `now` (no end date = it does). */
export function entitlementActive(e: { validUntil: Date | null } | null | undefined, now: Date = new Date()): boolean {
  return !!e && (!e.validUntil || e.validUntil.getTime() > now.getTime());
}

/**
 * The tier to store for a workspace once Stripe's subscription says
 * `stripeTier`, given any operator entitlement:
 *   - no entitlement, or one that has ended: Stripe decides, as before;
 *   - a contract: its tier stands — a subscription event never overwrites what
 *     was agreed (and a cancelled card subscription doesn't end a contract);
 *   - a trial: a real paid subscription wins and the trial is dropped; while
 *     the subscription is not paid (community), the trial's tier stands.
 */
export function tierWithEntitlement(
  stripeTier: Tier,
  e: { source: string; tier: string; validUntil: Date | null } | null | undefined,
  now: Date = new Date(),
): { tier: Tier; dropEntitlement: boolean } {
  if (!e || !entitlementActive(e, now) || !isTier(e.tier)) return { tier: stripeTier, dropEntitlement: false };
  if (e.source === "contract") return { tier: e.tier, dropEntitlement: false };
  if (stripeTier !== "community") return { tier: stripeTier, dropEntitlement: true };
  return { tier: e.tier, dropEntitlement: false };
}

export function isTier(v: unknown): v is Tier {
  return typeof v === "string" && v in TIER_LEVEL;
}

/** What an operator submits for a workspace's entitlement (the console form and the API share it). */
export const EntitlementInputSchema = z.object({
  source: z.enum(ENTITLEMENT_SOURCES),
  tier: z.enum(["community", "growth", "business", "enterprise"]),
  limits: LimitOverridesSchema.default({}),
  /** ISO date; omitted = no end. Must be in the future. */
  validUntil: z.string().datetime().nullable().optional(),
  reference: z.string().trim().max(200).nullable().optional(),
  reason: z.string().trim().min(5, "Say why — it goes in the audit trail.").max(500),
}).superRefine((v, ctx) => {
  if (v.validUntil && new Date(v.validUntil).getTime() <= Date.now()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["validUntil"], message: "The end date must be in the future." });
  }
  // A trial is a trial: it always ends.
  if (v.source === "trial" && !v.validUntil) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["validUntil"], message: "A trial needs an end date." });
  }
});
export type EntitlementInput = z.infer<typeof EntitlementInputSchema>;

/** Resolve the plan a tier names, then lay overrides over it. */
export function effectivePlan(tier: string | null | undefined, overrides: LimitOverrides): Plan {
  return applyLimitOverrides(planForTier(tier), overrides);
}
