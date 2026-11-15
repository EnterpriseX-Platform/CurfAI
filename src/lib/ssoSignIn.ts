/**
 * Who may sign in with Google or GitHub, and into which workspace.
 *
 * The NextAuth signIn callback used to upsert a workspace whose slug was the
 * email's domain and join every SSO user to it as `developer`: every
 * @gmail.com user landed in one shared "gmail.com" workspace, accounts were
 * matched by email without asking the provider whether that email was
 * verified, and the waitlist / invite gate was skipped entirely
 * (Enterprise gap analysis P0-1, 2026-11-12).
 *
 * Now an SSO sign-in can only reach an account that already exists and
 * already belongs to a workspace — an invite creates both up front
 * (api/admin/users) — and only when the provider vouches for the email.
 * Creating a workspace stays with /signup and its beta gate. Joining by a
 * verified company domain comes with enterprise SSO (Keycloak), not here.
 *
 * A provider-verified sign-in also proves the address to Curf (see
 * lib/emailVerification.ts): an account that was never verified becomes
 * verified, and any password set before that proof is removed.
 *
 * Same membership rule as the credentials provider in lib/auth.ts: real
 * Membership rows only, oldest first.
 */
import { prisma } from "@/lib/db";
import { withSystemDbContext } from "@/lib/dbContext";
import { tenantOpen } from "@/lib/tenantStatus";

export type SsoDenyReason = "email_unverified" | "no_account" | "workspace_suspended";

export type SsoDecision =
  | {
      ok: true; userId: string; email: string; tenantId: string; role: string;
      /** The account had never been verified and this sign-in proved the address. */
      emailNewlyVerified: boolean;
      /** …and a password set before that proof was removed. */
      passwordCleared: boolean;
    }
  | { ok: false; reason: SsoDenyReason; userId?: string; tenantIds?: string[] };

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

/**
 * True only when the provider itself says `email` is verified for this
 * person. Anything we cannot confirm — an unknown provider, a missing
 * claim, a failed lookup — is false: the check fails closed.
 */
export async function providerVerifiedEmail(opts: {
  provider: string;
  email: string;
  profile?: unknown;
  accessToken?: string | null;
  fetchImpl?: FetchLike;
}): Promise<boolean> {
  const { provider, email, profile, accessToken } = opts;
  if (provider === "google") {
    const v = (profile as { email_verified?: unknown } | undefined)?.email_verified;
    const profileEmail = (profile as { email?: unknown } | undefined)?.email;
    return (v === true || v === "true")
      && typeof profileEmail === "string"
      && profileEmail.toLowerCase() === email.toLowerCase();
  }
  if (provider === "github") {
    // NextAuth's GitHub provider takes the profile's email (or the primary
    // one from /user/emails) without looking at `verified`, so ask GitHub.
    // Fixed host, no user-supplied URL: not an SSRF surface.
    if (!accessToken) return false;
    const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
    try {
      const res = await fetchImpl("https://api.github.com/user/emails", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "curf",
        },
      });
      if (!res.ok) return false;
      const rows = await res.json();
      if (!Array.isArray(rows)) return false;
      return rows.some((r: any) =>
        typeof r?.email === "string" && r.email.toLowerCase() === email.toLowerCase() && r.verified === true);
    } catch {
      return false;
    }
  }
  return false;
}

/** Decide an SSO sign-in. Never creates a workspace, an account or a membership. */
export async function resolveSsoSignIn(opts: {
  provider: string;
  email: string | null | undefined;
  name?: string | null;
  profile?: unknown;
  accessToken?: string | null;
  fetchImpl?: FetchLike;
}): Promise<SsoDecision> {
  const email = opts.email?.trim();
  if (!email) return { ok: false, reason: "email_unverified" };

  // Sign-in has no bound workspace, and this lookup is cross-workspace by
  // nature (one global account, memberships in any workspace).
  return withSystemDbContext(async () => {
    const row = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, emailVerifiedAt: true, passwordHash: true },
    });
    if (!row) return { ok: false, reason: "no_account" } as const;
    const memberships = await prisma.membership.findMany({
      where: { userId: row.id },
      orderBy: { createdAt: "asc" },
      select: { tenantId: true, role: true, tenant: { select: { status: true } } },
    });
    const verified = await providerVerifiedEmail({
      provider: opts.provider,
      email,
      profile: opts.profile,
      accessToken: opts.accessToken,
      fetchImpl: opts.fetchImpl,
    });
    if (!verified) {
      return { ok: false, reason: "email_unverified", userId: row.id, tenantIds: memberships.map((m) => m.tenantId) } as const;
    }
    if (memberships.length === 0) return { ok: false, reason: "no_account", userId: row.id } as const;
    // The oldest workspace that is still open; every one suspended = nowhere to land.
    const primary = memberships.find((m) => tenantOpen(m.tenant?.status));
    if (!primary) {
      return { ok: false, reason: "workspace_suspended", userId: row.id, tenantIds: memberships.map((m) => m.tenantId) } as const;
    }
    const data: { name?: string; emailVerifiedAt?: Date; passwordHash?: null; passwordChangedAt?: Date } = {};
    if (opts.name && opts.name !== row.name) data.name = opts.name;

    // The provider has now vouched for this address. If the account was
    // never verified, whoever created it may not be this person (someone can
    // register a stranger's address with a password before the owner ever
    // comes — "pre-registration takeover"), so the password they set is
    // removed and the sessions it opened are ended (passwordChangedAt). The
    // owner sets their own through "Forgot password" if they want one.
    let emailNewlyVerified = false;
    let passwordCleared = false;
    if (!row.emailVerifiedAt) {
      const now = new Date();
      data.emailVerifiedAt = now;
      emailNewlyVerified = true;
      if (row.passwordHash) {
        data.passwordHash = null;
        data.passwordChangedAt = now;
        passwordCleared = true;
      }
    }
    if (Object.keys(data).length > 0) await prisma.user.update({ where: { id: row.id }, data });

    return {
      ok: true, userId: row.id, email: row.email, tenantId: primary.tenantId, role: primary.role,
      emailNewlyVerified, passwordCleared,
    } as const;
  });
}
