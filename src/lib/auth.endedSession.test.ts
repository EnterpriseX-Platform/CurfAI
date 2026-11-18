/**
 * An ended session (revoked, idle, account deleted, no open workspace) still
 * comes back from NextAuth as an object, with id and tenantId blanked by the
 * session() callback. readSession()/getSession() must report it as "not
 * signed in" — pages only check `if (!session)`, and on QA (2026-11-17) /brief
 * rendered with no workspace and crashed instead of going to /login.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getServerSessionMock = vi.fn();
const bindMock = vi.fn();
vi.mock("next-auth", async (orig) => ({ ...(await orig<any>()), getServerSession: (...a: unknown[]) => getServerSessionMock(...a) }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/dbContext", () => ({
  bindRequestDbContext: (...a: unknown[]) => bindMock(...a),
  withSystemDbContext: (fn: () => unknown) => fn(),
}));

const { readSession, getSession } = await import("./auth");

beforeEach(() => {
  getServerSessionMock.mockReset();
  bindMock.mockReset();
});

describe("ended sessions read as signed out", () => {
  it("returns null when session() blanked the identity", async () => {
    getServerSessionMock.mockResolvedValue({ user: { email: "a@x.test", id: undefined, tenantId: undefined }, expires: "x" });
    expect(await readSession()).toBeNull();
    expect(await getSession()).toBeNull();
    expect(bindMock).not.toHaveBeenCalled();
  });

  it("returns null when there is no session at all", async () => {
    getServerSessionMock.mockResolvedValue(null);
    expect(await getSession()).toBeNull();
  });

  it("keeps a live session and binds its workspace", async () => {
    const live = { user: { id: "u1", tenantId: "t1", role: "admin" }, expires: "x" };
    getServerSessionMock.mockResolvedValue(live);
    expect(await getSession()).toBe(live);
    expect(bindMock).toHaveBeenCalledWith({ tenantId: "t1", userId: "u1", role: "admin" });
  });
});
