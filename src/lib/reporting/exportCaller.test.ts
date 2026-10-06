/**
 * A scheduled delivery used to render as the system, so anyone who could
 * create a schedule could have a report emailed out with data from sources
 * their own role can't see. It now renders as the schedule's creator, read
 * from their Membership in the schedule's workspace at send time.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: { membership: { findUnique: vi.fn() } } }));

import { prisma } from "@/lib/db";
import { ANONYMOUS_VIEWER } from "@/lib/reporting/runner";
import { deliveryViewer } from "./exportCaller";

const schedule = { tenantId: "t1", createdById: "u-dev" };
const member = (role: string, rolesJson = "[]") =>
  vi.mocked(prisma.membership.findUnique).mockResolvedValue({ role, rolesJson } as any);

beforeEach(() => vi.clearAllMocks());

describe("deliveryViewer — a delivery renders as its creator", () => {
  it("reads the creator's Membership in the schedule's own workspace", async () => {
    member("developer");
    await deliveryViewer(schedule);
    expect(vi.mocked(prisma.membership.findUnique).mock.calls[0][0]).toMatchObject({
      where: { userId_tenantId: { userId: "u-dev", tenantId: "t1" } },
    });
  });

  it("a developer gets their custom roles and no admin bypass", async () => {
    member("developer", '["finance"]');
    expect(await deliveryViewer(schedule)).toEqual({ id: "u-dev", isAdmin: false, roles: ["finance"] });
  });

  it("an admin creator keeps the admin bypass", async () => {
    member("admin", '["analyst"]');
    expect(await deliveryViewer(schedule)).toEqual({ id: "u-dev", isAdmin: true, roles: ["analyst"] });
  });

  it("resolves roles the way a session does, executive folded in", async () => {
    member("executive", "[]");
    expect((await deliveryViewer(schedule)).roles).toEqual(["executive"]);
  });

  it("a creator who left the workspace renders as no one in it", async () => {
    // Not the system, and not the creator's id either: an owner-only
    // source they left behind stays hidden.
    vi.mocked(prisma.membership.findUnique).mockResolvedValue(null);
    expect(await deliveryViewer(schedule)).toEqual(ANONYMOUS_VIEWER);
  });
});
