/**
 * An operator's limit overrides reach the quota checks (lib/entitlements.ts, TenantEntitlement), for as long as they last,
 * against a db double like the other billing tests.
 */
import { describe, expect, it } from "vitest";
import { loadTenantPlan, requireReportQuota, requireWatcherQuota, aiCreditStatus, agentBriefAllowance } from "./billing";
import { EDITION } from "./ee/edition";

const user = { id: "u1", tenantId: "t1", role: "admin" } as any;
const quotas = EDITION !== "community";
const future = new Date(Date.now() + 86_400_000 * 30);
const past = new Date(Date.now() - 60_000);

type Row = { tier: string; entitlement?: { source: string; limitsJson: string; validUntil: Date | null; reference?: string | null } | null };
function fakeDb(row: Row, counts: { reports?: number; watchers?: number; briefs?: number } = {}) {
  return {
    tenant: { findUnique: async () => ({ reference: null, ...row }) },
    report: { count: async () => counts.reports ?? 0 },
    schedule: { count: async () => counts.watchers ?? 0 },
    agentBrief: { count: async () => counts.briefs ?? 0 },
    membership: { groupBy: async () => [{ role: "admin", _count: { _all: 2 } }, { role: "viewer", _count: { _all: 10 } }] },
    llmTokenUsage: { aggregate: async () => ({ _sum: { microCostUsd: 0 } }) },
  } as any;
}

describe("loadTenantPlan", () => {
  it("is the tier's plan when the workspace has no entitlement", async () => {
    const r = await loadTenantPlan("t1", fakeDb({ tier: "growth" }));
    expect(r.tier).toBe("growth");
    expect(r.plan.features.reports).toBe(50);
    expect(r.overrides).toEqual({});
    expect(r.entitlement).toBeNull();
  });

  it("lays an active entitlement's overrides over the plan", async () => {
    const r = await loadTenantPlan("t1", fakeDb({ tier: "growth", entitlement: { source: "contract", limitsJson: '{"reports":500,"apps":"unlimited"}', validUntil: future } }));
    expect(r.plan.features.reports).toBe(500);
    expect(r.plan.features.apps).toBe(Infinity);
    expect(r.plan.features.dashboards).toBe(10); // untouched
    expect(r.entitlement?.source).toBe("contract");
  });

  it("stops applying them the moment the end date passes, though the row is still there until the sweep", async () => {
    const r = await loadTenantPlan("t1", fakeDb({ tier: "growth", entitlement: { source: "trial", limitsJson: '{"reports":500}', validUntil: past } }));
    expect(r.plan.features.reports).toBe(50);
    expect(r.overrides).toEqual({});
    expect(r.entitlement).not.toBeNull(); // reported, so a page can say "ended"
  });

  it("degrades to the Community plan when the database can't be read", async () => {
    const broken = { tenant: { findUnique: async () => { throw new Error("db down"); } } } as any;
    const r = await loadTenantPlan("t1", broken);
    expect(r.tier).toBe("community");
    expect(r.plan.features.reports).toBe(5);
  });

  it("an unreadable override is no override", async () => {
    const r = await loadTenantPlan("t1", fakeDb({ tier: "growth", entitlement: { source: "contract", limitsJson: "garbage", validUntil: null } }));
    expect(r.plan.features.reports).toBe(50);
  });
});

describe("quotas read the overridden plan", () => {
  it("a workspace over its plan's report cap is allowed up to the override", async () => {
    const withOverride = fakeDb({ tier: "community", entitlement: { source: "contract", limitsJson: '{"reports":100}', validUntil: null } }, { reports: 5 });
    expect(await requireReportQuota(user, withOverride)).toBeNull();
    const without = await requireReportQuota(user, fakeDb({ tier: "community" }, { reports: 5 }));
    if (!quotas) return expect(without).toBeNull();
    expect(without?.status).toBe(402);
  });

  it("an override can also lower a limit below the plan's", async () => {
    const res = await requireReportQuota(user, fakeDb({ tier: "growth", entitlement: { source: "contract", limitsJson: '{"reports":10}', validUntil: null } }, { reports: 10 }));
    if (!quotas) return expect(res).toBeNull();
    expect(res?.status).toBe(402);
  });

  it("'unlimited' lifts the cap entirely", async () => {
    const db = fakeDb({ tier: "community", entitlement: { source: "contract", limitsJson: '{"reports":"unlimited"}', validUntil: null } }, { reports: 10_000 });
    expect(await requireReportQuota(user, db)).toBeNull();
  });

  it("watchers: an override gives a Community workspace some, and 0 still means none", async () => {
    const some = fakeDb({ tier: "community", entitlement: { source: "trial", limitsJson: '{"watchersMax":3}', validUntil: future } }, { watchers: 1 });
    expect(await requireWatcherQuota(user, some)).toBeNull();
    const none = await requireWatcherQuota(user, fakeDb({ tier: "community" }));
    expect(none?.status).toBe(402);
  });

  it("agent briefs: the cap the page shows is the override", async () => {
    const r = await agentBriefAllowance("t1", fakeDb({ tier: "growth", entitlement: { source: "contract", limitsJson: '{"agentBriefsMax":50}', validUntil: null } }, { briefs: 4 }));
    expect(r).toMatchObject({ tier: "growth", used: 4, cap: quotas ? 50 : Infinity });
  });

  it("AI credits: an override replaces the whole monthly allowance, whatever the seats", async () => {
    const s = await aiCreditStatus("t1", fakeDb({ tier: "growth", entitlement: { source: "contract", limitsJson: '{"aiCredits":20000}', validUntil: null } }));
    expect(s.allowance).toBe(20_000);
    const base = await aiCreditStatus("t1", fakeDb({ tier: "growth" }));
    expect(base.allowance).toBe(2 * 500 + 10 * 50); // 2 editors, 10 viewers on the plan's own formula
    const unlimited = await aiCreditStatus("t1", fakeDb({ tier: "growth", entitlement: { source: "contract", limitsJson: '{"aiCredits":"unlimited"}', validUntil: null } }));
    expect(unlimited.allowance).toBe(Infinity);
  });
});
