import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { ee } from "@/ee";

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

/**
 * An invited person who has not signed in yet. Not "has no password": with Keycloak as the sign-in a Curf account never holds one.
 * Signing in the first time (or a password set through an invite link, or a Google/GitHub sign-in) confirms the address, so an
 * account with neither a hash nor a confirmed address is still waiting.
 */
export function isPendingInvite(u: { passwordHash: string | null; emailVerifiedAt: Date | null }): boolean {
  return !u.passwordHash && !u.emailVerifiedAt;
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
  user: { id: string; email: string; name: string | null; role: string; emailVerifiedAt?: Date | null; keycloakSub?: string | null };
  origin: string;
  invalidatePrevious?: boolean;
}): Promise<MintedInvite> {
  const { tenantId, tenantName, inviterName, user, origin } = opts;

  // Keycloak is the only sign-in: the invitee gets Keycloak's own mail (confirm the address, choose a password) and signs in
  // there. Curf mints no token and holds no password; the "accept URL" an admin can fall back on is just the sign-in page.
  if (ee.identity?.only()) {
    const r = await ee.identity.accounts.enrollInvitee(user, { reason: opts.invalidatePrevious ? "invite_resend" : "invite" });
    return {
      rawToken: "",
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
      acceptUrl: origin + "/login",
      emailStatus: r.mail === "sent" ? "sent" : r.mail === "not_needed" ? "skipped" : "failed",
    };
  }

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
