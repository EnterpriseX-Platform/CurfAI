/**
 * OWASP A09:2025 regression — `signin.failed` was declared as an AuditKind
 * in lib/audit.ts but nothing ever recorded one; a credential-stuffing run
 * against a real account left zero trail. This covers the branch of
 * authorize() where we actually have memberships to scope the row to (a
 * matched user whose password didn't verify) — the unknown-email branch
 * intentionally records nothing, since there's no tenant to attribute it to.
 *
 * Also covers the User<->Workspace migration: authorize() now looks the
 * account up by email (globally unique) instead of a per-tenant findFirst,
 * and resolves role/tenantId from Membership rather than the User row
 * itself.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findUniqueMock = vi.fn();
const membershipFindManyMock = vi.fn();
const recordAuditMock = vi.fn();
const compareMock = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: (...args: unknown[]) => findUniqueMock(...args) },
    membership: { findMany: (...args: unknown[]) => membershipFindManyMock(...args) },
  },
}));
vi.mock("@/lib/audit", () => ({ recordAudit: (...args: unknown[]) => recordAuditMock(...args) }));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: () => ({ ok: true, remaining: 9, retryAfterMs: 0 }) }));
vi.mock("bcryptjs", () => ({ default: { compare: (...args: unknown[]) => compareMock(...args) } }));

const { authOptions } = await import("./auth");
// next-auth's Credentials() factory stubs the top-level `.authorize` to
// `() => null` and stashes the real one under `.options.authorize` (the
// object we passed to Credentials({...}) in lib/auth.ts).
const authorize = (authOptions.providers[0] as any).options.authorize as (creds: any) => Promise<any>;

beforeEach(() => {
  findUniqueMock.mockReset();
  membershipFindManyMock.mockReset();
  recordAuditMock.mockReset();
  compareMock.mockReset();
});

describe("authorize() — signin.failed audit trail", () => {
  it("records signin.failed against every workspace this email belongs to when the password is wrong", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: "u1", email: "a@b.com", passwordHash: "hash" });
    membershipFindManyMock.mockResolvedValueOnce([{ tenantId: "t1", role: "viewer" }, { tenantId: "t2", role: "admin" }]);
    compareMock.mockResolvedValueOnce(false);
    const result = await authorize({ email: "a@b.com", password: "wrong" });
    expect(result).toBeNull();
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t1", userId: "u1", userEmail: "a@b.com", kind: "signin.failed" }),
    );
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t2", userId: "u1", userEmail: "a@b.com", kind: "signin.failed" }),
    );
    expect(recordAuditMock).toHaveBeenCalledTimes(2);
  });

  it("does not record anything for an email that matches no user (nothing to attribute it to)", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const result = await authorize({ email: "nobody@b.com", password: "whatever" });
    expect(result).toBeNull();
    expect(recordAuditMock).not.toHaveBeenCalled();
  });

  it("does not record on a successful login", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: "u1", email: "a@b.com", passwordHash: "hash" });
    membershipFindManyMock.mockResolvedValueOnce([{ tenantId: "t1", role: "viewer" }]);
    compareMock.mockResolvedValueOnce(true);
    const result = await authorize({ email: "a@b.com", password: "correct" });
    expect(result).toMatchObject({ id: "u1", tenantId: "t1", role: "viewer" });
    expect(recordAuditMock).not.toHaveBeenCalled();
  });

  it("returns null when the account has no membership left to log in to", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: "u1", email: "a@b.com", passwordHash: "hash" });
    membershipFindManyMock.mockResolvedValueOnce([]);
    compareMock.mockResolvedValueOnce(true);
    const result = await authorize({ email: "a@b.com", password: "correct" });
    expect(result).toBeNull();
  });
});
