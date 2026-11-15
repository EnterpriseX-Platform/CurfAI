/**
 * A person's own data: a copy of it, and erasing it (PDPA / GDPR data-subject requests).
 *
 * An account is one global row shared by every workspace the person belongs to, and the workspaces' content — reports,
 * comments, schedules — points at it (three of those links, Report.createdBy, Schedule.createdBy and Comment.author, make
 * deleting the row impossible while that content exists). So erasing a person means ANONYMISING the account, not deleting
 * it: the email becomes an unusable placeholder, the name, password and preferences are removed, every way of signing in
 * or being reached (memberships, API keys, push subscriptions, LINE links, tokens) is cut, and the personal data on their
 * audit rows (email, address, browser) is removed while the trail of what happened stays. What they wrote in a workspace
 * is the workspace's content and stays, attributed to "Erased person".
 *
 * Erasure never strands a workspace: a person who is the only admin of a workspace that has other members is refused
 * until someone else is an admin; a workspace where they are the only member is scheduled for deletion with them
 * (lib/lifecycle/deletion.ts), so nothing is left behind with no one to answer for it.
 */
import { prisma } from "@/lib/db";
import { withSystemDbContext } from "@/lib/dbContext";
import { persistAudit } from "@/lib/audit";
import { isPlatformAdmin } from "@/lib/platformAdmin";
import { LifecycleError, scheduleDeletion, type Actor } from "./deletion";
import { withModel, optionalModel } from "./optionalModel";
import { ee } from "@/ee";

const DAY_MS = 86_400_000;
const DSR_DUE_DAYS = 30;

/** The placeholder an erased account's email becomes: unique, never deliverable (the .invalid TLD is reserved). */
export function erasedEmail(userId: string): string { return `erased-${userId}@erased.invalid`; }
/** What an erased person is called on audit rows and in people lists. */
export function erasedLabel(userId: string): string { return `erased-user-${userId.slice(-8)}`; }

export type DsrKind = "export" | "erasure";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Log a request, with the date it must be answered by. Platform-level; survives the account. */
export async function openRequest(args: {
  kind: DsrKind; subjectEmail: string; subjectUserId?: string | null; channel: "self_service" | "operator"; handledBy?: string | null; notes?: string | null; now?: Date;
}) {
  const now = args.now ?? new Date();
  return withSystemDbContext(() => prisma.dataSubjectRequest.create({
    data: {
      kind: args.kind, subjectEmail: args.subjectEmail, subjectUserId: args.subjectUserId ?? null, channel: args.channel,
      receivedAt: now, dueAt: new Date(now.getTime() + DSR_DUE_DAYS * DAY_MS), handledBy: args.handledBy ?? null, notes: args.notes ?? null,
    },
  }));
}

export async function closeRequest(id: string, status: "completed" | "failed" | "rejected", by: string | null, notes?: string | null) {
  await withSystemDbContext(() => prisma.dataSubjectRequest.update({
    where: { id },
    data: { status, completedAt: new Date(), handledBy: by, ...(notes ? { notes } : {}) },
  }));
}

// ---------------------------------------------------------------------------
// A copy of what is held about a person
// ---------------------------------------------------------------------------

/**
 * Everything personal that Curf holds about this account, as one JSON document: the profile, where they belong and
 * their role there, the keys and devices tied to them, what they wrote, and the trail of what they did. Not their
 * workspaces' content (a report is the workspace's, not a personal record) — that is the workspace export's job.
 */
export async function exportPersonalData(userId: string) {
  return withSystemDbContext(async () => {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, createdAt: true, emailVerifiedAt: true, passwordChangedAt: true, preferencesJson: true },
    });
    if (!u) throw new LifecycleError("Account not found", 404);

    const [memberships, orgMemberships, apiKeys, push, people, comments, audit, conversations] = await Promise.all([
      prisma.membership.findMany({ where: { userId }, select: { role: true, createdAt: true, tenant: { select: { id: true, name: true, slug: true } } } }),
      prisma.orgMembership.findMany({ where: { userId }, select: { role: true, organization: { select: { name: true, slug: true } } } }),
      prisma.apiKey.findMany({ where: { createdById: userId }, select: { name: true, prefix: true, role: true, scope: true, createdAt: true, lastUsedAt: true, revokedAt: true, tenantId: true } }),
      // Models the Community edition does not have (push, the people directory, Ask) are simply empty there.
      withModel("pushSubscription", (m) => m.findMany({ where: { userId }, select: { label: true, createdAt: true, lastPushedAt: true, tenantId: true } }), [] as unknown[]),
      withModel("orgPerson", (m) => m.findMany({ where: { userId }, select: { tenantId: true, email: true, name: true, title: true, createdAt: true, lineIdentities: { select: { channelKey: true, displayName: true, locale: true, consentAt: true } } } }), [] as unknown[]),
      prisma.comment.findMany({ where: { authorId: userId }, orderBy: { createdAt: "desc" }, take: 5000, select: { tenantId: true, reportId: true, body: true, createdAt: true } }),
      prisma.auditEvent.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 20_000, select: { tenantId: true, kind: true, target: true, ip: true, userAgent: true, createdAt: true } }),
      withModel("askConversation", (m) => m.count({ where: { userId } }), 0),
    ]);

    return {
      format: "curf-personal-data/1",
      exportedAt: new Date().toISOString(),
      account: {
        id: u.id, email: u.email, name: u.name, createdAt: u.createdAt, emailVerifiedAt: u.emailVerifiedAt,
        passwordLastChangedAt: u.passwordChangedAt, preferences: safeJson(u.preferencesJson),
      },
      workspaces: memberships.map((m) => ({ id: m.tenant.id, name: m.tenant.name, slug: m.tenant.slug, role: m.role, joinedAt: m.createdAt })),
      organizations: orgMemberships.map((o) => ({ name: o.organization.name, slug: o.organization.slug, role: o.role })),
      apiKeys: apiKeys.map((k) => ({ ...k, note: "the secret is never stored in readable form" })),
      pushDevices: push,
      directoryEntries: people,
      comments,
      askConversations: { count: conversations },
      activity: { note: "what you did, newest first (at most 20,000 events)", events: audit },
      notIncluded: [
        "Your workspaces' content (reports, dashboards, data) — ask a workspace admin for a workspace export.",
        "Your password (only a one-way hash is kept) and secrets such as API key values.",
      ],
    };
  });
}

function safeJson(s: string | null | undefined): unknown {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Erasing
// ---------------------------------------------------------------------------

export type Blocker = { tenantId: string; workspace: string; why: string };

/**
 * What stands between this person and erasure: workspaces where they are the only admin but other people remain
 * (someone else has to be made admin first). Empty = free to go.
 */
export async function erasureBlockers(userId: string): Promise<Blocker[]> {
  return withSystemDbContext(async () => {
    const mine = await prisma.membership.findMany({ where: { userId }, select: { tenantId: true, role: true, tenant: { select: { name: true } } } });
    const blockers: Blocker[] = [];
    for (const m of mine) {
      if (m.role !== "admin") continue;
      const [others, otherAdmins] = await Promise.all([
        prisma.membership.count({ where: { tenantId: m.tenantId, userId: { not: userId } } }),
        prisma.membership.count({ where: { tenantId: m.tenantId, userId: { not: userId }, role: "admin" } }),
      ]);
      if (others > 0 && otherAdmins === 0) {
        blockers.push({ tenantId: m.tenantId, workspace: m.tenant.name, why: "You are its only admin and other people still belong to it. Make someone else an admin first, or delete the workspace." });
      }
    }
    return blockers;
  });
}

/**
 * Cut an account's every way in and remove the personal data on it, without removing the row (see the header). Used by
 * erasure, and by the workspace purge for an account left with no workspace. Idempotent.
 */
export async function anonymizeUser(userId: string): Promise<{ auditRowsScrubbed: number }> {
  return withSystemDbContext(async () => {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
    if (!u) return { auditRowsScrubbed: 0 };
    const now = new Date();
    const people: Array<{ id: string }> = await withModel("orgPerson", (m) => m.findMany({ where: { userId }, select: { id: true } }), []);
    const personIds = people.map((p) => p.id);

    // Their trail: keep what happened, drop who (and from where).
    const scrubbed = await prisma.$queryRaw<Array<{ n: bigint | number }>>`
      SELECT curf_audit_anonymize_user(${userId}, ${u.email}, ${erasedLabel(userId)}) AS n`;

    const push = optionalModel("pushSubscription");
    const line = optionalModel("lineIdentity");
    const workToken = optionalModel("workToken");
    const workSession = optionalModel("workSession");
    const userSession = optionalModel("userSession"); // enterprise identity: signed-in sessions (paid edition only)
    const orgPerson = optionalModel("orgPerson");
    // Models this edition does not have are skipped (see optionalModel.ts).
    const ops: any[] = [
      // Keys they minted stop working, and nothing can sign in as them or reach them.
      prisma.apiKey.updateMany({ where: { createdById: userId, revokedAt: null }, data: { revokedAt: now } }),
      prisma.membership.deleteMany({ where: { userId } }),
      prisma.orgMembership.deleteMany({ where: { userId } }),
      ...(push ? [push.deleteMany({ where: { userId } })] : []),
      prisma.userAttribute.deleteMany({ where: { userId } }),
      prisma.passwordResetToken.deleteMany({ where: { userId } }),
      prisma.emailVerificationToken.deleteMany({ where: { userId } }),
      // Their entries in workspaces' people lists keep working for the assignments that name them, as no one in particular.
      ...(line ? [line.deleteMany({ where: { personId: { in: personIds } } })] : []),
      ...(workToken ? [workToken.deleteMany({ where: { personId: { in: personIds } } })] : []),
      ...(workSession ? [workSession.deleteMany({ where: { personId: { in: personIds } } })] : []),
      ...(userSession ? [userSession.deleteMany({ where: { userId } })] : []),
      ...(orgPerson ? people.map((p) => orgPerson.update({
        where: { id: p.id },
        data: { userId: null, email: erasedEmail(p.id), name: "Erased person", title: null, notifyEmail: false },
      })) : []),
      prisma.user.update({
        where: { id: userId },
        data: {
          email: erasedEmail(userId), name: null, passwordHash: null, preferencesJson: "{}",
          emailVerifiedAt: null, passwordChangedAt: now, // ends any session still open on the old password
          keycloakSub: null, identityMigratedAt: null, // the identity provider link goes with the person
        },
      }),
    ];
    await prisma.$transaction(ops);
    return { auditRowsScrubbed: Number(scrubbed[0]?.n ?? 0) };
  });
}

/** For an account the purge left with no workspace: delete it if nothing blocks that, anonymise it if something does. */
export async function removeOrphanedUser(userId: string): Promise<"deleted" | "anonymized" | "kept"> {
  return withSystemDbContext(async () => {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!u) return "kept";
    if (isPlatformAdmin(u.email)) return "kept"; // an operator's account is not removed because a customer workspace went
    const [m, o] = await Promise.all([prisma.membership.count({ where: { userId } }), prisma.orgMembership.count({ where: { userId } })]);
    if (m + o > 0) return "kept";
    await anonymizeUser(userId); // scrubs the audit rows first, in every case
    try {
      await prisma.user.delete({ where: { id: userId } });
      return "deleted";
    } catch {
      return "anonymized"; // something still points at the row (e.g. content in another workspace): the anonymised row stays
    }
  });
}

export type ErasureResult = {
  anonymized: true;
  workspacesScheduledForDeletion: string[];
  membershipsRemoved: number;
  auditRowsScrubbed: number;
};

/**
 * Erase a person. Refuses while they are the only admin of a workspace that other people still use; schedules deletion
 * of workspaces where they are the only member; removes them from the rest; then anonymises the account.
 * `by` is who asked: the person themselves, or an operator acting on a request that arrived by email.
 */
export async function erasePerson(userId: string, by: Actor, opts: { requestId?: string } = {}): Promise<ErasureResult> {
  const blockers = await erasureBlockers(userId);
  if (blockers.length > 0) {
    throw new LifecycleError(
      "We can't erase this account yet: " + blockers.map((b) => `${b.workspace} — ${b.why}`).join(" "), 409,
    );
  }
  const u = await withSystemDbContext(() => prisma.user.findUnique({ where: { id: userId }, select: { email: true } }));
  if (!u) throw new LifecycleError("Account not found", 404);
  if (isPlatformAdmin(u.email)) throw new LifecycleError("A Curf operator's account can't be erased from here.", 403);

  const mine = await withSystemDbContext(() => prisma.membership.findMany({ where: { userId }, select: { tenantId: true } }));
  const scheduled: string[] = [];
  for (const m of mine) {
    const others = await withSystemDbContext(() => prisma.membership.count({ where: { tenantId: m.tenantId, userId: { not: userId } } }));
    if (others === 0) {
      try {
        await scheduleDeletion(m.tenantId, by, { via: "erasure", reason: "its only member asked to erase their account" });
        scheduled.push(m.tenantId);
      } catch (e: any) {
        // Already scheduled is fine. Anything else (an active subscription) stops here — nothing has been erased yet.
        if (!(e instanceof LifecycleError && e.status === 409 && /already scheduled/i.test(e.message))) throw e;
      }
    }
  }

  // One audit row per workspace they belonged to, before the memberships go.
  for (const m of mine) {
    await persistAudit({
      tenantId: m.tenantId, userId, userEmail: by.email, kind: "user.erased", target: userId,
      meta: { by: by.email, requestId: opts.requestId ?? null, workspaceScheduledForDeletion: scheduled.includes(m.tenantId) },
    });
  }
  const kcSub = (await withSystemDbContext(() => prisma.user.findUnique({ where: { id: userId }, select: { keycloakSub: true } })))?.keycloakSub ?? null;
  const r = await anonymizeUser(userId);
  // The person's Keycloak account goes too (best effort: erasure never waits on Keycloak being up).
  await ee.identity?.onUserErased({ id: userId, keycloakSub: kcSub }).catch(() => null);
  return { anonymized: true, workspacesScheduledForDeletion: scheduled, membershipsRemoved: mine.length, auditRowsScrubbed: r.auditRowsScrubbed };
}
