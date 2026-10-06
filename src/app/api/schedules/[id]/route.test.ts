/**
 * DELETE/PATCH /api/schedules/:id were tenant-scoped but never checked a
 * report-scoped API key's allowlist, so a key scoped to report A could
 * delete a schedule on report B, or PATCH its recipients so the next cron
 * tick emails report B wherever the key chose.
 *
 * They also let any role in (a viewer could delete a delivery or repoint
 * its recipients), and matched every Schedule row regardless of kind, so
 * they could edit or delete a watcher past watchers/[id]'s ownership rule,
 * or a digest past the admin-only admin/digest/[id].
 *
 * The real tenantWhere() / requireReportInScope() run here; only the caller
 * identity is stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ user: null as any }));

vi.mock("@/lib/db", () => ({
  prisma: {
    schedule: {
      findFirst: vi.fn(),
      update: vi.fn(async () => ({ id: "s1" })),
      delete: vi.fn(async () => ({})),
    },
  },
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireUser: vi.fn(async () => h.user) };
});
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));

import { prisma } from "@/lib/db";
import { DELETE, PATCH } from "./route";

const ctx = { params: { id: "s1" } };
const del = () => DELETE(new NextRequest("http://localhost:3100/api/schedules/s1", { method: "DELETE" }), ctx);
const patch = (body: unknown) => PATCH(
  new NextRequest("http://localhost:3100/api/schedules/s1", { method: "PATCH", body: JSON.stringify(body) }),
  ctx,
);
const scopedKey = { id: "apikey:k1", email: "apikey+curf_x@curf.local", role: "developer", tenantId: "t1", viaApiKey: true, apiKeyId: "k1", scopedReportIds: ["rA"] };
const session = (role: string) => ({ id: "u1", email: "u@test.dev", role, tenantId: "t1" });

/** Answers findFirst the way Postgres would for these rows, so a filter
 *  the route leaves out actually changes what it finds. */
function tableOf(rows: Array<{ id: string; tenantId: string; kind: string; reportId: string; name: string }>) {
  vi.mocked(prisma.schedule.findFirst).mockImplementation((async ({ where }: any) =>
    rows.find((r) => Object.entries(where).every(([k, v]) => (r as any)[k] === v)) ?? null) as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.user = scopedKey;
});

describe("DELETE /api/schedules/:id — report-scoped API keys", () => {
  it("404s a schedule on a report outside the key's allowlist and deletes nothing", async () => {
    vi.mocked(prisma.schedule.findFirst).mockResolvedValue({ id: "s1", name: "P&L", reportId: "rB" } as any);
    const res = await del();
    expect(res.status).toBe(404);
    expect(prisma.schedule.delete).not.toHaveBeenCalled();
  });

  it("deletes a schedule on an allowlisted report", async () => {
    vi.mocked(prisma.schedule.findFirst).mockResolvedValue({ id: "s1", name: "Sales", reportId: "rA" } as any);
    expect((await del()).status).toBe(200);
    expect(prisma.schedule.delete).toHaveBeenCalledTimes(1);
  });
});

describe("PATCH /api/schedules/:id — report-scoped API keys", () => {
  it("404s a schedule on a report outside the key's allowlist and leaves its recipients alone", async () => {
    vi.mocked(prisma.schedule.findFirst).mockResolvedValue({ id: "s1", reportId: "rB" } as any);
    const res = await patch({ recipients: ["attacker@example.com"], enabled: true });
    expect(res.status).toBe(404);
    expect(prisma.schedule.update).not.toHaveBeenCalled();
  });

  it("selects the schedule's reportId so the scope check has something to check", async () => {
    vi.mocked(prisma.schedule.findFirst).mockResolvedValue({ id: "s1", reportId: "rA" } as any);
    expect((await patch({ enabled: false })).status).toBe(200);
    expect(vi.mocked(prisma.schedule.findFirst).mock.calls[0][0]).toMatchObject({
      where: { id: "s1", tenantId: "t1" },
      select: { reportId: true },
    });
    expect(prisma.schedule.update).toHaveBeenCalledTimes(1);
  });
});

describe("/api/schedules/:id — viewer and executive are read-only", () => {
  const readOnly = [
    ["a viewer session", session("viewer")],
    ["an executive session", session("executive")],
    ["a viewer-role API key", { ...scopedKey, role: "viewer", scopedReportIds: undefined }],
  ] as const;

  for (const [who, user] of readOnly) {
    it(`403s ${who} on DELETE before looking anything up`, async () => {
      h.user = user;
      const res = await del();
      expect(res.status).toBe(403);
      expect(prisma.schedule.findFirst).not.toHaveBeenCalled();
      expect(prisma.schedule.delete).not.toHaveBeenCalled();
    });

    it(`403s ${who} on PATCH, so it can't repoint the recipients`, async () => {
      h.user = user;
      const res = await patch({ recipients: ["attacker@example.com"] });
      expect(res.status).toBe(403);
      expect(prisma.schedule.update).not.toHaveBeenCalled();
    });
  }

  it("still lets developers and admins manage any delivery in the workspace", async () => {
    tableOf([{ id: "s1", tenantId: "t1", kind: "delivery", reportId: "rA", name: "Sales" }]);
    h.user = session("developer");
    expect((await patch({ enabled: false })).status).toBe(200);
    h.user = session("admin");
    expect((await del()).status).toBe(200);
  });
});

describe("/api/schedules/:id — delivery schedules only", () => {
  beforeEach(() => { h.user = session("developer"); });

  for (const kind of ["watcher", "digest", "brief"]) {
    it(`404s a ${kind} and neither edits nor deletes it`, async () => {
      tableOf([{ id: "s1", tenantId: "t1", kind, reportId: "rA", name: "Not a delivery" }]);
      expect((await patch({ enabled: false, recipients: ["attacker@example.com"] })).status).toBe(404);
      expect((await del()).status).toBe(404);
      expect(prisma.schedule.update).not.toHaveBeenCalled();
      expect(prisma.schedule.delete).not.toHaveBeenCalled();
    });
  }

  it("finds a delivery schedule", async () => {
    tableOf([{ id: "s1", tenantId: "t1", kind: "delivery", reportId: "rA", name: "Sales" }]);
    expect((await del()).status).toBe(200);
    expect(prisma.schedule.delete).toHaveBeenCalledTimes(1);
  });
});
