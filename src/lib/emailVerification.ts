/**
 * Email verification: proving that an address belongs to the person who
 * registered it.
 *
 * Why: password signup used to accept any address. Someone could register a
 * victim's address with a password of their own choosing before the victim
 * ever came; when the victim later signed in with Google, SSO matched that
 * account by email and the attacker's password still opened it (gap analysis,
 * "pre-registration takeover"). An address is now proven by one of:
 *   - following the link mailed to it (this module),
 *   - setting a password through a reset or invite link (also mailed to it),
 *   - signing in with Google/GitHub when the provider verified it
 *     (lib/ssoSignIn.ts, which also removes any password set before then),
 *   - signing up from a waitlist invite that was sent to that address.
 *
 * Enforcement is "a new account must be verified before it can sign in with a
 * password", and only where the platform can actually send mail
 * (emailVerificationRequired): a deployment with no mail transport would
 * otherwise lock every new user out. Accounts that existed before the
 * feature are grandfathered — unverified but never locked out.
 *
 * Only the sha256 of a token is stored; the raw value exists in the email.
 */
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { withSystemDbContext } from "@/lib/dbContext";
import { sendEmail } from "@/lib/delivery/email";
import { ee } from "@/ee";

export const VERIFY_TTL_HOURS = 48;

export function hashVerificationToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** True when the platform itself (not a tenant's own settings) can send mail. */
export function emailTransportConfigured(): boolean {
  return (!!process.env.RESEND_API_KEY && !!process.env.BRIEF_EMAIL_FROM) || !!process.env.SMTP_HOST;
}

/**
 * Whether an unverified new account is held back from password sign-in.
 * On when the platform can send the link; `CURF_REQUIRE_EMAIL_VERIFICATION=off`
 * turns it off (an operator who verifies accounts some other way). It cannot
 * be forced on without a transport — nobody could ever verify.
 */
export function emailVerificationRequired(): boolean {
  if ((process.env.CURF_REQUIRE_EMAIL_VERIFICATION ?? "").toLowerCase() === "off") return false;
  return emailTransportConfigured();
}

/** True when this account may not sign in with a password until it verifies. */
export function mustVerifyBeforeSignIn(user: { emailVerifiedAt?: Date | null; emailVerifyGrandfathered?: boolean | null }): boolean {
  return emailVerificationRequired() && !user.emailVerifiedAt && !user.emailVerifyGrandfathered;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export type VerificationSend = "sent" | "failed";

/**
 * Mint a fresh link for this account's current address and mail it. Earlier
 * unused links stop working. Never throws: a failed send is reported, and the
 * person can ask again from the sign-in page.
 */
export async function sendVerificationEmail(opts: {
  user: { id: string; email: string; name?: string | null };
  origin: string;
}): Promise<VerificationSend> {
  const { user, origin } = opts;
  const raw = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + VERIFY_TTL_HOURS * 60 * 60 * 1000);
  try {
    await withSystemDbContext(async () => {
      await prisma.emailVerificationToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      await prisma.emailVerificationToken.create({
        data: { userId: user.id, email: user.email, tokenHash: hashVerificationToken(raw), expiresAt },
      });
    });
  } catch (e: any) {
    console.error("[email-verify] could not store a token:", e?.message ?? e);
    return "failed";
  }

  const url = `${origin.replace(/\/+$/, "")}/verify-email/${raw}`;
  const hello = user.name ? `Hello ${user.name},` : "Hello,";
  const text =
    `${hello}\n\n` +
    `Confirm that this is your email address for Curf. The link works for ${VERIFY_TTL_HOURS} hours:\n${url}\n\n` +
    `If you didn't create a Curf account, you can ignore this email.\n`;
  const html =
    `<p>${escapeHtml(hello)}</p>` +
    `<p>Confirm that this is your email address for Curf. The link works for ${VERIFY_TTL_HOURS} hours.</p>` +
    `<p><a href="${escapeHtml(url)}">Confirm my email</a></p>` +
    `<p>If you didn't create a Curf account, you can ignore this email.</p>`;

  let sent = false;
  try {
    const r = await sendEmail({ to: [user.email], subject: "Confirm your email for Curf", html, text });
    sent = r.ok;
    if (!r.ok) console.error("[email-verify] send failed:", r.error);
  } catch (e: any) {
    console.error("[email-verify] send threw:", e?.message ?? e);
  }
  if (process.env.NODE_ENV !== "production") {
    console.log(`[email-verify] dev link for ${user.email}: ${url}`);
  }
  return sent ? "sent" : "failed";
}

/**
 * Mail a link to whoever owns `email`, if that account exists and is still
 * unverified. Says nothing about which case applied, so it can't be used to
 * find out who has an account.
 */
export async function resendVerificationEmail(email: string, origin: string): Promise<void> {
  const user = await withSystemDbContext(() => prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, emailVerifiedAt: true },
  }));
  if (!user || user.emailVerifiedAt) return;
  // Keycloak is the only sign-in: it confirms the address, and sends its own mail for it.
  if (ee.identity?.only()) { await ee.identity.accounts.mail(user.email, ["VERIFY_EMAIL"]); return; }
  await sendVerificationEmail({ user, origin });
}

export type VerifyOutcome =
  | { ok: true; userId: string; email: string; alreadyVerified: boolean }
  | { ok: false };

/**
 * Use a mailed link. The link is claimed atomically first, so two requests
 * with the same link can't both succeed, and it only counts when the account
 * still has the address it was sent to.
 */
export async function consumeVerificationToken(raw: string): Promise<VerifyOutcome> {
  return withSystemDbContext(async () => {
    const tokenHash = hashVerificationToken(raw);
    const row = await prisma.emailVerificationToken.findUnique({ where: { tokenHash } });
    if (!row || row.usedAt || row.expiresAt < new Date()) return { ok: false } as const;

    const claimed = await prisma.emailVerificationToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) return { ok: false } as const;

    const user = await prisma.user.findUnique({
      where: { id: row.userId },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
    if (!user || user.email.toLowerCase() !== row.email.toLowerCase()) return { ok: false } as const;

    if (user.emailVerifiedAt) return { ok: true, userId: user.id, email: user.email, alreadyVerified: true } as const;
    await prisma.user.updateMany({ where: { id: user.id, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
    return { ok: true, userId: user.id, email: user.email, alreadyVerified: false } as const;
  });
}

/** Record that this account's address is proven (a reset or invite link was used). No-op when it already is. */
export async function markEmailVerified(userId: string): Promise<void> {
  await withSystemDbContext(() => prisma.user.updateMany({
    where: { id: userId, emailVerifiedAt: null },
    data: { emailVerifiedAt: new Date() },
  }));
}
