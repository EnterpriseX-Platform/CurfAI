/**
 * BE-SEC-04. recordAudit({tenantId: "platform", ...}) used to hit a real FK
 * violation — "platform" was never an actual Tenant row — and the write's
 * own .catch() swallowed it silently, so several platform-level actions
 * (waitlist invite/approve/deny) always succeeded for the caller while
 * writing zero audit rows. AuditEvent.tenantId is now nullable and
 * recordAudit() treats an explicit `null` as "genuine platform-level event,
 * no tenant" — distinct from an *omitted* tenantId (still a bug, still
 * dropped with a warning).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const createMock = vi.fn().mockReturnValue({ catch: vi.fn() });
vi.mock("@/lib/db", () => ({
  prisma: { auditEvent: { create: (...a: any[]) => createMock(...a) } },
}));
const systemScope = vi.hoisted(() => vi.fn((fn: () => Promise<unknown>) => fn()));
vi.mock("@/lib/dbContext", () => ({ withSystemDbContext: systemScope }));
// The request being handled, as next/headers exposes it inside a route
// handler; null = outside any request (cron script, test), where it throws.
const current = vi.hoisted(() => ({ headers: null as Headers | null }));
vi.mock("next/headers", () => ({
  headers: () => { if (!current.headers) throw new Error("outside a request scope"); return current.headers; },
}));

import { recordAudit, persistAudit } from "./audit";

beforeEach(() => {
  createMock.mockClear();
  systemScope.mockClear();
  current.headers = null;
});

describe("recordAudit — tenantId: null", () => {
  it("writes the row with a null tenantId instead of a fake sentinel string", () => {
    recordAudit({ tenantId: null, userEmail: "a@b.com", kind: "waitlist.invite" as any });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].data.tenantId).toBeNull();
  });

  it("still drops the event and warns when tenantId is merely omitted (no user either)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordAudit({ kind: "signin" as any });
    expect(createMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still falls back to user.tenantId when tenantId is omitted but a user is given", () => {
    recordAudit({ user: { tenantId: "t1", email: "a@b.com" } as any, kind: "signin" as any });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].data.tenantId).toBe("t1");
  });
});

// RLS lets a request bound to a workspace write only that workspace's rows,
// so a platform-level row is written outside it — and only that row.
describe("which scope an audit row is written in", () => {
  it("writes a platform-level row (tenantId null) in the system scope", async () => {
    recordAudit({ tenantId: null, userEmail: "a@b.com", kind: "waitlist.invite" as any });
    await persistAudit({ tenantId: null, userEmail: "a@b.com", kind: "waitlist.invite" as any });
    expect(systemScope).toHaveBeenCalledTimes(2);
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("writes a workspace's row as the request, never in the system scope", async () => {
    recordAudit({ user: { tenantId: "t1", email: "a@b.com" } as any, kind: "signin" as any });
    await persistAudit({ tenantId: "t1", kind: "incident.ack" as any });
    expect(systemScope).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(2);
  });
});

// BE-SEC-05 — NextAuth's signIn event and the failed-password path call
// recordAudit with no request in hand; every sign-in row had ip NULL.
describe("the caller's address on rows written without a request", () => {
  it("is read from the request being handled", () => {
    current.headers = new Headers({ "x-forwarded-for": "203.0.113.9", "user-agent": "probe-agent" });
    recordAudit({ user: { tenantId: "t1", email: "a@b.com" } as any, kind: "signin" as any });
    expect(createMock.mock.calls[0][0].data).toMatchObject({ ip: "203.0.113.9", userAgent: "probe-agent" });
  });

  it("an explicit request still wins", () => {
    current.headers = new Headers({ "x-forwarded-for": "203.0.113.9" });
    const req = { headers: new Headers({ "x-forwarded-for": "198.51.100.7" }) } as any;
    recordAudit({ user: { tenantId: "t1", email: "a@b.com" } as any, kind: "report.create" as any, req });
    expect(createMock.mock.calls[0][0].data.ip).toBe("198.51.100.7");
  });

  it("outside any request the row is still written, without an address", () => {
    recordAudit({ user: { tenantId: "t1", email: "a@b.com" } as any, kind: "signin" as any });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].data.ip).toBeNull();
  });
});
