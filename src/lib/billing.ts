import { NextResponse } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { CurfSessionUser } from "@/lib/auth";
import type { Tx } from "@/lib/rls";
import { EDITION } from "@/lib/ee/edition";
import {
  UPGRADE_URL, EDITOR_ROLES, PLANS, TIER_LEVEL, CURRENCIES, planForTier, tierAtLeast, aiCreditsPerMonth, priceEnvVar,
  type Tier, type SeatCounts, type Plan, type Currency, type Interval,
} from "@/lib/plans";
import { applyLimitOverrides, entitlementActive, parseLimitOverrides, type LimitOverrides } from "@/lib/entitlements";

/**
 * Billing on the server: Stripe price ids, tier reads from the database,
 * count quotas and AI-credit metering. The tiers, the plan catalog and the
 * price math live in lib/plans.ts, which has no server imports so client
 * components can use it; they are re-exported here so server code keeps a
 * single import. Client code must import lib/plans.ts, never this module —
 * this one pulls in lib/db and the Prisma client (db.clientBundle.test.ts).
 *
 * The `tier` lives on Tenant.tier (string) and is updated by the Stripe
 * webhook on subscription lifecycle events. The price id mapping lives in
 * env so a single binary can serve multiple Stripe accounts (test/prod).
 *
 * Feature checks happen via `requireTier(user, "growth")` in API routes -
 * returns null when the user passes, or a 402 NextResponse to short-circuit
 * the handler. UI surfaces use `tierAtLeast(user, "growth")` from
 * lib/plans.ts directly.
 */
export {
  UPGRADE_URL, TRIAL_DAYS, trialEligible, EDITOR_ROLES, PLANS, planForTier, tierAtLeast,
  billableSeats, monthlyPriceUsd, aiCreditsPerMonth, seatPrices, periodPrice, priceEnvVar, ANNUAL_MONTHS, THB_SEAT_PRICES, CURRENCIES,
} from "@/lib/plans";
export type { Tier, PlanFeatures, Plan, SeatCounts, Currency, Interval } from "@/lib/plans";

/** Either the singleton client or the `tx` withTenantContext() hands its callback. */
type Db = PrismaClient | Tx;

/** Count-based quotas are Cloud's free-tier ceilings; self-hosted Community has none. */
const COUNT_QUOTAS_APPLY = EDITION !== "community";

/** Stripe price ids for a tier's two seat kinds in a currency and billing interval (USD monthly unless asked), read from env at
 *  request time. Null when the plan isn't sold per seat there or either id is unset. */
export function priceIdsForTier(tier: Tier, opts: { currency?: Currency; interval?: Interval } = {}): { editor: string; viewer: string } | null {
  const plan = planForTier(tier);
  if (!plan.priceEnvVars) return null;
  const currency = opts.currency ?? "usd";
  const interval = opts.interval ?? "month";
  const editor = process.env[priceEnvVar(plan.priceEnvVars.editor, currency, interval)];
  const viewer = process.env[priceEnvVar(plan.priceEnvVars.viewer, currency, interval)];
  return editor && viewer ? { editor, viewer } : null;
}

export type PriceVariant = { tier: Tier; seat: "editor" | "viewer"; currency: Currency; interval: Interval };

/** What a Stripe price id is: which tier, seat kind, currency and interval — or null if it isn't one of ours. */
export function variantForPriceId(priceId: string): PriceVariant | null {
  for (const plan of PLANS) {
    for (const currency of CURRENCIES) {
      for (const interval of ["month", "year"] as const) {
        const ids = priceIdsForTier(plan.tier, { currency, interval });
        if (ids?.editor === priceId) return { tier: plan.tier, seat: "editor", currency, interval };
        if (ids?.viewer === priceId) return { tier: plan.tier, seat: "viewer", currency, interval };
      }
    }
  }
  return null;
}

/** The tier a Stripe price id belongs to (any currency or interval), or null if it isn't one of ours. */
export function tierForPriceId(priceId: string): Tier | null {
  return variantForPriceId(priceId)?.tier ?? null;
}

/** Editors and viewers in a workspace, by membership role. */
export async function countSeats(tenantId: string, db: Db = prisma): Promise<SeatCounts> {
  const rows = await db.membership.groupBy({ by: ["role"], where: { tenantId }, _count: { _all: true } });
  let editors = 0, viewers = 0;
  for (const r of rows) {
    if (EDITOR_ROLES.includes(r.role)) editors += r._count._all;
    else viewers += r._count._all;
  }
  return { editors, viewers };
}

// ---------------------------------------------------------------------------
// Tier checks
// ---------------------------------------------------------------------------

/**
 * Read the current tenant tier from the database. Use this in webhooks and
 * any path where the session-cached tier might be stale (right after a
 * subscription upgrade, for example).
 */
export async function loadTenantTier(tenantId: string, db: Db = prisma): Promise<Tier> {
  // Tolerate missing tier column pre-db-push: callers always degrade to community.
  try {
    const t = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { tier: true },
    });
    const tier = (t?.tier as Tier) ?? "community";
    return TIER_LEVEL[tier] != null ? tier : "community";
  } catch {
    return "community";
  }
}

export type TenantPlan = {
  tier: Tier;
  /** The tier's plan with this workspace's active limit overrides laid over it. */
  plan: Plan;
  /** The overrides that apply right now (empty once an entitlement has ended). */
  overrides: LimitOverrides;
  /** The operator-set entitlement, if any — including one that has ended. */
  entitlement: { source: string; validUntil: Date | null; reference: string | null } | null;
};

/**
 * The workspace's tier and the plan its quotas are checked against: the
 * tier's plan, with any limit overrides an operator set (TenantEntitlement,
 * lib/entitlements.ts) laid over it for as long as they last. Every quota
 * reads the plan through here, so an override reaches all of them at once.
 * Degrades to the Community plan on a read error, like loadTenantTier.
 */
export async function loadTenantPlan(tenantId: string, db: Db = prisma): Promise<TenantPlan> {
  try {
    const t = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { tier: true, entitlement: { select: { source: true, limitsJson: true, validUntil: true, reference: true } } },
    });
    const raw = (t?.tier as Tier) ?? "community";
    const tier = TIER_LEVEL[raw] != null ? raw : "community";
    const e = t?.entitlement ?? null;
    const overrides = entitlementActive(e) ? parseLimitOverrides(e!.limitsJson) : {};
    return {
      tier,
      plan: applyLimitOverrides(planForTier(tier), overrides),
      overrides,
      entitlement: e ? { source: e.source, validUntil: e.validUntil, reference: e.reference } : null,
    };
  } catch {
    return { tier: "community", plan: planForTier("community"), overrides: {}, entitlement: null };
  }
}

/**
 * API route helper. Returns null when the user's tenant is at `minTier` or
 * higher; otherwise a 402 Payment Required response that the handler should
 * return immediately.
 *
 *   const block = await requireTier(user, "growth");
 *   if (block) return block;
 *
 * The 402 body includes the upgrade URL so clients can route the user to
 * checkout without a second roundtrip.
 */
export async function requireTier(
  user: CurfSessionUser,
  minTier: Tier,
): Promise<NextResponse | null> {
  const current = await loadTenantTier(user.tenantId);
  if (tierAtLeast(current, minTier)) return null;
  return NextResponse.json(
    {
      error: "Upgrade required",
      currentTier: current,
      requiredTier: minTier,
      upgradeUrl: UPGRADE_URL,
    },
    { status: 402 },
  );
}

// ---------------------------------------------------------------------------
// Quota helpers (count-based limits, e.g. reports on the Community plan).
// They return null in the Community edition (COUNT_QUOTAS_APPLY above);
// feature tiers (featureGate) still apply there.
// ---------------------------------------------------------------------------

/**
 * Block a `reports.create` call when the tenant is at its plan's report cap.
 * Community = 5; Growth/Business = unlimited. Returns null when allowed.
 */
export async function requireReportQuota(user: CurfSessionUser, db: Db = prisma): Promise<NextResponse | null> {
  if (!COUNT_QUOTAS_APPLY) return null;
  const { tier, plan } = await loadTenantPlan(user.tenantId, db);
  if (!Number.isFinite(plan.features.reports)) return null;
  const count = await db.report.count({ where: { tenantId: user.tenantId } });
  if (count < plan.features.reports) return null;
  return NextResponse.json(
    {
      error: "Report quota reached for the " + plan.name + " plan (" + plan.features.reports + " max).",
      currentTier: tier,
      requiredTier: "growth",
      upgradeUrl: UPGRADE_URL,
    },
    { status: 402 },
  );
}

/**
 * Block a `dashboard.create` call when the tenant is at its plan's
 * dashboard cap. Community = 1, Growth = 10, Business = unlimited.
 */
export async function requireDashboardQuota(user: CurfSessionUser, db: Db = prisma): Promise<NextResponse | null> {
  if (!COUNT_QUOTAS_APPLY) return null;
  const { tier, plan } = await loadTenantPlan(user.tenantId, db);
  if (!Number.isFinite(plan.features.dashboards)) return null;
  const count = await db.dashboard.count({ where: { tenantId: user.tenantId } });
  if (count < plan.features.dashboards) return null;
  return NextResponse.json(
    {
      error: "Dashboard quota reached for the " + plan.name + " plan (" + plan.features.dashboards + " max).",
      currentTier: tier,
      requiredTier: tier === "community" ? "growth" : "business",
      upgradeUrl: UPGRADE_URL,
    },
    { status: 402 },
  );
}

/**
 * Block minting another public share link when the workspace has its plan's
 * number of live (unexpired) links: Community 3, Growth 50, Business and up
 * unlimited (plans.ts shareLinksMax). The limit was declared and shown on
 * the billing page, but nothing counted.
 */
export async function requireShareLinkQuota(user: CurfSessionUser, db: Db = prisma): Promise<NextResponse | null> {
  if (!COUNT_QUOTAS_APPLY) return null;
  const { tier, plan } = await loadTenantPlan(user.tenantId, db);
  if (!Number.isFinite(plan.features.shareLinksMax)) return null;
  const live = await db.publicShareToken.count({
    where: { tenantId: user.tenantId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
  });
  if (live < plan.features.shareLinksMax) return null;
  return NextResponse.json(
    {
      error: "Share link limit reached for the " + plan.name + " plan (" + plan.features.shareLinksMax + " live links). Revoke one, or upgrade.",
      currentTier: tier,
      requiredTier: tier === "community" ? "growth" : "business",
      upgradeUrl: UPGRADE_URL,
    },
    { status: 402 },
  );
}

/**
 * Block publishing another Analytic App when the tenant is at its cap.
 * Community = 0, Growth = 3, Business and Enterprise = unlimited.
 *
 * `apps.unlimited` in featureGate.ts described this quota in a comment but
 * nothing counted, so every tier could publish without limit. The flag and
 * this counter are the two layers CLAUDE.md asks for on a premium feature.
 */
export async function requireAppQuota(user: CurfSessionUser, db: Db = prisma): Promise<NextResponse | null> {
  const { tier, plan } = await loadTenantPlan(user.tenantId, db);
  if (!Number.isFinite(plan.features.apps)) return null;
  const count = await db.app.count({ where: { tenantId: user.tenantId } });
  if (count < plan.features.apps) return null;
  return NextResponse.json(
    {
      error: "App quota reached for the " + plan.name + " plan (" + plan.features.apps + " max).",
      currentTier: tier,
      requiredTier: tier === "community" ? "growth" : "business",
      upgradeUrl: UPGRADE_URL,
    },
    { status: 402 },
  );
}

// ---------------------------------------------------------------------------
// AI credits — the one AI quota. 1 credit = 1 cent of model cost at list
// price (LlmTokenUsage.microCostUsd / 10_000), pooled per workspace, reset
// on the first of each calendar month. Only calls made on Curf's own key
// count: lib/llm/index.ts skips the check when the workspace supplies its
// own key, and the Community edition never meters.
// ---------------------------------------------------------------------------

export const MICRO_USD_PER_CREDIT = 10_000;

export type AiCreditStatus = {
  tier: Tier;
  /** Monthly allowance for this workspace's plan and seats. Infinity = unmetered. */
  allowance: number;
  /** Credits spent since the first of the month, rounded up. */
  used: number;
  remaining: number;
  /** ISO date the allowance resets. */
  resetsAt: string;
};

export function monthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Month-to-date AI spend and allowance for a workspace. */
export async function aiCreditStatus(tenantId: string, db: Db = prisma): Promise<AiCreditStatus> {
  const { tier, plan } = await loadTenantPlan(tenantId, db);
  const since = monthStart();
  const next = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth() + 1, 1));
  const [seats, spent] = await Promise.all([
    countSeats(tenantId, db),
    db.llmTokenUsage.aggregate({
      _sum: { microCostUsd: true },
      // Only calls on Curf's key draw down credits.
      where: { tenantId, keySource: "platform", createdAt: { gte: since } },
    }),
  ]);
  const allowance = aiCreditsPerMonth(plan, seats);
  const used = Math.ceil((spent._sum.microCostUsd ?? 0) / MICRO_USD_PER_CREDIT);
  return { tier, allowance, used, remaining: Math.max(0, allowance - used), resetsAt: next.toISOString() };
}

/**
 * Whether the workspace may make another call on Curf's key. Null when it
 * may; otherwise the 402 body an API route should return. Deliberately no
 * try/catch: this guards a real model-cost call, and treating an
 * unverifiable count as "0 used" would uncap the allowance on exactly the
 * kind of DB error that should stop it.
 */
export async function requireAiCredits(tenantId: string, db: Db = prisma): Promise<NextResponse | null> {
  if (!COUNT_QUOTAS_APPLY) return null;
  const status = await aiCreditStatus(tenantId, db);
  if (!Number.isFinite(status.allowance) || status.used < status.allowance) return null;
  const plan = planForTier(status.tier);
  return NextResponse.json(
    {
      error: `AI credits for this month are used up (${status.allowance} on the ${plan.name} plan). They reset on ${status.resetsAt.slice(0, 10)}.`,
      code: "ai_credits_exhausted",
      currentTier: status.tier,
      requiredTier: status.tier === "community" ? "growth" : "business",
      upgradeUrl: UPGRADE_URL,
      credits: status,
    },
    { status: 402 },
  );
}

/**
 * Block starting another Master Builder build when the workspace has started its plan's number this month
 * (Community 2, paid plans unlimited — plans.ts masterBuildsPerMonth). A build costs far more model time than any
 * other single action, so the free tier gets a few, not a credit-sized trickle. Drafts (an imported template not yet
 * applied) and failed builds do not count; iterating on an existing build is not a new build.
 */
export async function requireMasterBuildQuota(tenantId: string, db: Db = prisma): Promise<NextResponse | null> {
  if (!COUNT_QUOTAS_APPLY) return null;
  const { tier, plan } = await loadTenantPlan(tenantId, db);
  const cap = plan.features.masterBuildsPerMonth;
  if (!Number.isFinite(cap)) return null;
  const since = monthStart();
  const started = await (db as any).masterBuild.count({
    where: { tenantId, startedAt: { gte: since }, status: { notIn: ["draft", "failed"] } },
  });
  if (started < cap) return null;
  const resetsAt = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth() + 1, 1)).toISOString();
  return NextResponse.json(
    {
      error: `The ${plan.name} plan includes ${cap} Master Builder builds a month and this workspace has started them. The count resets on ${resetsAt.slice(0, 10)}; changes to an existing build are not limited.`,
      code: "master_build_quota",
      currentTier: tier,
      requiredTier: "growth",
      limit: cap,
      used: started,
      resetsAt,
      upgradeUrl: UPGRADE_URL,
    },
    { status: 402 },
  );
}

/**
 * Scheduled agent briefs: the plan's cap and how many this workspace has (lib/briefs/). The caller decides what to
 * say; creating one is allowed while `used < cap`. Always the real numbers, so the page can say "2 of 3".
 */
export async function agentBriefAllowance(tenantId: string, db: Db = prisma): Promise<{ tier: Tier; cap: number; used: number }> {
  const { tier, plan } = await loadTenantPlan(tenantId, db);
  const cap = plan.features.agentBriefsMax;
  const used = await (db as any).agentBrief.count({ where: { tenantId } });
  return { tier, cap: COUNT_QUOTAS_APPLY ? cap : Infinity, used };
}

/**
 * Block a `watcher.create` call when the tenant is at its plan's watcher
 * cap. Community = 0 (watchers fully gated), Growth = 10, Business = unlimited.
 */
export async function requireWatcherQuota(user: CurfSessionUser, db: Db = prisma): Promise<NextResponse | null> {
  const { tier, plan } = await loadTenantPlan(user.tenantId, db);
  if (plan.features.watchersMax === 0) {
    // Watcher feature itself is gated, not a quota — emit a clearer message.
    return NextResponse.json(
      {
        error: "Watchers require the Growth plan or higher.",
        currentTier: tier,
        requiredTier: "growth",
        upgradeUrl: UPGRADE_URL,
      },
      { status: 402 },
    );
  }
  if (!Number.isFinite(plan.features.watchersMax)) return null;
  // Watchers live in the Schedule table with kind="watcher". Count active ones.
  const count = await db.schedule.count({
    where: { tenantId: user.tenantId, kind: "watcher", enabled: true },
  });
  if (count < plan.features.watchersMax) return null;
  return NextResponse.json(
    {
      error: "Watcher quota reached for the " + plan.name + " plan (" + plan.features.watchersMax + " max).",
      currentTier: tier,
      requiredTier: "business",
      upgradeUrl: UPGRADE_URL,
    },
    { status: 402 },
  );
}

// ---------------------------------------------------------------------------
// Quota race-condition guard (OWASP A06:2025 — Insecure Design).
//
// requireReportQuota/requireDashboardQuota/requireWatcherQuota above count
// existing rows, then the caller creates one more — as two separate,
// unsynchronized statements. Concurrent requests can each see the count
// from before any of them landed and all pass the check, letting a tenant
// end up over its plan's cap. Verified empirically against a real Postgres
// instance: 5 concurrent requests racing a limit of 1 all read count=0 and
// all proceeded under the old two-step shape.
//
// Fix: callers pass the quota helper the SAME `tx` they use for the actual
// create. Routes that already use lib/rls.ts's withTenantContext() get this
// for free via its isolationLevel/maxRetries options; routes that don't
// (dashboards, watchers — no RLS wrapper today) use withSerializableRetry()
// below, which does the identical transaction+retry without the RLS GUCs.
// QuotaBlockedError is the sentinel a route throws from inside that
// callback to abort the transaction (nothing gets written) and surface the
// 402 to the caller.
// ---------------------------------------------------------------------------

/** Thrown inside a quota transaction callback to abort it and surface `response` to the caller. */
export class QuotaBlockedError extends Error {
  constructor(public response: NextResponse) {
    super("quota blocked");
  }
}

/**
 * Run `fn` inside a SERIALIZABLE transaction, retrying on a Postgres write
 * conflict (Prisma error code P2034) instead of surfacing it as a hard
 * failure. For routes that don't go through withTenantContext() — that
 * helper has the same retry built in for routes that do.
 */
export async function withSerializableRetry<T>(
  fn: (tx: Tx) => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await prisma.$transaction(fn, { isolationLevel: "Serializable" });
    } catch (e: any) {
      if (e?.code === "P2034" && attempt < maxRetries) continue;
      throw e;
    }
  }
  throw new Error("withSerializableRetry: exhausted retries without resolving");
}
