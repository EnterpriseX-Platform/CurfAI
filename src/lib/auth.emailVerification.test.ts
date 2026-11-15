/**
 * Password sign-in and email verification. A new account whose address was
 * never proven can't sign in with a password where the platform can mail the
 * link; the refusal comes only after the right password, so it tells a
 * stranger nothing, and accounts that predate the feature are never held back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const prisma = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  membership: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("@/lib/dbContext", () => ({ bindRequestDbContext: vi.fn(), withSystemDbContext: (fn: () => unknown) => fn() }));
const compare = vi.hoisted(() => vi.fn());
vi.mock("bcryptjs", () => ({ default: { compare, hash: vi.fn() } }));
const recordAudit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/audit", () => ({ recordAudit }));

const { authOptions, EMAIL_NOT_VERIFIED } = await import("./auth");
const authorize = (authOptions.providers.find((p: any) => p.id === "credentials") as any).options.authorize as
  (c: { email: string; password: string }) => Promise<unknown>;

const ENV = ["RESEND_API_KEY", "BRIEF_EMAIL_FROM", "SMTP_HOST", "CURF_REQUIRE_EMAIL_VERIFICATION"] as const;
const saved: Record<string, string | undefined> = {};
let n = 0;
const login = (over: Record<string, unknown> = {}, password = "right-password") => {
  // A different address each call: the sign-in limiter counts per address.
  const email = `person${++n}@example.test`;
  prisma.user.findUnique.mockResolvedValue({
    id: "u1", email, name: null, passwordHash: "$2a$hash",
    emailVerifiedAt: null, emailVerifyGrandfathered: false, ...over,
  });
  return authorize({ email, password });
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  prisma.membership.findMany.mockResolvedValue([{ tenantId: "t1", role: "admin" }]);
  compare.mockImplementation(async (pw: string) => pw === "right-password");
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe("credentials sign-in and email verification", () => {
  it("the error the login pages match on is stable text", () => {
    expect(EMAIL_NOT_VERIFIED).toBe("Email not verified");
  });

  describe("where the platform can send the link", () => {
    beforeEach(() => { process.env.SMTP_HOST = "smtp.example.com"; });

    it("refuses a new, unverified account that gave the right password, and audits it", async () => {
      await expect(login()).rejects.toThrow(EMAIL_NOT_VERIFIED);
      expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: "t1", kind: "signin.failed", meta: { reason: "email_unverified" },
      }));
    });

    it("says nothing special to someone with the wrong password — it must not reveal the account is unverified", async () => {
      const out = await login({}, "wrong-password");
      expect(out).toBeNull();
      expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ meta: { reason: "bad_password" } }));
    });

    it("lets a verified account in", async () => {
      expect(await login({ emailVerifiedAt: new Date() })).toMatchObject({ id: "u1", tenantId: "t1", role: "admin" });
    });

    it("lets an account from before the feature in, though it is unverified", async () => {
      expect(await login({ emailVerifyGrandfathered: true })).toMatchObject({ id: "u1" });
    });

    it("an operator can switch it off", async () => {
      process.env.CURF_REQUIRE_EMAIL_VERIFICATION = "off";
      expect(await login()).toMatchObject({ id: "u1" });
    });
  });

  it("holds nobody back where no mail can be sent (they could never verify)", async () => {
    expect(await login()).toMatchObject({ id: "u1" });
  });
});
