import { NextResponse } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { CurfSessionUser } from "@/lib/auth";
import type { Tx } from "@/lib/rls";
import { EDITION } from "@/lib/ee/edition";

/** Either the singleton client or the `tx` withTenantContext() hands its callback. */
type Db = PrismaClient | Tx;

/** Where a 402 sends the user: in-app billing on Cloud, the pricing page for Community. */
export const UPGRADE_URL = EDITION === "community" ? "https://curf.ai/pricing/" : "/admin/billing";
/** Count-based quotas are Cloud's free-tier ceilings; self-hosted Community has none. */
const COUNT_QUOTAS_APPLY = EDITION !== "community";

/**
 * Subscription tiers, feature gates, and the Stripe price catalog.
 *
 * Four plans (marketing-aligned slugs):
 *   community  - explore-mode. 1 workspace, 5 reports, no schedules, no API keys.
 *   growth     - $29/mo. Unlimited reports + schedules. Comments, share links, embeds.
 *   business   - $99/mo. Everything in Growth + watchers, API keys, SSO, audit log.
 *   enterprise - dedicated single-tenant infra + custom retention/SLA.
 *
 * The `tier` lives on Tenant.tier (string) and is updated by the Stripe
 * webhook on subscription lifecycle events. The price id mapping lives in
 * env so a single binary can serve multiple Stripe accounts (test/prod).
 *
 * Feature checks happen via `requireTier(user, "growth")` in API routes -
 * returns null when the user passes, or a 402 NextResponse to short-circuit
 * the handler. UI surfaces use `tierAtLeast(user, "growth")` directly.
 *
 * Adding a new tier or feature flag is a 4-step change:
 *   1. Add the slug to Tier below.
 *   2. Add a TIER_LEVEL entry.
 *   3. Add a row to PLANS with price + features.
 *   4. Add the price id to env (STRIPE_PRICE_TEAM, STRIPE_PRICE_BUSINESS, ...).
 *      Note: env-var names retain the historical TEAM suffix for deployment
 *      backward-compat — only the internal tier string changed (team→growth).
 */

export type Tier = "community" | "growth" | "business" | "enterprise";

const TIER_LEVEL: Record<Tier, number> = { community: 0, growth: 1, business: 2, enterprise: 3 };

export type PlanFeatures = {
  /** Hard cap on reports per tenant. Infinity = unlimited. */
  reports: number;
  /** Hard cap on dashboards per tenant. Infinity = unlimited. */
  dashboards: number;
  /** Hard cap on published Analytic Apps per tenant. Infinity = unlimited.
   *  Community is 0 because apps.publish already starts at Growth — the
   *  number keeps the two consistent rather than relying on the flag alone. */
  apps: number;
  /** Hard cap on watcher schedules per tenant. 0 = watchers disabled. */
  watchersMax: number;
  /** Hard cap on /api/reports/generate calls per tenant per rolling 30 days.
   *  Each Generate call costs Anthropic dollars, so this is the most cost-
   *  sensitive quota in the matrix. Infinity = unlimited. */
  generateCallsPerMonth: number;
  /** Hard cap on active (non-revoked, non-expired) public share tokens.
   *  Community is small to discourage redistribution; Growth and Business are open. */
  shareLinksMax: number;
  /** Days of audit log retention exposed to the admin UI. The DB keeps
   *  rows beyond this — operational policy decides whether to prune. */
  auditLogRetentionDays: number;
  // ---- Boolean feature toggles (legacy column — keep until callers move
  // to lib/featureGate.ts which is the new single source of truth). ----
  schedules: number;
  watchers: boolean;
  apiKeys: boolean;
  sso: boolean;
  auditLog: boolean;
  shareLinks: boolean;
  embed: boolean;
  comments: boolean;
};

export type Plan = {
  tier: Tier;
  name: string;
  tagline: string;
  priceMonthlyUsd: number;
  /** Stripe price id env var name. Set the actual price id in deployment env. */
  priceEnvVar: string | null;
  features: PlanFeatures;
};

export const PLANS: Plan[] = [
  {
    tier: "community",
    name: "Community",
    tagline: "Try the designer, ship 5 reports, schedule them by email.",
    priceMonthlyUsd: 0,
    priceEnvVar: null,
    features: {
      reports: 5,
      dashboards: 1,
      apps: 0,
      watchersMax: 0,
      generateCallsPerMonth: 10,
      shareLinksMax: 3,
      auditLogRetentionDays: 7,
      schedules: Infinity,
      watchers: false,
      apiKeys: false,
      sso: false,
      auditLog: false,
      shareLinks: true,
      embed: false,
      comments: true,
    },
  },
  {
    tier: "growth",
    name: "Growth",
    tagline: "Unlimited reports, the trust layer, Analytic Apps.",
    priceMonthlyUsd: 29,
    priceEnvVar: "STRIPE_PRICE_TEAM",
    features: {
      reports: 50,
      dashboards: 10,
      apps: 3,
      watchersMax: 10,
      generateCallsPerMonth: 100,
      shareLinksMax: 50,
      auditLogRetentionDays: 30,
      schedules: Infinity,
      watchers: true,
      apiKeys: true,
      sso: true,
      auditLog: false,
      shareLinks: true,
      embed: true,
      comments: true,
    },
  },
  {
    tier: "business",
    name: "Business",
    tagline: "Everything in Growth + AI captions, watchers, audit log, custom OIDC.",
    priceMonthlyUsd: 99,
    priceEnvVar: "STRIPE_PRICE_BUSINESS",
    features: {
      reports: Infinity,
      dashboards: Infinity,
      apps: Infinity,
      watchersMax: Infinity,
      generateCallsPerMonth: Infinity,
      shareLinksMax: Infinity,
      auditLogRetentionDays: 365,
      schedules: Infinity,
      watchers: true,
      apiKeys: true,
      sso: true,
      auditLog: true,
      shareLinks: true,
      embed: true,
      comments: true,
    },
  },
  {
    tier: "enterprise",
    name: "Enterprise",
    tagline: "Everything in Business + dedicated single-tenant infra, custom retention/SLA.",
    priceMonthlyUsd: 0,
    // No self-serve Stripe price — enterprise is sold + provisioned manually.
    priceEnvVar: null,
    features: {
      reports: Infinity,
      dashboards: Infinity,
      apps: Infinity,
      watchersMax: Infinity,
      generateCallsPerMonth: Infinity,
      shareLinksMax: Infinity,
      auditLogRetentionDays: Infinity,
      schedules: Infinity,
      watchers: true,
      apiKeys: true,
      sso: true,
      auditLog: true,
      shareLinks: true,
      embed: true,
      comments: true,
    },
  },
];

const PLAN_BY_TIER: Record<Tier, Plan> = Object.fromEntries(
  PLANS.map((p) => [p.tier, p]),
) as Record<Tier, Plan>;

/** Look up a plan by tier slug. Falls back to "community" if unknown. */
export function planForTier(tier: string | null | undefined): Plan {
  return PLAN_BY_TIER[(tier as Tier) ?? "community"] ?? PLAN_BY_TIER.community;
}

/** Stripe price id for `tier`, read from env at request time. Empty when unset. */
export function priceIdForTier(tier: Tier): string | null {
  const plan = PLAN_BY_TIER[tier];
  if (!plan?.priceEnvVar) return null;
  return process.env[plan.priceEnvVar] ?? null;
}

// ---------------------------------------------------------------------------
// Tier checks
// ---------------------------------------------------------------------------

/**
 * Cheap synchronous check against the tier baked into the session. The
 * session reflects the tenant.tier as of last login - good enough for UI
 * gating and most API checks. Use `loadTenantTier` if you need a fresh
 * read from the DB (e.g. inside a webhook handler).
 */
export function tierAtLeast(currentTier: string | null | undefined, minTier: Tier): boolean {
  const current = TIER_LEVEL[(currentTier as Tier) ?? "community"] ?? 0;
  const min = TIER_LEVEL[minTier] ?? 0;
  return current >= min;
}

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
  const tier = await loadTenantTier(user.tenantId, db);
  const plan = planForTier(tier);
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
  const tier = await loadTenantTier(user.tenantId, db);
  const plan = planForTier(tier);
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
 * Block publishing another Analytic App when the tenant is at its cap.
 * Community = 0, Growth = 3, Business and Enterprise = unlimited.
 *
 * `apps.unlimited` in featureGate.ts described this quota in a comment but
 * nothing counted, so every tier could publish without limit. The flag and
 * this counter are the two layers CLAUDE.md asks for on a premium feature.
 */
export async function requireAppQuota(user: CurfSessionUser, db: Db = prisma): Promise<NextResponse | null> {
  const tier = await loadTenantTier(user.tenantId, db);
  const plan = planForTier(tier);
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

/**
 * Block an `/api/reports/generate` call when the tenant is past its
 * monthly Generate quota. Community = 10/mo, Growth = 100/mo, Business = unlimited.
 *
 * "Month" here is a rolling 30-day window, computed from AuditEvent rows
 * with kind="report.generate". This is approximate (audit gaps could
 * undercount) but cheap — no extra usage table needed.
 */
export async function requireGenerateQuota(user: CurfSessionUser): Promise<NextResponse | null> {
  if (!COUNT_QUOTAS_APPLY) return null;
  const tier = await loadTenantTier(user.tenantId);
  const plan = planForTier(tier);
  if (!Number.isFinite(plan.features.generateCallsPerMonth)) return null;
  const since = new Date(Date.now() - 30 * 24 * 3600_000);
  // Deliberately no try/catch — requireReportQuota/requireDashboardQuota/
  // requireWatcherQuota above don't swallow their count() errors either,
  // and this one guards a real LLM-cost call. AuditEvent has existed since
  // the original baseline schema and the k8s initContainer runs
  // `prisma db push` before the app container ever starts, so a query
  // failure here means a real (transient) DB problem, not a missing
  // table — and defaulting an unverifiable count to "0 used, allow" would
  // silently uncap the quota on exactly that kind of error.
  const count = await prisma.auditEvent.count({
    where: {
      tenantId: user.tenantId,
      kind: "report.generate",
      createdAt: { gte: since },
    },
  });
  if (count < plan.features.generateCallsPerMonth) return null;
  return NextResponse.json(
    {
      error: "AI Generate quota reached for the " + plan.name + " plan (" + plan.features.generateCallsPerMonth + " calls / 30 days).",
      currentTier: tier,
      requiredTier: tier === "community" ? "growth" : "business",
      upgradeUrl: UPGRADE_URL,
    },
    { status: 402 },
  );
}

/**
 * Block a `watcher.create` call when the tenant is at its plan's watcher
 * cap. Community = 0 (watchers fully gated), Growth = 10, Business = unlimited.
 */
export async function requireWatcherQuota(user: CurfSessionUser, db: Db = prisma): Promise<NextResponse | null> {
  const tier = await loadTenantTier(user.tenantId, db);
  const plan = planForTier(tier);
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
