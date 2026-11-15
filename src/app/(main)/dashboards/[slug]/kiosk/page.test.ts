/**
 * The kiosk link is its own credential. A closed workspace's token reads as one that was never issued — the same
 * "not recognised" screen — and nothing is rendered or stamped.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ closed: new Set<string>() }));
const tokenUpdate = vi.fn(() => ({ catch: () => null }));
vi.mock("@/lib/db", () => ({
  prisma: {
    dashboardKioskToken: {
      findUnique: vi.fn(async () => ({ id: "k1", tenantId: "t1", revokedAt: null, expiresAt: null, dashboard: { id: "d1", slug: "ops" } })),
      update: (...a: unknown[]) => (tokenUpdate as any)(...a),
    },
  },
}));
const prefetch = vi.fn(async () => ({ id: "d1" }));
vi.mock("../payload", () => ({ prefetchDashboardPayload: (...a: unknown[]) => (prefetch as any)(...a) }));
vi.mock("../DashboardViewer", () => ({ DashboardViewer: function DashboardViewer() { return null; } }));
vi.mock("@/lib/tenantGuard", () => ({ tenantIsOpen: async (id: string) => !h.closed.has(id), closedTenantIds: async () => [], forgetTenantStatus: () => {} }));

import Page from "./page";

const open = () => Page({ params: Promise.resolve({ slug: "ops" }), searchParams: Promise.resolve({ token: "tok" }) }) as Promise<any>;

beforeEach(() => { h.closed.clear(); prefetch.mockClear(); tokenUpdate.mockClear(); });

describe("dashboard kiosk page", () => {
  it("renders an open workspace's dashboard", async () => {
    const page = await open();
    expect(page.type.name).toBe("DashboardViewer");
    expect(prefetch).toHaveBeenCalled();
  });

  it("shows the unrecognised-token screen for a closed workspace and loads nothing", async () => {
    h.closed.add("t1");
    const page = await open();
    expect(page.type.name).toBe("KioskExpired");
    expect(page.props.reason).toBe("Kiosk token not recognised.");
    expect(prefetch).not.toHaveBeenCalled();
    expect(tokenUpdate).not.toHaveBeenCalled();
  });
});
