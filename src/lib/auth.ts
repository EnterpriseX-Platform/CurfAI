/**
 * NextAuth config. Memberships model: one global `User` row per email
 * (id + passwordHash + preferences are shared across every workspace), and
 * a `Membership` row per workspace that email belongs to (role lives here,
 * per-tenant). The JWT carries the full membership list as `memberships`,
 * plus an `activeTenantId` that identifies which one the current request
 * runs against. `token.id` is the same value for every membership — it
 * never changes when switching workspaces, only `activeTenantId`/`role` do.
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
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/rateLimit";

export type CurfMembership = {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  role: string;
  /**
   * Billing tier of the workspace, shown under its name in the nav rail.
   * Optional because tokens issued before the field existed don't carry it
   * until the next `refreshMemberships` update (the switcher fires one every
   * time it opens), and the UI falls back to the slug meanwhile.
   */
  tenantTier?: string;
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
  const rows = await prisma.membership.findMany({
    where: { userId },
    include: { tenant: { select: { id: true, slug: true, name: true, tier: true } } },
    orderBy: { createdAt: "asc" },
  });
  const real = rows.map((m: any) => ({
    tenantId: m.tenantId,
    tenantSlug: m.tenant.slug,
    tenantName: m.tenant.name,
    role: m.role,
    tenantTier: m.tenant.tier ?? undefined,
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
      select: { id: true, slug: true, name: true, tier: true },
    });
    virtual = orgTenants
      .filter((t) => !realTenantIds.has(t.id))
      .map((t) => ({ tenantId: t.id, tenantSlug: t.slug, tenantName: t.name, role: "admin", tenantTier: t.tier ?? undefined, isVirtual: true }));
  }

  return [...real, ...virtual];
}

export async function loadMembershipsForEmail(email: string): Promise<CurfMembership[]> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return [];
  return loadMembershipsForUserId(user.id);
}

// How often the jwt() callback re-fetches role/tenant from the DB for an
// already-issued session token (see the callback below). Bounds the window
// during which a demoted/removed user's existing session keeps acting on
// their old privilege — without this, a JWT session (default maxAge 30
// days) would carry a stale role until it naturally expired or the user
// logged in again.
const ROLE_CHECK_INTERVAL_MS = 5 * 60_000;

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  providers: buildProviders(),
  callbacks: {
    async signIn({ user, account }) {
      if (account && account.provider !== "credentials" && user?.email) {
        const domain = user.email.split("@")[1] ?? "default";
        let tenant = await prisma.tenant.upsert({
          where: { slug: domain.toLowerCase() },
          update: {},
          create: { slug: domain.toLowerCase(), name: domain },
        });
        // Every tenant needs an Organization (Growth+ Platform Admin
        // oversight reads Tenant.organizationId — see
        // loadMembershipsForUserId()) — lazily attach one if this tenant
        // predates that, or was just created above. Whoever establishes it
        // becomes its Platform Admin, same rule as /api/signup.
        let orgJustCreated = false;
        if (!tenant.organizationId) {
          const org = await prisma.organization.create({
            data: { slug: tenant.slug, name: tenant.name, accountType: "individual" },
          }).catch(() =>
            prisma.organization.create({
              data: { slug: `${tenant.slug}-${Date.now().toString(36)}`, name: tenant.name, accountType: "individual" },
            }),
          );
          tenant = await prisma.tenant.update({ where: { id: tenant.id }, data: { organizationId: org.id } });
          orgJustCreated = true;
        }
        // One global account per email — find it, or create it. A row that
        // already exists (from a different workspace, or a prior credentials
        // signup) keeps its passwordHash untouched; only `name` is refreshed.
        let row = await prisma.user.findUnique({ where: { email: user.email } });
        if (!row) {
          row = await prisma.user.create({ data: { email: user.email, name: user.name ?? undefined } });
        } else if (user.name && user.name !== row.name) {
          row = await prisma.user.update({ where: { id: row.id }, data: { name: user.name } });
        }
        const membership = await prisma.membership.upsert({
          where: { userId_tenantId: { userId: row.id, tenantId: tenant.id } },
          update: {},
          create: { userId: row.id, tenantId: tenant.id, role: "developer" },
        });
        if (orgJustCreated) {
          await prisma.orgMembership.upsert({
            where: { userId_organizationId: { userId: row.id, organizationId: tenant.organizationId! } },
            update: {},
            create: { userId: row.id, organizationId: tenant.organizationId!, role: "platform_admin" },
          });
        }
        (user as any).id = row.id;
        (user as any).role = membership.role;
        (user as any).tenantId = tenant.id;
      }
      return true;
    },
    async jwt({ token, user, trigger, session }) {
      // First sign-in: stash the user's home-tenant identity AND the full
      // membership list so the switcher is populated immediately.
      if (user) {
        (token as any).id = (user as any).id;
        (token as any).role = (user as any).role;
        (token as any).tenantId = (user as any).tenantId;
        (token as any).activeTenantId = (user as any).tenantId;
        (token as any).roleCheckedAt = Date.now();
        if ((user as any).email) {
          (token as any).memberships = await loadMembershipsForEmail((user as any).email);
          const { isPlatformAdmin } = await import("@/lib/platformAdmin");
          (token as any).isPlatformAdmin = isPlatformAdmin((user as any).email);
        }
      }
      // Client-driven updates from `useSession().update(...)`.
      if (trigger === "update" && session) {
        const next = session as any;
        if (next.activeTenantId && Array.isArray((token as any).memberships)) {
          const m = (token as any).memberships.find((m: CurfMembership) => m.tenantId === next.activeTenantId);
          if (m) {
            // token.id is unchanged — one identity, every workspace.
            (token as any).activeTenantId = m.tenantId;
            (token as any).role = m.role;
            (token as any).tenantId = m.tenantId;
          }
        }
        if (next.refreshMemberships && (token as any).email) {
          (token as any).memberships = await loadMembershipsForEmail((token as any).email);
        }
      }
      // Cache email on the token so refreshMemberships works without DB lookup.
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
        const membership = await prisma.membership.findUnique({
          where: { userId_tenantId: { userId: (token as any).id, tenantId: (token as any).tenantId } },
          select: { role: true },
        }).catch(() => null);
        if (membership) {
          (token as any).role = membership.role;
        } else {
          const stillExists = await prisma.user.findUnique({
            where: { id: (token as any).id },
            select: { id: true },
          }).catch(() => null);
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
            }).catch(() => null);
            const orgGrant = currentTenant?.organizationId
              ? await prisma.orgMembership.findUnique({
                  where: { userId_organizationId: { userId: (token as any).id, organizationId: currentTenant.organizationId } },
                }).catch(() => null)
              : null;
            if (orgGrant?.role === "platform_admin") {
              // Virtual access still holds — stay on this tenant, just
              // refresh the role (always "admin" while switched into it).
              (token as any).role = "admin";
            } else {
              const fresh = await loadMembershipsForUserId((token as any).id);
              (token as any).memberships = fresh;
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
        (token as any).roleCheckedAt = Date.now();
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
      (session.user as any).id = (token as any).id;
      (session.user as any).role = (token as any).role;
      (session.user as any).tenantId = (token as any).tenantId;
      (session.user as any).memberships = (token as any).memberships ?? [];
      (session.user as any).activeTenantId = (token as any).activeTenantId ?? (token as any).tenantId;
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

export async function getSession() {
  return getServerSession(authOptions);
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
    });
    if (!row) return null;
    const ok = await bcrypt.compare(token, row.hashedSecret);
    if (!ok) return null;
    // Usage metering (Phase 3.2) rides the same best-effort update as the
    // existing lastUsedAt touch — one write, not two, and a metering
    // failure (or a slow write under load) never blocks the request since
    // it's fire-and-forget like lastUsedAt already was.
    prisma.apiKey.update({
      where: { id: row.id },
      data: { lastUsedAt: new Date(), requestCount: { increment: 1 } },
    }).catch(() => null);
    const scopedReportIds = parseScopedReportIds(row.scopedReportIds);
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
  return user;
}

/** Same as requireAdmin(), but also accepts the developer role (née "editor" — same permissions, renamed). */
export async function requireAdminOrEditor(req?: NextRequest): Promise<CurfSessionUser | NextResponse> {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "developer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
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
        // Brute-force / credential-stuffing throttle, keyed per email so
        // one attacker guessing many accounts can't exhaust a single
        // shared bucket. 10 attempts/5min is generous for a mistyped
        // password, tight for a guessing loop.
        const limitResult = rateLimit(`login:${credentials.email.toLowerCase()}`, 10, 5 * 60_000);
        if (!limitResult.ok) throw new Error("Too many attempts. Try again in a few minutes.");
        // email is globally unique now — deterministic, unlike the old
        // per-tenant findFirst that could hit any one of several rows for
        // the same email with no defined order.
        const user = await prisma.user.findUnique({ where: { email: credentials.email } });
        if (!user || !user.passwordHash) return null;
        const memberships = await prisma.membership.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: "asc" },
          select: { tenantId: true, role: true },
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
        // No membership left (account exists, e.g. removed from every
        // workspace) — there's nothing to log in TO.
        const primary = memberships[0];
        if (!primary) return null;
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
  return list;
}

export function enabledSsoProviders(): Array<"google" | "github"> {
  const out: Array<"google" | "github"> = [];
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) out.push("google");
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) out.push("github");
  return out;
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
  const merged: string[] = [];
  try {
    const parsed = row ? JSON.parse(row.rolesJson ?? "[]") : [];
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
  if (user.role === "executive" && !merged.includes("executive")) merged.push("executive");
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
