import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const consume = vi.hoisted(() => vi.fn());
vi.mock("@/lib/emailVerification", () => ({
  consumeVerificationToken: consume,
  resendVerificationEmail: vi.fn(async () => {}),
}));
const prisma = vi.hoisted(() => ({ membership: { findMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("@/lib/dbContext", () => ({ withSystemDbContext: (fn: () => unknown) => fn() }));
const recordAudit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/audit", () => ({ recordAudit }));

import { POST as verify } from "./route";
import { POST as resend } from "./resend/route";
import { resendVerificationEmail } from "@/lib/emailVerification";

let n = 0;
const post = (path: string, body: unknown) => new NextRequest(`http://localhost:3100${path}`, {
  method: "POST",
  body: JSON.stringify(body),
  // A fresh source each call so the per-IP limiter never interferes.
  headers: { "x-forwarded-for": `10.9.${Math.floor(++n / 250)}.${n % 250}` },
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.membership.findMany.mockResolvedValue([{ tenantId: "t1" }, { tenantId: "t2" }]);
});

describe("POST /api/verify-email", () => {
  it("rejects a malformed body", async () => {
    expect((await verify(post("/api/verify-email", { token: "short" }))).status).toBe(400);
    expect(consume).not.toHaveBeenCalled();
  });

  it("answers 400 for a link that is invalid, used or expired", async () => {
    consume.mockResolvedValueOnce({ ok: false });
    const res = await verify(post("/api/verify-email", { token: "x".repeat(43) }));
    expect(res.status).toBe(400);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("verifies and audits against every workspace the address belongs to", async () => {
    consume.mockResolvedValueOnce({ ok: true, userId: "u1", email: "a@x.com", alreadyVerified: false });
    const res = await verify(post("/api/verify-email", { token: "x".repeat(43) }));
    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledTimes(2);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", userId: "u1", kind: "email.verified", meta: { via: "link" } }));
  });

  it("succeeds without a second audit row when the address was already verified", async () => {
    consume.mockResolvedValueOnce({ ok: true, userId: "u1", email: "a@x.com", alreadyVerified: true });
    const res = await verify(post("/api/verify-email", { token: "x".repeat(43) }));
    expect(res.status).toBe(200);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe("POST /api/verify-email/resend", () => {
  it("answers the same {ok:true} for any address, valid or not, and never reveals whether it has an account", async () => {
    const a = await resend(post("/api/verify-email/resend", { email: "someone@x.com" }));
    const b = await resend(post("/api/verify-email/resend", { email: "not an email" }));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.json()).toEqual({ ok: true });
    expect(await b.json()).toEqual({ ok: true });
    expect(resendVerificationEmail).toHaveBeenCalledTimes(1); // the malformed one sends nothing
  });

  it("builds the link from the configured site, not from the request", async () => {
    await resend(post("/api/verify-email/resend", { email: "someone@x.com" }));
    const origin = (resendVerificationEmail as any).mock.calls[0][1] as string;
    expect(origin).toMatch(/^https?:\/\//);
  });

  it("stops mailing one address after three requests in a quarter hour, still answering ok", async () => {
    const email = `flood-${Date.now()}@x.com`;
    for (let i = 0; i < 5; i++) {
      const res = await resend(post("/api/verify-email/resend", { email }));
      expect(res.status).toBe(200);
    }
    expect((resendVerificationEmail as any).mock.calls.filter((c: any[]) => c[0] === email)).toHaveLength(3);
  });
});
