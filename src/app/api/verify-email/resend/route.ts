import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensureLimit } from "@/lib/rateLimit";
import { clientIp } from "@/lib/security/clientIp";
import { appBase } from "@/lib/http/appBase";
import { resendVerificationEmail } from "@/lib/emailVerification";

/**
 * POST /api/verify-email/resend — mail a new confirmation link.
 *
 * Always answers 200 with the same body, whether or not the address has an
 * account or is already verified, so it can't be used to find out who has
 * one. Limited per source and per address (the same shape as /api/forgot) so
 * it can't be used to flood someone's inbox.
 */

export const dynamic = "force-dynamic";

const Schema = z.object({ email: z.string().email() });

export async function POST(req: NextRequest) {
  const limited = await ensureLimit("verify-email-resend", `ip:${clientIp(req)}`, 10, 5 * 60_000);
  if (limited) return limited;

  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: true });

  const emailLimited = await ensureLimit("verify-email-resend-email", `email:${parsed.data.email.toLowerCase()}`, 3, 15 * 60_000);
  if (emailLimited) return NextResponse.json({ ok: true });

  // Not awaited: looking the account up and sending mail takes far longer
  // than answering for an address with no account, and the difference in
  // response time would give the same answer the body is careful not to.
  void resendVerificationEmail(parsed.data.email, appBase(req)).catch((e: any) => {
    console.error("[email-verify] resend failed:", e?.message ?? e);
  });
  return NextResponse.json({ ok: true });
}
