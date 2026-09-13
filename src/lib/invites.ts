import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";

/**
 * Helpers for the workspace invite flow. Keeping the token-mint + email-send
 * logic here means the initial-invite POST and the resend-invite POST share a
 * single source of truth for token shape, expiry, email copy, and audit
 * dispatch shape.
 */

export const INVITE_TTL_DAYS = 7;

export function hashInviteToken(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

export type MintedInvite = {
  rawToken: string;
  expiresAt: Date;
  acceptUrl: string;
  emailStatus: "sent" | "skipped" | "failed";
};

/**
 * Mint a fresh 7-day token for `userId`, optionally invalidate any prior
 * unused tokens for the same user (set on resend so old links stop working),
 * and dispatch the invite email. Returns the acceptUrl + email status so the
 * caller can surface them to the admin.
 */
export async function mintAndSendInvite(opts: {
  tenantId: string;
  tenantName: string;
  inviterName: string;
  user: { id: string; email: string; name: string | null; role: string };
  origin: string;
  invalidatePrevious?: boolean;
}): Promise<MintedInvite> {
  const { tenantId, tenantName, inviterName, user, origin } = opts;

  if (opts.invalidatePrevious) {
    // Mark any still-active token rows as used so old links won't validate.
    // Scoped to this tenantId too — a User is a global account now, and an
    // unrelated pending invite to a DIFFERENT workspace must survive a
    // resend here.
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, tenantId, usedAt: null },
      data: { usedAt: new Date() },
    });
  }

  const raw = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  await prisma.passwordResetToken.create({
    data: {
      tenantId,
      userId: user.id,
      tokenHash: hashInviteToken(raw),
      expiresAt,
    },
  });

  const acceptUrl = origin + "/reset/" + raw + "?invite=1";

  let emailStatus: "sent" | "skipped" | "failed" = "skipped";
  try {
    const mod = await import("@/lib/delivery/dispatch");
    const result = await mod.dispatchDelivery(
      {
        kind: "email",
        recipients: [user.email],
        subject: "You're invited to " + tenantName + " on Curf",
      },
      {
        body: Buffer.from(
          "Hello" + (user.name ? " " + user.name : "") + ",\n\n" +
          inviterName + " has invited you to join \"" + tenantName + "\" on Curf as " + user.role + ".\n\n" +
          "Set your password to accept the invite (link expires in " + INVITE_TTL_DAYS + " days):\n" +
          acceptUrl + "\n\n" +
          "If you don't recognize this invite, you can ignore this email.\n",
          "utf8",
        ),
        filename: "invite.txt",
        contentType: "text/plain",
        reportName: "Workspace invite",
        reportId: "invite",
        origin,
      },
    );
    emailStatus =
      result.status === "delivered" ? "sent" :
      result.status === "skipped" ? "skipped" : "failed";
  } catch (e: any) {
    emailStatus = "failed";
    console.error("[invite] email dispatch threw", e?.message ?? e);
  }

  if (process.env.NODE_ENV !== "production") {
    console.log("[invite] " + user.email + " -> " + acceptUrl);
  }

  return { rawToken: raw, expiresAt, acceptUrl, emailStatus };
}
