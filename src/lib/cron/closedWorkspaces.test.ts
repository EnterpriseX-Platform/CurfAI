/**
 * A closed workspace (Tenant.status "suspended" or "pending_deletion", lib/tenantStatus.ts) is left out of the cron ticks
 * that start work: pulls, materialized views, the AI-spend threshold and the security alerts. Each test applies the
 * `where` the tick sends to Prisma to an in-memory table, so it proves both that the filter is there and that it lets the
 * open workspace's row through and keeps the closed one's out. Backups are the exception: a suspended workspace is still
 * backed up; one waiting to be purged is not.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  status: {} as Record<string, string>,
  pulls: [] as any[],
  views: [] as any[],
  tenants: [] as any[],
  usage: [] as any[],
  signins: [] as any[],
  wheres: {} as Record<string, any>,
  tenantUpdates: [] as any[],
  webhooks: [] as any[],
  emails: [] as any[],
  alerts: [] as any[],
}));
const statusOf = (id: string) => h.status[id] ?? "active";
/** The two filters the ticks use: a relation to Tenant, and a plain tenantId. */
const applyTenantFilter = (rows: any[], where: any) =>
  rows.filter((r) => {
    if (where?.tenant?.status && statusOf(r.tenantId) !== where.tenant.status) return false;
    if (where?.tenantId?.notIn?.includes(r.tenantId)) return false;
    return true;
  });

vi.mock("@/lib/db", () => ({
  prisma: {
    lakePull: { findMany: vi.fn(async ({ where }: any) => { h.wheres.lakePull = where; return applyTenantFilter(h.pulls, where); }) },
    materializedView: { findMany: vi.fn(async ({ where }: any) => { h.wheres.materializedView = where; return applyTenantFilter(h.views, where); }) },
    jobRun: { create: vi.fn(async () => ({ id: "jr" })), update: vi.fn(async () => ({})) },
    tenant: {
      findMany: vi.fn(async ({ where }: any) => {
        h.wheres.tenant = where;
        return h.tenants.filter((t) => {
          if (where?.status === "active") return statusOf(t.id) === "active";
          if (where?.status?.not) return statusOf(t.id) !== where.status.not;
          return true;
        });
      }),
      update: vi.fn(async (a: any) => { h.tenantUpdates.push(a); return {}; }),
    },
    llmTokenUsage: { groupBy: vi.fn(async () => h.usage) },
    auditEvent: { groupBy: vi.fn(async ({ where }: any) => (where.createdAt.lt ? [] : h.signins)) },
    membership: { findMany: vi.fn(async () => [{ user: { email: "admin@x.test" } }]) },
  },
}));
vi.mock("@/lib/cron/leases", () => ({ acquireLeaseOn: vi.fn(async () => true), releaseLeaseOn: vi.fn(async () => {}) }));
vi.mock("@/lib/tenantGuard", () => ({
  tenantIsOpen: async (id: string) => statusOf(id) === "active",
  closedTenantIds: async () => Object.keys(h.status).filter((id) => h.status[id] !== "active"),
  forgetTenantStatus: () => {},
}));
const runLakePull = vi.hoisted(() => vi.fn(async () => ({ status: "ok", rowsWritten: 1 })));
vi.mock("@/lib/lake/restPull", () => ({ runLakePull }));
const refreshMaterializedView = vi.hoisted(() => vi.fn(async () => ({ status: "ok", rowCount: 1, durationMs: 1 })));
vi.mock("@/lib/lake/materialize", () => ({ refreshMaterializedView }));
const snapshotTenant = vi.hoisted(() => vi.fn(async () => ({ skipped: true })));
vi.mock("@/lib/lake/backup", () => ({ snapshotTenant, sweepOldBackups: vi.fn(async () => {}) }));
const mintBackupSnapshots = vi.hoisted(() => vi.fn(async () => ({ created: 0 })));
vi.mock("@/lib/lake/timeTravel", () => ({ mintBackupSnapshots }));
vi.mock("@/lib/webhooks", () => ({ emitWebhook: (a: any) => { h.webhooks.push(a); } }));
vi.mock("@/lib/delivery/email", () => ({ sendEmail: async (a: any) => { h.emails.push(a); return { ok: true }; } }));
vi.mock("@/ee", () => ({ ee: { cron: { fireSecurityAlert: async (a: any) => { h.alerts.push(a); } } } }));

import { tickLakePulls, tickMaterializedViews, tickLakeBackups, tickBackupSnapshots } from "./lakeTicks";
import { tickAiUsageThreshold, tickSecurityAlerts } from "./opsTicks";

const NOW = new Date("2026-11-13T10:00:00Z");

beforeEach(() => {
  h.status = { "t-closed": "suspended", "t-purge": "pending_deletion" };
  h.pulls = [
    { id: "p-open", tenantId: "t-open", name: "open pull", cron: "* * * * *", tableName: "a" },
    { id: "p-closed", tenantId: "t-closed", name: "closed pull", cron: "* * * * *", tableName: "b" },
    { id: "p-purge", tenantId: "t-purge", name: "purge pull", cron: "* * * * *", tableName: "c" },
  ];
  h.views = [
    { id: "mv-open", tenantId: "t-open", name: "open mv", cron: "* * * * *" },
    { id: "mv-closed", tenantId: "t-closed", name: "closed mv", cron: "* * * * *" },
  ];
  h.tenants = [
    { id: "t-open", llmCostThresholdMicroUsd: 100, llmCostLastNotifyAt: null },
    { id: "t-closed", llmCostThresholdMicroUsd: 100, llmCostLastNotifyAt: null },
    { id: "t-purge", llmCostThresholdMicroUsd: 100, llmCostLastNotifyAt: null },
  ];
  h.usage = [
    { tenantId: "t-open", _sum: { microCostUsd: 500 } },
    { tenantId: "t-closed", _sum: { microCostUsd: 500 } },
  ];
  h.signins = [
    { tenantId: "t-open", userEmail: "a@x.test", _count: { _all: 6 } },
    { tenantId: "t-closed", userEmail: "b@x.test", _count: { _all: 6 } },
  ];
  h.wheres = {};
  h.tenantUpdates = [];
  h.webhooks = [];
  h.emails = [];
  h.alerts = [];
  runLakePull.mockClear();
  refreshMaterializedView.mockClear();
  snapshotTenant.mockClear();
  mintBackupSnapshots.mockClear();
});

describe("lake pulls and materialized views", () => {
  it("tickLakePulls asks for open workspaces only and runs only the open workspace's pull", async () => {
    const fired: any[] = [];
    await tickLakePulls(fired, NOW, true);
    expect(h.wheres.lakePull).toMatchObject({ enabled: true, tenant: { status: "active" } });
    expect(runLakePull.mock.calls.map((c: any[]) => c[0])).toEqual(["p-open"]);
    expect(fired.map((f) => f.id)).toEqual(["p-open"]);
  });

  it("tickMaterializedViews asks for open workspaces only and refreshes only the open workspace's view", async () => {
    const fired: any[] = [];
    await tickMaterializedViews(fired, NOW, true);
    expect(h.wheres.materializedView).toMatchObject({ enabled: true, cron: { not: null }, tenant: { status: "active" } });
    expect(refreshMaterializedView.mock.calls.map((c: any[]) => c[0])).toEqual(["mv-open"]);
  });
});

describe("backups keep protecting a suspended workspace but not one that is being purged", () => {
  it("tickLakeBackups snapshots open and suspended workspaces, not pending_deletion", async () => {
    await tickLakeBackups([], NOW, true);
    expect(h.wheres.tenant).toEqual({ status: { not: "pending_deletion" } });
    expect(snapshotTenant.mock.calls.map((c: any[]) => c[0].tenantId).sort()).toEqual(["t-closed", "t-open"]);
  });

  it("tickBackupSnapshots mints for open and suspended workspaces, not pending_deletion", async () => {
    await tickBackupSnapshots([], NOW, true);
    expect(h.wheres.tenant).toEqual({ status: { not: "pending_deletion" } });
    expect(mintBackupSnapshots.mock.calls.map((c: any[]) => c[0]).sort()).toEqual(["t-closed", "t-open"]);
  });
});

describe("tickAiUsageThreshold", () => {
  it("reads open workspaces only: no webhook and no write for a closed workspace over its threshold", async () => {
    await tickAiUsageThreshold([], NOW, true);
    expect(h.wheres.tenant).toEqual({ status: "active" });
    expect(h.webhooks.map((w) => w.tenantId)).toEqual(["t-open"]);
    expect(h.tenantUpdates.map((u) => u.where.id)).toEqual(["t-open"]);
  });
});

describe("tickSecurityAlerts", () => {
  it("alerts the open workspace (webhook, email, Operate item) and says nothing to a closed one", async () => {
    const fired: any[] = [];
    await tickSecurityAlerts(fired, NOW, true);
    expect(h.webhooks.map((w) => w.tenantId)).toEqual(["t-open"]);
    expect(h.emails.map((e) => e.tenantId)).toEqual(["t-open"]);
    expect(h.alerts.map((a) => a.tenantId)).toEqual(["t-open"]);
    expect(fired.map((f) => f.id)).toEqual(["t-open:a@x.test"]);
  });
});
