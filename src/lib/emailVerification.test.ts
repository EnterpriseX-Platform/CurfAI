/**
 * Email verification (pre-registration takeover fix): who must verify, how a
 * link is made and mailed, and how it is used up.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";

const prisma = vi.hoisted(() => ({
  emailVerificationToken: { updateMany: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
  user: { findUnique: vi.fn(), updateMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("@/lib/dbContext", () => ({ withSystemDbContext: (fn: () => unknown) => fn() }));
const sendEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/delivery/email", () => ({ sendEmail }));

import {
  emailTransportConfigured, emailVerificationRequired, mustVerifyBeforeSignIn,
  sendVerificationEmail, resendVerificationEmail, consumeVerificationToken, markEmailVerified,
  hashVerificationToken, VERIFY_TTL_HOURS,
} from "./emailVerification";

const ENV_KEYS = ["RESEND_API_KEY", "BRIEF_EMAIL_FROM", "SMTP_HOST", "CURF_REQUIRE_EMAIL_VERIFICATION"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  prisma.emailVerificationToken.updateMany.mockResolvedValue({ count: 0 });
  prisma.emailVerificationToken.create.mockResolvedValue({});
  sendEmail.mockResolvedValue({ ok: true });
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe("who must verify", () => {
  it("nobody is held back where the platform can't send mail", () => {
    expect(emailTransportConfigured()).toBe(false);
    expect(emailVerificationRequired()).toBe(false);
    expect(mustVerifyBeforeSignIn({ emailVerifiedAt: null, emailVerifyGrandfathered: false })).toBe(false);
  });

  it("is required once Resend (with a from address) or SMTP is configured", () => {
    process.env.RESEND_API_KEY = "re_x";
    expect(emailVerificationRequired()).toBe(false); // no from address: the send would fail
    process.env.BRIEF_EMAIL_FROM = "Curf <no-reply@example.com>";
    expect(emailVerificationRequired()).toBe(true);
    delete process.env.RESEND_API_KEY; delete process.env.BRIEF_EMAIL_FROM;
    process.env.SMTP_HOST = "smtp.example.com";
    expect(emailVerificationRequired()).toBe(true);
  });

  it("CURF_REQUIRE_EMAIL_VERIFICATION=off turns it off", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.CURF_REQUIRE_EMAIL_VERIFICATION = "off";
    expect(emailVerificationRequired()).toBe(false);
  });

  it("holds back only a new, unverified account — not a verified one, and not one from before the feature", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    expect(mustVerifyBeforeSignIn({ emailVerifiedAt: null, emailVerifyGrandfathered: false })).toBe(true);
    expect(mustVerifyBeforeSignIn({ emailVerifiedAt: new Date(), emailVerifyGrandfathered: false })).toBe(false);
    expect(mustVerifyBeforeSignIn({ emailVerifiedAt: null, emailVerifyGrandfathered: true })).toBe(false);
  });
});

describe("sendVerificationEmail", () => {
  const user = { id: "u1", email: "a@x.com", name: "Ada <script>" };

  it("stores only the hash of the token, retires earlier links, and mails a link on this site", async () => {
    const r = await sendVerificationEmail({ user, origin: "https://app.example.com/" });
    expect(r).toBe("sent");
    expect(prisma.emailVerificationToken.updateMany).toHaveBeenCalledWith({ where: { userId: "u1", usedAt: null }, data: { usedAt: expect.any(Date) } });

    const stored = prisma.emailVerificationToken.create.mock.calls[0]![0].data;
    const mail = sendEmail.mock.calls[0]![0];
    const link = /https:\/\/app\.example\.com\/verify-email\/(\S+)/.exec(mail.text)!;
    expect(link).not.toBeNull();
    const raw = link[1]!;
    expect(stored.tokenHash).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(raw);
    expect(stored.email).toBe("a@x.com");
    const ttl = stored.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan((VERIFY_TTL_HOURS - 1) * 3600_000);
    expect(ttl).toBeLessThanOrEqual(VERIFY_TTL_HOURS * 3600_000);
    expect(mail.to).toEqual(["a@x.com"]);
    expect(mail.html).toContain(`https://app.example.com/verify-email/${raw}`);
    expect(mail.html).not.toContain("<script>"); // the name is escaped
  });

  it("reports a failed send, and a failed store without mailing anything", async () => {
    sendEmail.mockResolvedValueOnce({ ok: false, error: "smtp down" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sendVerificationEmail({ user, origin: "https://app.example.com" })).toBe("failed");

    sendEmail.mockClear();
    prisma.emailVerificationToken.create.mockRejectedValueOnce(new Error("db down"));
    expect(await sendVerificationEmail({ user, origin: "https://app.example.com" })).toBe("failed");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("never throws when the transport does", async () => {
    sendEmail.mockRejectedValueOnce(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(sendVerificationEmail({ user, origin: "https://app.example.com" })).resolves.toBe("failed");
  });
});

describe("resendVerificationEmail — says nothing about who has an account", () => {
  it("sends nothing for an unknown address or one that is already verified", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    await resendVerificationEmail("nobody@x.com", "https://app.example.com");
    prisma.user.findUnique.mockResolvedValueOnce({ id: "u1", email: "a@x.com", name: null, emailVerifiedAt: new Date() });
    await resendVerificationEmail("a@x.com", "https://app.example.com");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends a link to an unverified account", async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: "u1", email: "a@x.com", name: null, emailVerifiedAt: null });
    await resendVerificationEmail("a@x.com", "https://app.example.com");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe("consumeVerificationToken", () => {
  const raw = "r".repeat(43);
  const row = (over: Record<string, unknown> = {}) => ({
    id: "t1", userId: "u1", email: "a@x.com", usedAt: null, expiresAt: new Date(Date.now() + 60_000), ...over,
  });
  const account = (over: Record<string, unknown> = {}) => ({ id: "u1", email: "a@x.com", emailVerifiedAt: null, ...over });

  it("verifies the account and uses the link up", async () => {
    prisma.emailVerificationToken.findUnique.mockResolvedValueOnce(row());
    prisma.emailVerificationToken.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.user.findUnique.mockResolvedValueOnce(account());
    const out = await consumeVerificationToken(raw);
    expect(out).toEqual({ ok: true, userId: "u1", email: "a@x.com", alreadyVerified: false });
    expect(prisma.emailVerificationToken.findUnique).toHaveBeenCalledWith({ where: { tokenHash: hashVerificationToken(raw) } });
    expect(prisma.emailVerificationToken.updateMany).toHaveBeenCalledWith({ where: { id: "t1", usedAt: null }, data: { usedAt: expect.any(Date) } });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({ where: { id: "u1", emailVerifiedAt: null }, data: { emailVerifiedAt: expect.any(Date) } });
  });

  it("refuses an unknown, used or expired link without touching the account", async () => {
    prisma.emailVerificationToken.findUnique.mockResolvedValueOnce(null);
    expect(await consumeVerificationToken(raw)).toEqual({ ok: false });
    prisma.emailVerificationToken.findUnique.mockResolvedValueOnce(row({ usedAt: new Date() }));
    expect(await consumeVerificationToken(raw)).toEqual({ ok: false });
    prisma.emailVerificationToken.findUnique.mockResolvedValueOnce(row({ expiresAt: new Date(Date.now() - 1) }));
    expect(await consumeVerificationToken(raw)).toEqual({ ok: false });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("refuses when a concurrent request used the link first", async () => {
    prisma.emailVerificationToken.findUnique.mockResolvedValueOnce(row());
    prisma.emailVerificationToken.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await consumeVerificationToken(raw)).toEqual({ ok: false });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("verifies nothing when the account's address has changed since the link was sent", async () => {
    prisma.emailVerificationToken.findUnique.mockResolvedValueOnce(row({ email: "old@x.com" }));
    prisma.emailVerificationToken.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.user.findUnique.mockResolvedValueOnce(account({ email: "new@x.com" }));
    expect(await consumeVerificationToken(raw)).toEqual({ ok: false });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("reports an account that was already verified, and keeps its original date", async () => {
    prisma.emailVerificationToken.findUnique.mockResolvedValueOnce(row());
    prisma.emailVerificationToken.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.user.findUnique.mockResolvedValueOnce(account({ emailVerifiedAt: new Date("2026-01-01") }));
    const out = await consumeVerificationToken(raw);
    expect(out).toMatchObject({ ok: true, alreadyVerified: true });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
});

describe("markEmailVerified", () => {
  it("only ever sets a date on an account that has none", async () => {
    await markEmailVerified("u1");
    expect(prisma.user.updateMany).toHaveBeenCalledWith({ where: { id: "u1", emailVerifiedAt: null }, data: { emailVerifiedAt: expect.any(Date) } });
  });
});
