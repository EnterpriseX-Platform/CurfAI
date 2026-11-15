/**
 * P0-1 regression (Enterprise gap analysis, 2026-11-12): a Google/GitHub
 * sign-in used to create a workspace named after the email's domain and join
 * the person to it, so unrelated @gmail.com users shared one workspace. An SSO
 * sign-in must now never create a workspace, an account or a membership, and
 * must only reach an account whose email the provider has verified.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const userFindUnique = vi.fn();
const userUpdate = vi.fn();
const membershipFindMany = vi.fn();
const tenantUpsert = vi.fn();
const tenantCreate = vi.fn();
const userCreate = vi.fn();
const membershipCreate = vi.fn();
const membershipUpsert = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: (...a: unknown[]) => userFindUnique(...a),
      update: (...a: unknown[]) => userUpdate(...a),
      create: (...a: unknown[]) => userCreate(...a),
    },
    membership: {
      findMany: (...a: unknown[]) => membershipFindMany(...a),
      create: (...a: unknown[]) => membershipCreate(...a),
      upsert: (...a: unknown[]) => membershipUpsert(...a),
    },
    tenant: {
      upsert: (...a: unknown[]) => tenantUpsert(...a),
      create: (...a: unknown[]) => tenantCreate(...a),
    },
  },
}));
vi.mock("@/lib/dbContext", () => ({ withSystemDbContext: (fn: () => unknown) => fn() }));

const { resolveSsoSignIn, providerVerifiedEmail } = await import("./ssoSignIn");

const googleProfile = (email: string, verified: unknown = true) => ({ email, email_verified: verified });
const githubEmails = (rows: unknown) => vi.fn(async () => ({ ok: true, json: async () => rows }));

beforeEach(() => {
  for (const m of [userFindUnique, userUpdate, membershipFindMany, tenantUpsert, tenantCreate, userCreate, membershipCreate, membershipUpsert]) m.mockReset();
});

function expectNothingCreated() {
  expect(tenantUpsert).not.toHaveBeenCalled();
  expect(tenantCreate).not.toHaveBeenCalled();
  expect(userCreate).not.toHaveBeenCalled();
  expect(membershipCreate).not.toHaveBeenCalled();
  expect(membershipUpsert).not.toHaveBeenCalled();
}

describe("resolveSsoSignIn", () => {
  it("refuses an email with no Curf account and creates nothing (no shared gmail.com workspace)", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    const d = await resolveSsoSignIn({ provider: "google", email: "stranger@gmail.com", profile: googleProfile("stranger@gmail.com") });
    expect(d).toEqual({ ok: false, reason: "no_account" });
    expectNothingCreated();
  });

  it("refuses an account that belongs to no workspace", async () => {
    userFindUnique.mockResolvedValueOnce({ id: "u1", email: "a@acme.com", name: "A", emailVerifiedAt: null, passwordHash: null });
    membershipFindMany.mockResolvedValueOnce([]);
    const d = await resolveSsoSignIn({ provider: "google", email: "a@acme.com", profile: googleProfile("a@acme.com") });
    expect(d.ok).toBe(false);
    expect(!d.ok && d.reason).toBe("no_account");
    expect(userUpdate).not.toHaveBeenCalled(); // an account in no workspace is left exactly as it was
    expectNothingCreated();
  });

  it("signs an invited user into their oldest real membership", async () => {
    userFindUnique.mockResolvedValueOnce({ id: "u1", email: "a@acme.com", name: "A", emailVerifiedAt: new Date(), passwordHash: null });
    membershipFindMany.mockResolvedValueOnce([{ tenantId: "t-old", role: "viewer" }, { tenantId: "t-new", role: "admin" }]);
    const d = await resolveSsoSignIn({ provider: "google", email: "a@acme.com", name: "A", profile: googleProfile("a@acme.com") });
    expect(d).toEqual({
      ok: true, userId: "u1", email: "a@acme.com", tenantId: "t-old", role: "viewer",
      emailNewlyVerified: false, passwordCleared: false,
    });
    expect(membershipFindMany.mock.calls[0]![0]).toMatchObject({ where: { userId: "u1" }, orderBy: { createdAt: "asc" } });
    expect(userUpdate).not.toHaveBeenCalled(); // nothing changed on an already-verified account
    expectNothingCreated();
  });

  describe("a suspended workspace", () => {
    const acct = { id: "u1", email: "a@acme.com", name: "A", emailVerifiedAt: new Date(), passwordHash: null };

    it("is skipped: the person lands in the oldest workspace that is still open", async () => {
      userFindUnique.mockResolvedValueOnce(acct);
      membershipFindMany.mockResolvedValueOnce([
        { tenantId: "t-closed", role: "admin", tenant: { status: "suspended" } },
        { tenantId: "t-open", role: "viewer", tenant: { status: "active" } },
      ]);
      const d = await resolveSsoSignIn({ provider: "google", email: "a@acme.com", profile: googleProfile("a@acme.com") });
      expect(d).toMatchObject({ ok: true, tenantId: "t-open", role: "viewer" });
    });

    it("is refused, with its own reason, when every workspace the account belongs to is suspended", async () => {
      userFindUnique.mockResolvedValueOnce(acct);
      membershipFindMany.mockResolvedValueOnce([{ tenantId: "t-closed", role: "admin", tenant: { status: "suspended" } }]);
      const d = await resolveSsoSignIn({ provider: "google", email: "a@acme.com", profile: googleProfile("a@acme.com") });
      expect(d).toEqual({ ok: false, reason: "workspace_suspended", userId: "u1", tenantIds: ["t-closed"] });
      expect(userUpdate).not.toHaveBeenCalled();
    });
  });

  describe("an account whose address was never verified", () => {
    const unverified = (passwordHash: string | null) =>
      ({ id: "u1", email: "victim@acme.com", name: "V", emailVerifiedAt: null, passwordHash });

    it("is verified by the provider's proof, and a password set before that proof is removed (pre-registration takeover)", async () => {
      userFindUnique.mockResolvedValueOnce(unverified("$2a$attacker-chosen"));
      membershipFindMany.mockResolvedValueOnce([{ tenantId: "t1", role: "admin" }]);
      const d = await resolveSsoSignIn({ provider: "google", email: "victim@acme.com", profile: googleProfile("victim@acme.com") });
      expect(d).toMatchObject({ ok: true, emailNewlyVerified: true, passwordCleared: true });
      expect(userUpdate).toHaveBeenCalledTimes(1);
      const { where, data } = userUpdate.mock.calls[0]![0];
      expect(where).toEqual({ id: "u1" });
      expect(data.emailVerifiedAt).toBeInstanceOf(Date);
      expect(data.passwordHash).toBeNull();
      // Ends any session the attacker opened with that password.
      expect(data.passwordChangedAt).toBeInstanceOf(Date);
    });

    it("is verified without touching the password when it never had one (an invite)", async () => {
      userFindUnique.mockResolvedValueOnce(unverified(null));
      membershipFindMany.mockResolvedValueOnce([{ tenantId: "t1", role: "viewer" }]);
      const d = await resolveSsoSignIn({ provider: "google", email: "victim@acme.com", profile: googleProfile("victim@acme.com") });
      expect(d).toMatchObject({ ok: true, emailNewlyVerified: true, passwordCleared: false });
      const { data } = userUpdate.mock.calls[0]![0];
      expect(data.emailVerifiedAt).toBeInstanceOf(Date);
      expect("passwordHash" in data).toBe(false);
      expect("passwordChangedAt" in data).toBe(false);
    });

    it("keeps its password when the provider does NOT vouch for the address", async () => {
      userFindUnique.mockResolvedValueOnce(unverified("$2a$hash"));
      membershipFindMany.mockResolvedValueOnce([{ tenantId: "t1", role: "admin" }]);
      const d = await resolveSsoSignIn({ provider: "google", email: "victim@acme.com", profile: googleProfile("victim@acme.com", false) });
      expect(d.ok).toBe(false);
      expect(userUpdate).not.toHaveBeenCalled();
    });
  });

  it("refuses an existing account when Google has not verified the email, and reports its workspaces for the audit", async () => {
    userFindUnique.mockResolvedValueOnce({ id: "u1", email: "a@acme.com", name: "A", emailVerifiedAt: null, passwordHash: "$2a$hash" });
    membershipFindMany.mockResolvedValueOnce([{ tenantId: "t1", role: "admin" }]);
    const d = await resolveSsoSignIn({ provider: "google", email: "a@acme.com", profile: googleProfile("a@acme.com", false) });
    expect(d).toEqual({ ok: false, reason: "email_unverified", userId: "u1", tenantIds: ["t1"] });
  });

  it("refuses a missing email", async () => {
    const d = await resolveSsoSignIn({ provider: "google", email: undefined });
    expect(d).toEqual({ ok: false, reason: "email_unverified" });
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("refuses a GitHub account whose email GitHub marks unverified", async () => {
    userFindUnique.mockResolvedValueOnce({ id: "u1", email: "a@acme.com", name: "A", emailVerifiedAt: null, passwordHash: null });
    membershipFindMany.mockResolvedValueOnce([{ tenantId: "t1", role: "developer" }]);
    const fetchImpl = githubEmails([{ email: "a@acme.com", primary: true, verified: false }]);
    const d = await resolveSsoSignIn({ provider: "github", email: "a@acme.com", accessToken: "gho_x", fetchImpl });
    expect(d.ok).toBe(false);
  });
});

describe("providerVerifiedEmail", () => {
  it("Google: needs email_verified and the same email in the profile", async () => {
    expect(await providerVerifiedEmail({ provider: "google", email: "a@x.com", profile: googleProfile("A@x.com") })).toBe(true);
    expect(await providerVerifiedEmail({ provider: "google", email: "a@x.com", profile: googleProfile("a@x.com", "true") })).toBe(true);
    expect(await providerVerifiedEmail({ provider: "google", email: "a@x.com", profile: googleProfile("other@x.com") })).toBe(false);
    expect(await providerVerifiedEmail({ provider: "google", email: "a@x.com", profile: { email: "a@x.com" } })).toBe(false);
  });

  it("GitHub: asks /user/emails with the access token and needs that exact email verified", async () => {
    const fetchImpl = githubEmails([
      { email: "other@x.com", primary: true, verified: true },
      { email: "a@x.com", primary: false, verified: true },
    ]);
    expect(await providerVerifiedEmail({ provider: "github", email: "a@x.com", accessToken: "gho_x", fetchImpl })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.github.com/user/emails", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer gho_x" }),
    }));
  });

  it("GitHub: fails closed without a token, on an error status, on a thrown fetch or an odd body", async () => {
    expect(await providerVerifiedEmail({ provider: "github", email: "a@x.com", accessToken: null })).toBe(false);
    const notOk = vi.fn(async () => ({ ok: false, json: async () => [] }));
    expect(await providerVerifiedEmail({ provider: "github", email: "a@x.com", accessToken: "t", fetchImpl: notOk })).toBe(false);
    const throws = vi.fn(async () => { throw new Error("down"); });
    expect(await providerVerifiedEmail({ provider: "github", email: "a@x.com", accessToken: "t", fetchImpl: throws })).toBe(false);
    expect(await providerVerifiedEmail({ provider: "github", email: "a@x.com", accessToken: "t", fetchImpl: githubEmails({}) })).toBe(false);
  });

  it("any other provider is not trusted", async () => {
    expect(await providerVerifiedEmail({ provider: "okta", email: "a@x.com", profile: { email_verified: true, email: "a@x.com" } })).toBe(false);
  });
});
