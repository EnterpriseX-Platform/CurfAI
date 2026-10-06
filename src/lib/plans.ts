import { EDITION } from "@/lib/ee/edition";

/**
 * Subscription tiers and the plan catalog — the pure half of billing.
 *
 * Four plans (marketing-aligned slugs), priced per seat with two seat
 * kinds — editors (admin, developer) build; viewers (executive, viewer)
 * read — plus a pooled monthly AI-credit allowance (1 credit = 1 cent of
 * model cost at list price, metered in lib/llm/index.ts):
 *   community  - free. 5 reports, 1 dashboard, 100 AI credits.
 *   growth     - $49 / editor, $9 / viewer (first 10 free). 500 credits per
 *                editor + 50 per viewer, pooled.
 *   business   - $99 / editor (minimum 5), $15 / viewer. 2,000 credits per
 *                editor + 100 per viewer; unmetered with the workspace's
 *                own key (gov.tenant_anthropic_key).
 *   enterprise - dedicated single-tenant infra + custom retention/SLA.
 *
 * Client components import from here. This module must never import
 * server code: whatever a "use client" file imports ships to the browser,
 * and lib/billing.ts (which re-exports all of this for the server) pulls in
 * lib/db and the Prisma client. db.clientBundle.test.ts fails the build if
 * a client module reaches lib/db again.
 *
 * Adding a new tier is a 4-step change:
 *   1. Add the slug to Tier below.
 *   2. Add a TIER_LEVEL entry.
 *   3. Add a row to PLANS with seats, credits + features.
 *   4. Add the two price ids to env (STRIPE_PRICE_<TIER>_EDITOR / _VIEWER).
 */

/** Where a 402 sends the user: in-app billing on Cloud, the pricing page for Community. */
export const UPGRADE_URL = EDITION === "community" ? "https://curf.ai/pricing/" : "/admin/billing";

/**
 * Self-serve paid plans start with a free trial of this many days. It is
 * granted once per workspace — at checkout, only when the tenant has never
 * held a Stripe subscription — so cancelling and re-subscribing does not
 * restart the clock. Stripe reports the subscription as `trialing` until
 * the trial ends, and tierFromSubscription() treats that like `active`.
 * curf.ai's pricing page and Terms §3 quote this number; keep them in step.
 */
export const TRIAL_DAYS = 14;

/** Whether a workspace still qualifies for the free trial at checkout. */
export function trialEligible(tenant: { stripeSubscriptionId: string | null; stripeStatus: string | null }): boolean {
  return !tenant.stripeSubscriptionId && !tenant.stripeStatus;
}

export type Tier = "community" | "growth" | "business" | "enterprise";

export const TIER_LEVEL: Record<Tier, number> = { community: 0, growth: 1, business: 2, enterprise: 3 };

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
  /** Monthly AI allowance on Curf's own key, in credits (1 credit = 1 cent
   *  of model cost at list price), pooled per workspace: base + per seat.
   *  Enforced in lib/llm/index.ts against LlmTokenUsage; a workspace on
   *  its own key is not metered. Infinity = unmetered. */
  aiCredits: { base: number; perEditor: number; perViewer: number };
  /** People who receive assignments without a Curf seat (executive journey
   *  P3) — free up to this many per workspace (CEO decision 2026-09-24);
   *  beyond it they need a viewer seat. Infinity = unlimited. */
  seatlessPeople: number;
  /** Messages a month pushed through Curf's shared LINE Official Account
   *  (executive journey P4; CEO 2026-09-24: metered like AI credits).
   *  Over the allowance, notifications fall back to email — work never
   *  stops. Counted from LineMessageLog. Infinity = unmetered. */
  lineMessages: number;
  /** Hard cap on active (non-revoked, non-expired) public share tokens.
   *  Community is small to discourage redistribution; Growth and Business are open. */
  shareLinksMax: number;
  /** Days of audit log retention exposed to the admin UI. The DB keeps
   *  rows beyond this — operational policy decides whether to prune. */
  auditLogRetentionDays: number;
  // ---- Boolean feature toggles (legacy column — keep until callers move
  // to lib/featureTiers.ts which is the new single source of truth). ----
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
  /** Seat pricing. Null for plans that aren't sold per seat (community, enterprise). */
  seats: {
    editorUsd: number;
    viewerUsd: number;
    /** Viewers included before the per-viewer price applies. */
    freeViewers: number;
    /** Billed editor seats never drop below this — the plan's floor. */
    minEditors: number;
  } | null;
  /** Env var names holding the Stripe price ids for each seat kind. */
  priceEnvVars: { editor: string; viewer: string } | null;
  features: PlanFeatures;
};

/** Which membership roles are billed as editors; every other role is a viewer. */
export const EDITOR_ROLES: readonly string[] = ["admin", "developer"];

export const PLANS: Plan[] = [
  {
    tier: "community",
    name: "Community",
    tagline: "Try the designer, ship 5 reports, schedule them by email.",
    seats: null,
    priceEnvVars: null,
    features: {
      reports: 5,
      dashboards: 1,
      apps: 0,
      watchersMax: 0,
      aiCredits: { base: 100, perEditor: 0, perViewer: 0 },
      seatlessPeople: 0,
      lineMessages: 0,
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
    seats: { editorUsd: 49, viewerUsd: 9, freeViewers: 10, minEditors: 1 },
    priceEnvVars: { editor: "STRIPE_PRICE_GROWTH_EDITOR", viewer: "STRIPE_PRICE_GROWTH_VIEWER" },
    features: {
      reports: 50,
      dashboards: 10,
      apps: 3,
      watchersMax: 10,
      aiCredits: { base: 0, perEditor: 500, perViewer: 50 },
      seatlessPeople: 25,
      lineMessages: 0,
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
    seats: { editorUsd: 99, viewerUsd: 15, freeViewers: 0, minEditors: 5 },
    priceEnvVars: { editor: "STRIPE_PRICE_BUSINESS_EDITOR", viewer: "STRIPE_PRICE_BUSINESS_VIEWER" },
    features: {
      reports: Infinity,
      dashboards: Infinity,
      apps: Infinity,
      watchersMax: Infinity,
      aiCredits: { base: 0, perEditor: 2000, perViewer: 100 },
      seatlessPeople: 100,
      lineMessages: 2000,
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
    // No self-serve Stripe price — enterprise is sold + provisioned manually.
    seats: null,
    priceEnvVars: null,
    features: {
      reports: Infinity,
      dashboards: Infinity,
      apps: Infinity,
      watchersMax: Infinity,
      aiCredits: { base: Infinity, perEditor: 0, perViewer: 0 },
      seatlessPeople: Infinity,
      lineMessages: 10000,
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

/**
 * Cheap synchronous check against the tier baked into the session. The
 * session reflects the tenant.tier as of last login - good enough for UI
 * gating and most API checks. Use billing's `loadTenantTier` if you need a
 * fresh read from the DB (e.g. inside a webhook handler).
 */
export function tierAtLeast(currentTier: string | null | undefined, minTier: Tier): boolean {
  const current = TIER_LEVEL[(currentTier as Tier) ?? "community"] ?? 0;
  const min = TIER_LEVEL[minTier] ?? 0;
  return current >= min;
}

// ---------------------------------------------------------------------------
// Seat and price math
// ---------------------------------------------------------------------------

export type SeatCounts = { editors: number; viewers: number };

/** What Stripe bills for these seats on this plan: the editor floor
 *  applies, and the plan's free viewers come off the viewer count. */
export function billableSeats(plan: Plan, seats: SeatCounts): SeatCounts {
  if (!plan.seats) return { editors: 0, viewers: 0 };
  return {
    editors: Math.max(seats.editors, plan.seats.minEditors),
    viewers: Math.max(0, seats.viewers - plan.seats.freeViewers),
  };
}

/** Monthly list price for these seats on this plan, in USD. */
export function monthlyPriceUsd(plan: Plan, seats: SeatCounts): number {
  if (!plan.seats) return 0;
  const b = billableSeats(plan, seats);
  return b.editors * plan.seats.editorUsd + b.viewers * plan.seats.viewerUsd;
}

/** The workspace's pooled monthly AI-credit allowance on this plan. */
export function aiCreditsPerMonth(plan: Plan, seats: SeatCounts): number {
  const c = plan.features.aiCredits;
  return c.base + c.perEditor * seats.editors + c.perViewer * seats.viewers;
}
