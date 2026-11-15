/**
 * NextAuth config. Memberships model: one global `User` row per email
 * (id + passwordHash + preferences are shared across every workspace), and
 * a `Membership` row per workspace that email belongs to (role lives here,
 * per-tenant). The JWT itself only carries small scalars (id, tenantId,
 * activeTenantId, role, email, isPlatformAdmin) — `session.user.memberships`
 * is resolved fresh from the DB inside the session() callback on every
 * request instead, so the encrypted cookie doesn't grow with how many
 * workspaces a user belongs to. (It used to be baked into the token; for a
 * user with enough real Memberships that pushed the Set-Cookie header past
 * nginx's proxy_buffer_size, causing intermittent 502s on
 * /api/auth/session in production — see the jwt() callback below.)
 * `token.id` is the same value for every membership — it never changes when
 * switching workspaces, only `activeTenantId`/`role` do.
 *
 * Switching workspaces = call `useSession().update({ activeTenantId })` and
 * the jwt() callback re-resolves which Membership to expose. No re-login.
 *
 * API keys: `requireUser(req)` also accepts `Authorization: Bearer curf_...`.
 * When a valid key matches, the returned CurfSessionUser carries the key's
 * tenantId + role so every downstream tenant-scoped query works identically
 * to session auth. Minted at /admin/api-keys.
 */
import { NextRequest, NextResponse } from "next/server";
import type { NextAuthOptions } from "next-auth";
import { getServerSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import GitHubProvider from "next-auth/providers/github";
import { ee } from "@/ee";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { bindRequestDbContext, withSystemDbContext } from "@/lib/dbContext";
import { rateLimit } from "@/lib/rateLimit";
import { mustVerifyBeforeSignIn } from "@/lib/emailVerification";
import { tenantOpen } from "@/lib/tenantStatus";
import { isDemoAccountEmail } from "@/lib/demoAccount";

/** The error a password sign-in fails with when the account's email isn't verified yet. The login page matches on it. */
export const EMAIL_NOT_VERIFIED = "Email not verified";

/** The error a password sign-in fails with when every workspace the account belongs to has been suspended. */
export const WORKSPACE_SUSPENDED = "Workspace suspended";
/** Keycloak is the sign-in and this person must use it (already moved, the password window is over, or an organisation rule). */
export const USE_IDENTITY_PROVIDER = "Use single sign-on";

export type CurfMembership = {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  role: string;
  /**
   * Billing tier of the workspace, shown under its name in the nav rail.
   * Optional because a membership row can predate the field; the UI falls
   * back to the slug when it's absent.
   */
  tenantTier?: string;
  /**
   * "suspended" when a Curf operator has suspended the workspace
   * (lib/platform/tenants.ts), "pending_deletion" while its deletion grace
   * period runs (lib/lifecycle/deletion.ts) — anything but "active" is closed
   * (lib/tenantStatus.ts). A session never stays in one: session() moves it
   * to another workspace, or ends it when there is none.
   */
  tenantStatus?: string;
  /**
   * True for a workspace synthesized from OrgMembership(platform_admin)
   * oversight rather than a real Membership row — the person has never
   * joined this tenant, they can just see it because they're a Platform
   * Admin of its Organization. Consumers that iterate `memberships`
   * assuming each entry is a persisted row (e.g. anything writing back to
   * Membership by tenantId) must check this first. Omitted (not `false`)
   * for real memberships, so existing `m.isVirtual` truthy-checks are safe.
   */
  isVirtual?: boolean;
};

export type CurfSessionUser = {
  id: string;
  email: string;
  role: string;
  tenantId: string;
  name?: string;
  /** All workspaces this caller can switch into. Empty for API-key auth. */
  memberships?: CurfMembership[];
  /** Marked true when this user was resolved via an API key, not a session. */
  viaApiKey?: boolean;
  /** The ApiKey row id — set only when viaApiKey. */
  apiKeyId?: string;
  /**
   * Embedded-analytics productization (Roadmap Phase 3.2). Undefined for
   * session users and unscoped keys (existing behavior — full tenant
   * access at `role`'s level). When set, this key can only see the
   * listed report ids — see reportWhere() below.
   */
  scopedReportIds?: string[];
  /**
   * True for a Curf operator (see lib/platformAdmin.ts), computed
   * server-side from CURF_PLATFORM_ADMIN_EMAILS and baked into the JWT.
   * Client code must read THIS, never call isPlatformAdmin(email) itself
   * — that function reads a server-only env var, so calling it directly
   * in a "use client" component sees the real value during Next's SSR
   * pass and undefined once the same code runs in the browser bundle,
   * which is a guaranteed hydration mismatch on every page (the sidebar
   * gains/loses nav items between the two passes). Baking the boolean
   * into the session — fetched identically on server and client, exactly
   * like `role` — is what actually keeps it hydration-safe.
   */
  isPlatformAdmin?: boolean;
};

/**
 * The 4 per-workspace roles a Membership.role can hold. "platform_admin" is
 * deliberately NOT here — it's an OrgMembership-only concept (see
 * prisma/schema.prisma) and must never be accepted by this list, the SCIM
 * role mapping, or ApiKey.role. Every hardcoded role dropdown/zod-enum in
 * the app should import this instead of repeating the literal array.
 */
export const MEMBERSHIP_ROLES = ["admin", "developer", "executive", "viewer"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/**
 * Recompute every workspace this email belongs to. Called on signin and on
 * `update({})` from the client (post-invite-accept, post-create-workspace).
 * Exported so /api/memberships can share this instead of re-deriving it.
 */
async function loadMembershipsForUserId(userId: string): Promise<CurfMembership[]> {
  // Every workspace this person belongs to — cross-workspace by definition,
  // so never filtered to whichever one the request is bound to (BE-TEN-03);
  // under that filter the other workspaces vanished or came back "virtual".
  return withSystemDbContext(async () => {
    const rows = await prisma.membership.findMany({
      where: { userId },
      include: { tenant: { select: { id: true, slug: true, name: true, tier: true, status: true } } },
      orderBy: { createdAt: "asc" },
    });
    const real = rows.map((m: any) => ({
      tenantId: m.tenantId,
      tenantSlug: m.tenant.slug,
      tenantName: m.tenant.name,
      role: m.role,
      tenantTier: m.tenant.tier ?? undefined,
      tenantStatus: m.tenant.status ?? undefined,
    }));

    // Platform Admin oversight (Growth+, gated by featureGate("org.platform_admin")
    // at the point of USE — this list itself is harmless to compute broadly):
    // every tenant under an Organization this user holds "platform_admin"
    // OrgMembership for, synthesized as a virtual admin entry, minus any
    // tenant they already have a real Membership for above.
    const orgGrants = await prisma.orgMembership.findMany({
      where: { userId, role: "platform_admin" },
      select: { organizationId: true },
    });
    let virtual: CurfMembership[] = [];
    if (orgGrants.length > 0) {
      const realTenantIds = new Set(real.map((m) => m.tenantId));
      const orgTenants = await prisma.tenant.findMany({
        where: { organizationId: { in: orgGrants.map((g) => g.organizationId) } },
        select: { id: true, slug: true, name: true, tier: true, status: true },
      });
      virtual = orgTenants
        .filter((t) => !realTenantIds.has(t.id))
        .map((t) => ({ tenantId: t.id, tenantSlug: t.slug, tenantName: t.name, role: "admin", tenantTier: t.tier ?? undefined, tenantStatus: t.status ?? undefined, isVirtual: true }));
    }

    return [...real, ...virtual];
  });
}

export async function loadMembershipsForEmail(email: string): Promise<CurfMembership[]> {
  // The account row is global, one per email — see loadMembershipsForUserId.
  return withSystemDbContext(async () => {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) return [];
    return loadMembershipsForUserId(user.id);
  });
}

// How often the jwt() callback re-fetches role/tenant from the DB for an
// already-issued session token (see the callback below). Bounds the window
// during which a demoted/removed user's existing session keeps acting on
// their old privilege — without this, a JWT session (default maxAge 30
// days) would carry a stale role until it naturally expired or the user
// logged in again.
const ROLE_CHECK_INTERVAL_MS = 5 * 60_000;

/** The caller's address and browser for a session record. NextAuth's signIn callback has no request, so read the request's headers. */
async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    const fwd = h.get("x-forwarded-for")?.split(",")[0]?.trim();
    return { ip: fwd || h.get("x-real-ip"), userAgent: h.get("user-agent") };
  } catch {
    return { ip: null, userAgent: null };
  }
}

let cachedProviders: ReturnType<typeof buildProviders> | undefined;

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  // A getter, not a call: the providers include the paid edition's (ee.identity), and the ee registry imports modules that import
  // this one, so touching `ee` while this module is still loading is a "before initialization" error. NextAuth reads this per request.
  get providers() { return (cachedProviders ??= buildProviders()); },
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider === "keycloak" && ee.identity?.enabled()) {
        // Keycloak says who the person is and how strongly they proved it; Curf decides whether they get in and as whom
        // (src/ee/identity/signin.ts): linking by sub, org policy (SSO, MFA), no membership from a domain match alone.
        const meta = await requestMeta();
        const decision = await ee.identity.signIn({ profile, ip: meta.ip, userAgent: meta.userAgent });
        if (!decision.ok) {
          if (decision.userId && decision.tenantIds?.length) {
            const { recordAudit } = await import("@/lib/audit");
            for (const tenantId of decision.tenantIds) {
              recordAudit({
                tenantId, userId: decision.userId, userEmail: user?.email ?? undefined, kind: "signin.failed",
                meta: { reason: `keycloak_${decision.reason}`, provider: "keycloak", organizationId: decision.organizationId ?? null },
              });
            }
          }
          return `/login?error=sso_${decision.reason}`;
        }
        const { recordAudit } = await import("@/lib/audit");
        if (decision.linked || decision.created || decision.joinedTenantIds.length > 0 || decision.emailNewlyVerified) {
          recordAudit({
            tenantId: decision.tenantId, userId: decision.userId, userEmail: decision.email, kind: "identity.linked", target: decision.userId,
            meta: { provider: "keycloak", linked: decision.linked, created: decision.created, joinedTenantIds: decision.joinedTenantIds, emailNewlyVerified: decision.emailNewlyVerified, passwordCleared: decision.passwordCleared },
          });
        }
        (user as any).id = decision.userId;
        (user as any).email = decision.email;
        (user as any).role = decision.role;
        (user as any).tenantId = decision.tenantId;
        (user as any).sid = decision.sid;
        (user as any).acr = decision.acr;
        return true;
      }
      if (account && account.provider !== "credentials" && account.provider !== "keycloak") {
        // Google / GitHub reach only an existing account that already belongs
        // to a workspace, and only with a provider-verified email. It never
        // creates a workspace or a membership — see lib/ssoSignIn.ts for why
        // the old email-domain workspace was removed.
        const { resolveSsoSignIn } = await import("@/lib/ssoSignIn");
        const decision = await resolveSsoSignIn({
          provider: account.provider,
          email: user?.email,
          name: user?.name,
          profile,
          accessToken: account.access_token,
        });
        if (!decision.ok) {
          if (decision.userId && decision.tenantIds?.length) {
            const { recordAudit } = await import("@/lib/audit");
            for (const tenantId of decision.tenantIds) {
              recordAudit({
                tenantId,
                userId: decision.userId,
                userEmail: user?.email ?? undefined,
                kind: "signin.failed",
                meta: { reason: `sso_${decision.reason}`, provider: account.provider },
              });
            }
          }
          return `/login?error=sso_${decision.reason}`;
        }
        if (decision.emailNewlyVerified) {
          const { recordAudit } = await import("@/lib/audit");
          recordAudit({
            tenantId: decision.tenantId,
            userId: decision.userId,
            userEmail: decision.email,
            kind: "email.verified",
            target: decision.userId,
            meta: { via: account.provider, passwordCleared: decision.passwordCleared },
          });
        }
        (user as any).id = decision.userId;
        (user as any).email = decision.email;
        (user as any).role = decision.role;
        (user as any).tenantId = decision.tenantId;
      }
      return true;
    },
    async jwt({ token, user, trigger, session }) {
      // First sign-in: stash the user's home-tenant identity. The full
      // membership list is deliberately NOT stored here — see session()
      // below, which resolves it fresh from the DB on every request instead
      // of baking it into the encrypted cookie. A user with enough
      // workspaces (real Memberships, or Platform Admin oversight of many
      // Organizations' tenants) pushed the JWT's Set-Cookie header past
      // nginx's proxy_buffer_size, causing intermittent 502 "upstream sent
      // too big header" failures on /api/auth/session in production
      // (2026-09-17) — the cookie must stay small regardless of how many
      // workspaces any one user ends up with.
      if (user) {
        (token as any).id = (user as any).id;
        // When this session authenticated — kept across token refreshes
        // (NextAuth re-issues iat), compared with the account's
        // passwordChangedAt on the periodic re-check below.
        (token as any).authAt = Date.now();
        (token as any).role = (user as any).role;
        (token as any).tenantId = (user as any).tenantId;
        (token as any).activeTenantId = (user as any).tenantId;
        (token as any).roleCheckedAt = Date.now();
        // Keycloak sign-in: the session id (what a back-channel logout names) and the level of authentication.
        if ((user as any).sid) { (token as any).sid = (user as any).sid; (token as any).acr = (user as any).acr; }
        if ((user as any).email) {
          (token as any).email = (user as any).email;
          const { isPlatformAdmin } = await import("@/lib/platformAdmin");
          (token as any).isPlatformAdmin = isPlatformAdmin((user as any).email);
        }
      }
      // Client-driven updates from `useSession().update(...)`. Membership
      // list itself is no longer cached on the token, so a switch just
      // needs to confirm the target tenant is one of this user's current
      // memberships before adopting it.
      if (trigger === "update" && session) {
        const next = session as any;
        if (next.activeTenantId && (token as any).id) {
          const current = await loadMembershipsForUserId((token as any).id);
          const m = current.find((m) => m.tenantId === next.activeTenantId);
          // Never switch into a suspended workspace.
          if (m && tenantOpen(m.tenantStatus)) {
            // token.id is unchanged — one identity, every workspace.
            (token as any).activeTenantId = m.tenantId;
            (token as any).role = m.role;
            (token as any).tenantId = m.tenantId;
          }
        }
      }
      // Backfill email/isPlatformAdmin for tokens issued before those fields
      // existed on the token (or before this fix, when email was only set
      // conditionally on `user.email`).
      if (!(token as any).email && (token as any).id) {
        const u = await prisma.user.findUnique({
          where: { id: (token as any).id },
          select: { email: true },
        });
        if (u?.email) {
          (token as any).email = u.email;
          const { isPlatformAdmin } = await import("@/lib/platformAdmin");
          (token as any).isPlatformAdmin = isPlatformAdmin(u.email);
        }
      }

      // Periodic re-validation, every ROLE_CHECK_INTERVAL_MS: confirm the
      // Membership backing the token's current (id, tenantId) pair still
      // exists and re-sync its role. Two distinct "this session should no
      // longer work" cases, both indistinguishable from "no row" by a plain
      // findUnique on Membership, so they're told apart explicitly:
      //   - the User row itself is gone (account deleted) -> sign out fully
      //   - just THIS workspace's Membership was removed -> fall back to
      //     another membership the user still has, or sign out if none left
      const lastChecked = (token as any).roleCheckedAt ?? 0;
      if ((token as any).id && Date.now() - lastChecked > ROLE_CHECK_INTERVAL_MS) {
        // Every lookup below answers "is there a row?" — so a lookup that
        // FAILED must not be read as "no". Each one used to .catch(() =>
        // null), which turned a transient DB error into "this membership
        // was removed" (silently moving the user into another workspace,
        // where their next action lands on the wrong tenant's data) or,
        // on a second failed query, "this account was deleted" (signing
        // them out). A failed check now changes nothing and doesn't
        // advance roleCheckedAt, so the next request simply retries it.
        try {
          const membership = await prisma.membership.findUnique({
            where: { userId_tenantId: { userId: (token as any).id, tenantId: (token as any).tenantId } },
            select: { role: true },
          });
          if (membership) {
            (token as any).role = membership.role;
          } else {
            const stillExists = await prisma.user.findUnique({
              where: { id: (token as any).id },
              select: { id: true },
            });
            if (!stillExists) {
              // jwt() itself has no supported way to force sign-out — but
              // tenantWhere()/requireUser() do NOT independently re-check
              // that the row still exists (they trust the token's own
              // id/tenantId), so leaving those fields alone here would let a
              // deleted user's stolen cookie keep working for the rest of
              // the JWT's lifetime. Mark it instead; session() below turns
              // that into an unauthenticated session.
              (token as any).deleted = true;
            } else {
              // No real Membership for this tenant doesn't automatically mean
              // "revoked" — it might be virtual (Platform Admin oversight of
              // a tenant they never joined, see loadMembershipsForUserId()).
              // Check that BEFORE falling back, or every Platform Admin
              // viewing an org-derived tenant gets silently bounced back to
              // fresh[0] on this exact 5-minute tick.
              const currentTenant = await prisma.tenant.findUnique({
                where: { id: (token as any).tenantId },
                select: { organizationId: true },
              });
              const orgGrant = currentTenant?.organizationId
                ? await prisma.orgMembership.findUnique({
                    where: { userId_organizationId: { userId: (token as any).id, organizationId: currentTenant.organizationId } },
                  })
                : null;
              if (orgGrant?.role === "platform_admin") {
                // Virtual access still holds — stay on this tenant, just
                // refresh the role (always "admin" while switched into it).
                (token as any).role = "admin";
              } else {
                const fresh = await loadMembershipsForUserId((token as any).id);
                if (fresh.length > 0) {
                  (token as any).activeTenantId = fresh[0].tenantId;
                  (token as any).tenantId = fresh[0].tenantId;
                  (token as any).role = fresh[0].role;
                } else {
                  (token as any).deleted = true;
                }
              }
            }
          }
          // A password reset signs out every session authenticated before it
          // — the point of resetting a password someone else may know.
          const account = await prisma.user.findUnique({
            where: { id: (token as any).id },
            select: { passwordChangedAt: true },
          });
          if (account?.passwordChangedAt && account.passwordChangedAt.getTime() > ((token as any).authAt ?? 0)) {
            (token as any).deleted = true;
          }
          // A Keycloak-backed session also ends when it is revoked (back-channel logout, "sign out everywhere"), or goes past
          // the organisation's idle or maximum-age limit (src/ee/identity/session.ts).
          if ((token as any).sid && ee.identity) {
            const verdict = await ee.identity.checkSession((token as any).sid, (token as any).id);
            if (verdict !== "ok") (token as any).deleted = true;
          }
          (token as any).roleCheckedAt = Date.now();
        } catch (e: any) {
          console.warn("[auth] periodic membership re-check failed; keeping the session as-is and retrying next request:", e?.message ?? e);
        }
      }

      return token;
    },
    async session({ session, token }) {
      if ((token as any).deleted) {
        // Strip identity so requireUser()'s `if (!u.tenantId) return null`
        // treats this exactly like "not signed in" server-side.
        (session.user as any).id = undefined;
        (session.user as any).tenantId = undefined;
        return session;
      }
      // Resolved fresh from the DB every request rather than cached on the
      // token — see the top-of-file comment for why it can't live in the
      // cookie.
      const memberships = (token as any).id ? await loadMembershipsForUserId((token as any).id) : [];
      let tenantId = (token as any).tenantId;
      let role = (token as any).role;
      let activeTenantId = (token as any).activeTenantId ?? (token as any).tenantId;
      // A suspended workspace is closed to everyone in it, at once (not at the
      // next 5-minute re-check): the session moves to a workspace that is
      // still open, or — with none — carries no identity, which requireUser()
      // treats as "not signed in". Same shape as a removed membership.
      const current = memberships.find((m) => m.tenantId === tenantId);
      if (current && !tenantOpen(current.tenantStatus)) {
        const open = memberships.find((m) => tenantOpen(m.tenantStatus) && !m.isVirtual) ?? memberships.find((m) => tenantOpen(m.tenantStatus));
        if (!open) {
          (session.user as any).id = undefined;
          (session.user as any).tenantId = undefined;
          return session;
        }
        tenantId = open.tenantId;
        role = open.role;
        activeTenantId = open.tenantId;
      }
      (session.user as any).id = (token as any).id;
      (session.user as any).role = role;
      (session.user as any).tenantId = tenantId;
      (session.user as any).memberships = memberships;
      (session.user as any).activeTenantId = activeTenantId;
      (session.user as any).isPlatformAdmin = !!(token as any).isPlatformAdmin;
      return session;
    },
  },
  pages: { signIn: "/login" },
  events: {
    async signIn({ user, account }) {
      const { recordAudit } = await import("@/lib/audit");
      const u = user as any;
      if (!u?.tenantId) return;
      recordAudit({
        tenantId: u.tenantId,
        userId: u.id,
        userEmail: u.email,
        kind: "signin",
        meta: { provider: account?.provider ?? "credentials" },
      });
    },
    async signOut({ token }) {
      const { recordAudit } = await import("@/lib/audit");
      const t = token as any;
      if (t?.sid && ee.identity) await ee.identity.revokeSessions({ sid: t.sid }).catch(() => null);
      if (!t?.tenantId) return;
      recordAudit({
        tenantId: t.tenantId,
        userId: t.id,
        userEmail: t.email,
        kind: "signout",
      });
    },
  },
};

/**
 * The session, for DISPLAY only — the root layout's SessionProvider, a
 * "signed in?" check on a public page. Unlike getSession() it does not tie
 * the request to the user's workspace, so a public page rendering another
 * workspace's data (a share link, a public app) isn't filtered to the
 * visitor's own. Anything acting on the user's behalf uses getSession() or
 * requireUser().
 */
export async function readSession() {
  // Resolving a session reads the user's memberships in EVERY workspace
  // (the switcher, the periodic role re-check) — cross-workspace by design,
  // so it runs with no workspace filter even when this request is already
  // bound to one.
  return withSystemDbContext(() => getServerSession(authOptions));
}

/** The signed-in session, with the rest of this request's database work
 *  bound to the user's workspace (row-level security, BE-TEN-03). */
export async function getSession() {
  const session = await readSession();
  const u = session?.user as any;
  if (u?.tenantId) bindRequestDbContext({ tenantId: u.tenantId, userId: u.id, role: u.role });
  return session;
}

/**
 * Look up the current caller. Accepts either a NextAuth session cookie or a
 * `curf_...` API key in the Authorization header. Returns null when neither
 * is present or the key is invalid/revoked/expired.
 */
/**
 * Parse an ApiKey.scopedReportIds column value into the allowlist
 * `requireUser()` attaches to the session. `null`/`""` (column unset) means
 * "unscoped key" and returns undefined — every consumer (reportWhere(),
 * reports/[id]/route.ts) treats undefined as "no restriction". A
 * NON-empty column means the key WAS minted with an allowlist, so a
 * malformed/wrong-shape value must fail closed to `[]` (matches zero
 * reports) rather than undefined — falling through to "unscoped" would
 * silently widen a restricted key to full tenant access.
 */
export function parseScopedReportIds(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function requireUser(req?: NextRequest): Promise<CurfSessionUser | null> {
  // 1. API-key path (explicit header beats implicit cookie).
  const auth = req?.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer curf_")) {
    const token = auth.slice("Bearer ".length);
    const prefix = token.slice(0, 12);
    const row = await prisma.apiKey.findFirst({
      where: {
        prefix,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: { tenant: { select: { status: true } } },
    });
    if (!row) return null;
    const ok = await bcrypt.compare(token, row.hashedSecret);
    if (!ok) return null;
    // A suspended workspace's keys stop working at once (lib/platform/tenants.ts).
    if (!tenantOpen(row.tenant?.status)) return null;
    // Usage metering (Phase 3.2) rides the same best-effort update as the
    // existing lastUsedAt touch — one write, not two, and a metering
    // failure (or a slow write under load) never blocks the request since
    // it's fire-and-forget like lastUsedAt already was.
    prisma.apiKey.update({
      where: { id: row.id },
      data: { lastUsedAt: new Date(), requestCount: { increment: 1 } },
    }).catch(() => null);
    const scopedReportIds = parseScopedReportIds(row.scopedReportIds);
    bindRequestDbContext({ tenantId: row.tenantId, userId: "apikey:" + row.id, role: row.role });
    return {
      id: "apikey:" + row.id,
      email: "apikey+" + row.prefix + "@curf.local",
      role: row.role,
      tenantId: row.tenantId,
      name: row.name,
      viaApiKey: true,
      apiKeyId: row.id,
      scopedReportIds,
    };
  }

  // 2. Session-cookie path.
  const session = await getSession();
  if (!session?.user) return null;
  const u = session.user as any;
  if (!u.tenantId) return null;
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    tenantId: u.tenantId,
    name: u.name,
    memberships: u.memberships ?? [],
  };
}

/** Shorthand: `where: tenantWhere(user)` scopes any query to the session tenant. */
export function tenantWhere(user: CurfSessionUser): { tenantId: string } {
  return { tenantId: user.tenantId };
}

/**
 * Report-specific variant of tenantWhere() that also honors an API key's
 * scopedReportIds (Phase 3.2). Every session user and every unscoped key
 * gets exactly tenantWhere()'s behavior — this only narrows further when
 * the caller is a key minted with a specific report allowlist.
 */
export function reportWhere(user: CurfSessionUser): { tenantId: string; id?: { in: string[] } } {
  return {
    ...tenantWhere(user),
    ...(user.scopedReportIds ? { id: { in: user.scopedReportIds } } : {}),
  };
}

/**
 * Guard for every `/api/reports/[id]/**` route that looks its report up by
 * a hand-rolled `{ id: params.id, tenantId: user.tenantId }` (or
 * `{ reportId: params.id, tenantId: user.tenantId }` on a child table)
 * instead of `reportWhere(user)` — reportWhere()'s `id: { in: [...] }`
 * shape only applies to a query filtering by the REPORT's own id, so it
 * can't be spread into a query on a child resource without accidentally
 * filtering that resource's own `id` column instead (OWASP A01:2025).
 *
 * Call this once, right after resolving `user`, before any DB query, with
 * the report id from `params.id`. A session user or an unscoped key always
 * passes (null); a key minted with a report allowlist gets 404 — not 403 —
 * for a report outside it, matching reports/[id]/route.ts's existing
 * checks: a scoped key shouldn't be able to distinguish "not yours" from
 * "doesn't exist" by probing ids.
 */
export function requireReportInScope(user: CurfSessionUser, reportId: string): NextResponse | null {
  if (user.scopedReportIds && !user.scopedReportIds.includes(reportId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}

/**
 * Blocks a report-scoped API key (Phase 3.2) from resources that have no
 * report id to narrow against — metrics, decisions, notebooks, dashboards,
 * etc. Unlike reportWhere(), there's nothing here for the key's allowlist
 * to filter down to, so a scoped key is rejected outright rather than
 * silently getting tenant-wide access to data types it was never scoped
 * to see. Every session user and every unscoped key passes through (null).
 */
export function blockScopedApiKey(user: CurfSessionUser): NextResponse | null {
  if (!user.scopedReportIds) return null;
  return NextResponse.json(
    { error: "This API key is scoped to specific reports and cannot access this resource." },
    { status: 403 },
  );
}

/**
 * requireUser() + an admin-role gate in one call. Mirrors ensureLimit()'s
 * shape: `const user = await requireAdmin(req); if (user instanceof
 * NextResponse) return user;`
 *
 * Always 401 when there's no session, 403 when there is one but it isn't
 * admin — some older call sites folded both cases into a single 403 before
 * this helper existed, which meant a client couldn't tell "log in" apart
 * from "you're logged in but not allowed."
 */
export async function requireAdmin(req?: NextRequest): Promise<CurfSessionUser | NextResponse> {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "Admin only" }, { status: 403 });
  // A report-scoped key is limited to its allowlisted reports; admin routes
  // (minting keys, managing members, connections) are outside that mandate.
  const scoped = blockScopedApiKey(user);
  if (scoped) return scoped;
  return user;
}

/** Same as requireAdmin(), but also accepts the developer role (née "editor" — same permissions, renamed). */
export async function requireAdminOrEditor(req?: NextRequest): Promise<CurfSessionUser | NextResponse> {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "developer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const scoped = blockScopedApiKey(user);
  if (scoped) return scoped;
  return user;
}

// -------------- SSO providers (conditional) --------------

function buildProviders() {
  const list: any[] = [
    Credentials({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials.password) return null;
        // Keycloak is the only sign-in: a password here is for the anonymous demo visitors' throwaway accounts and nobody else
        // (same answer for every other address, so it says nothing about who has an account).
        if (ee.identity?.only() && !isDemoAccountEmail(credentials.email)) throw new Error(USE_IDENTITY_PROVIDER);
        // Brute-force / credential-stuffing throttle, keyed per email so
        // one attacker guessing many accounts can't exhaust a single
        // shared bucket. 10 attempts/5min is generous for a mistyped
        // password, tight for a guessing loop.
        const limitResult = await rateLimit(`login:${credentials.email.toLowerCase()}`, 10, 5 * 60_000);
        if (!limitResult.ok) throw new Error("Too many attempts. Try again in a few minutes.");
        // email is globally unique now — deterministic, unlike the old
        // per-tenant findFirst that could hit any one of several rows for
        // the same email with no defined order.
        const user = await prisma.user.findUnique({ where: { email: credentials.email } });
        if (!user || !user.passwordHash) return null;
        const memberships = await prisma.membership.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: "asc" },
          select: { tenantId: true, role: true, tenant: { select: { status: true } } },
        });
        const ok = await bcrypt.compare(credentials.password, user.passwordHash);
        if (!ok) {
          // OWASP A09:2025 — this was the one signin.failed kind declared
          // in lib/audit.ts that nothing ever actually recorded, so a
          // credential-stuffing run against a real account left zero trail.
          // One account can now span several workspaces, so the failed
          // attempt is logged against every one of them — each tenant's
          // own A09 alert only fires for its own admins regardless.
          const { recordAudit } = await import("@/lib/audit");
          for (const m of memberships) {
            recordAudit({
              tenantId: m.tenantId,
              userId: user.id,
              userEmail: user.email,
              kind: "signin.failed",
              meta: { reason: "bad_password" },
            });
          }
          return null;
        }
        // Right password, but the address was never proven: a new account
        // can't sign in with a password until it follows the mailed link
        // (lib/emailVerification.ts). Checked after the password so this
        // message only reaches someone who knows it, and says nothing to a
        // stranger probing for accounts. Accounts from before the feature
        // are exempt, and nobody is held back where the platform can't send
        // the link.
        if (mustVerifyBeforeSignIn(user)) {
          const { recordAudit } = await import("@/lib/audit");
          for (const m of memberships) {
            recordAudit({
              tenantId: m.tenantId,
              userId: user.id,
              userEmail: user.email,
              kind: "signin.failed",
              meta: { reason: "email_unverified" },
            });
          }
          throw new Error(EMAIL_NOT_VERIFIED);
        }
        // Keycloak is the sign-in here: a local password works only inside the migration window, for an account not yet moved,
        // and never where an organisation the person belongs to enforces SSO or MFA (src/ee/identity/migrate.ts).
        // A demo visitor's throwaway account (lib/demoAccount.ts) is never moved into Keycloak: it has no person behind it.
        if (ee.identity?.enabled() && !isDemoAccountEmail(user.email)) {
          const verdict = await ee.identity.passwordSignIn({ id: user.id, email: user.email, name: user.name, identityMigratedAt: user.identityMigratedAt }, credentials.password);
          if (verdict !== "ok") {
            const { recordAudit } = await import("@/lib/audit");
            for (const m of memberships) {
              recordAudit({ tenantId: m.tenantId, userId: user.id, userEmail: user.email, kind: "signin.failed", meta: { reason: "use_identity_provider" } });
            }
            throw new Error(USE_IDENTITY_PROVIDER);
          }
        }
        // No membership left (account exists, e.g. removed from every
        // workspace) — there's nothing to log in TO.
        if (memberships.length === 0) return null;
        // Land in the oldest workspace that is still open. When every one of
        // them has been suspended there is nothing to open — say so, after
        // the password, rather than letting the person in to a wall.
        const primary = memberships.find((m) => tenantOpen(m.tenant?.status));
        if (!primary) {
          const { recordAudit } = await import("@/lib/audit");
          for (const m of memberships) {
            recordAudit({ tenantId: m.tenantId, userId: user.id, userEmail: user.email, kind: "signin.failed", meta: { reason: "workspace_suspended" } });
          }
          throw new Error(WORKSPACE_SUSPENDED);
        }
        return {
          id: user.id,
          email: user.email,
          name: user.name ?? undefined,
          role: primary.role,
          tenantId: primary.tenantId,
        } as any;
      },
    }),
  ];
  // Google and GitHub are Keycloak's to broker when Keycloak is the only sign-in (realm identity providers, k8s/keycloak/realm);
  // Curf registers them itself only otherwise.
  if (!ee.identity?.only()) {
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
      list.push(GoogleProvider({
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      }));
    }
    if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
      list.push(GitHubProvider({
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      }));
    }
  }
  // Keycloak sign-in (CURF_AUTH=keycloak), from the paid edition's identity module; none in Community.
  list.push(...(ee.identity?.providers() ?? []));
  return list;
}

/** Keycloak is the sign-in (CURF_AUTH=keycloak and configured): the login page offers it. */
export function keycloakSignInEnabled(): boolean {
  return !!ee.identity?.enabled();
}

/** Keycloak is the only sign-in: no password form, no Google/GitHub of Curf's own (demo visitors aside, see lib/demoAccount.ts). */
export function keycloakOnlySignIn(): boolean {
  return !!ee.identity?.enabled() && !!ee.identity.only();
}

export function enabledSsoProviders(): Array<"google" | "github" | "keycloak"> {
  const out: Array<"google" | "github" | "keycloak"> = [];
  if (ee.identity?.enabled()) out.push("keycloak");
  if (keycloakOnlySignIn()) return out;
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) out.push("google");
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) out.push("github");
  return out;
}

/** What the login pages need: which buttons, whether the password form is offered, and which social sign-ins go through Keycloak. */
export function signInOptions(): { providers: string[]; passwordLogin: boolean; brokered: string[]; companySso: boolean } {
  // companySso: the login page may ask for a work email and send the person to their company's own provider (Keycloak is on).
  return { providers: enabledSsoProviders(), passwordLogin: !keycloakOnlySignIn(), brokered: keycloakOnlySignIn() ? (ee.identity?.brokered() ?? []) : [], companySso: !!ee.identity?.enabled() };
}

// -------------- RBAC helpers --------------

export async function getUserRoles(): Promise<string[]> {
  const user = await requireUser();
  if (!user || user.viaApiKey) return [];
  // Custom roles (rolesJson) are per-workspace now — read the Membership
  // for the caller's currently-active tenant, not the (now tenant-less)
  // User row.
  const row = await prisma.membership.findUnique({
    where: { userId_tenantId: { userId: user.id, tenantId: user.tenantId } },
    select: { rolesJson: true },
  });
  return memberRoleSlugs(user.role, row?.rolesJson);
}

/** The custom role slugs a member holds in one workspace: their Membership's
 *  rolesJson, plus "executive" for an executive. Pure, so a caller with no
 *  session (a scheduled delivery rendering as its creator) resolves roles
 *  the same way getUserRoles() does. */
export function memberRoleSlugs(role: string, rolesJson: string | null | undefined): string[] {
  const merged: string[] = [];
  try {
    const parsed = JSON.parse(rolesJson ?? "[]");
    if (Array.isArray(parsed)) merged.push(...parsed);
  } catch { /* ignore */ }
  // "executive" is deliberately the ONLY auth-tier role folded into the
  // custom-slug set here — NOT a blanket union of [user.role, ...rolesJson].
  // rolesJson slugs are free-text per tenant (via /admin/roles); a tenant
  // could coincidentally have a custom role literally named "developer" or
  // "viewer" for something unrelated, and a generic union would silently
  // grant every Developer/Viewer that tenant's visibleToRoles content —
  // a real, not hypothetical, content-visibility regression. "executive"
  // is the one deliberate merge (see prisma/schema.prisma's Membership
  // comment + the 2026-08 role restructure).
  if (role === "executive" && !merged.includes("executive")) merged.push("executive");
  return merged;
}

export async function hasRole(slug: string): Promise<boolean> {
  const roles = await getUserRoles();
  return roles.includes(slug);
}

export function filterBlocksForRoles<T extends { visibleToRoles?: string[] }>(
  blocks: T[],
  userRoles: string[],
  isAdmin: boolean,
): { visible: T[]; hiddenCount: number } {
  if (isAdmin) return { visible: blocks, hiddenCount: 0 };
  const mine = new Set(userRoles);
  const visible = blocks.filter((b) => {
    const gated = Array.isArray(b.visibleToRoles) && b.visibleToRoles.length > 0;
    if (!gated) return true;
    return b.visibleToRoles!.some((r) => mine.has(r));
  });
  return { visible, hiddenCount: blocks.length - visible.length };
}
