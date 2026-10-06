/**
 * Append-only audit trail. Every security-meaningful action calls
 * `recordAudit({...})` to drop a row in AuditEvent. Read-only from the app
 * perspective - the table is never updated, never deleted (retention is
 * operational policy: archive monthly to cold storage if you need to keep
 * forever).
 */
import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { withSystemDbContext } from "@/lib/dbContext";
import type { CurfSessionUser } from "@/lib/auth";
import { clientIp } from "@/lib/security/clientIp";

export type AuditKind =
  | "signin" | "signout" | "signin.failed"
  | "user.create" | "user.update" | "user.delete" | "user.invite" | "user.remove"
  | "role.create" | "role.update" | "role.delete" | "role.assign"
  | "report.create" | "report.update" | "report.delete" | "report.publish"
  | "schedule.create" | "schedule.update" | "schedule.delete" | "schedule.run"
  | "watcher.create" | "watcher.update" | "watcher.delete" | "watcher.run"
  | "watcher.pause" | "watcher.resume"
  | "share.mint" | "share.revoke"
  | "export.pdf" | "export.xlsx" | "export.docx" | "export.csv"
  | "apikey.mint" | "apikey.revoke"
  | "password.reset.request" | "password.reset.complete"
  | "tenant.create" | "tenant.update" | "tenant.pdpa.update"
  | "datasource.create" | "datasource.update" | "datasource.delete"
  | "document.upload" | "document.delete"
  | "operate.request.document_generated"
  | "sync.line.import"
  | "org.platform_admin.grant" | "org.platform_admin.revoke"
  | "app.viewer.grant" | "app.viewer.revoke" | "app.viewer.resend"
  | "app.viewer.signin" | "app.viewer.signin.failed"
  | "mcp.tool.call"
  | "oauth.client.register" | "oauth.authorize.consent" | "oauth.authorize.deny"
  | "oauth.token.exchange" | "oauth.token.exchange.failed"
  | (string & {});

export type AuditOptions = {
  user?: CurfSessionUser | null;
  /**
   * Pass a real tenantId to attribute the event, omit it to fall back to
   * `user.tenantId`, or pass the literal `null` to record a genuine
   * platform-level action that has no tenant at all (e.g. a waitlist
   * invite — there's no tenant yet at that point). `null` is a deliberate
   * opt-in, not "missing" — an event that ends up with neither still warns
   * and drops, same as before.
   */
  tenantId?: string | null;
  userId?: string | null;
  userEmail?: string | null;
  kind: AuditKind;
  target?: string | null;
  req?: NextRequest;
  meta?: Record<string, unknown>;
  /**
   * Set for an org-level action that isn't naturally scoped to one tenant
   * (granting/revoking Platform Admin, changing a role in a DIFFERENT
   * tenant than the actor's own active one) — `tenantId` is still required
   * and attributed to the actor's active tenant; this is what lets an
   * org-wide audit view surface the event too.
   */
  organizationId?: string | null;
  /** An executive assistant acted for this user (executive journey P5); `user` is the assistant. */
  onBehalfOfUserId?: string | null;
};

/** The AuditEvent row for these options, or null when it has no tenant. */
function auditRow(opts: AuditOptions) {
  const tenantId = opts.tenantId === null ? null : (opts.tenantId ?? opts.user?.tenantId);
  if (tenantId === undefined) return null;
  const { ip, userAgent } = captureRequest(opts.req);
  return {
    tenantId,
    userId: opts.userId ?? (opts.user?.viaApiKey ? null : opts.user?.id ?? null),
    userEmail: opts.userEmail ?? opts.user?.email ?? null,
    kind: String(opts.kind),
    target: opts.target ?? null,
    ip: ip ?? null,
    userAgent: userAgent ?? null,
    metaJson: JSON.stringify(opts.meta ?? {}),
    organizationId: opts.organizationId ?? null,
    onBehalfOfUserId: opts.onBehalfOfUserId ?? null,
  };
}

/**
 * A platform-level row (tenantId null) belongs to no workspace, so it can't
 * be written as the workspace the request is bound to: RLS lets a bound
 * request write only its own workspace's rows (prisma/rls/policies.sql), and
 * a platform admin's waitlist invite was being refused and dropped
 * (BE-SEC-04). Every other row is written as the request, as before.
 */
function writeAuditRow(client: any, data: NonNullable<ReturnType<typeof auditRow>>): Promise<unknown> {
  const write = () => client.auditEvent.create({ data });
  return data.tenantId === null ? withSystemDbContext(write) : write();
}

/**
 * Capture a single audit row. Non-blocking: errors are swallowed (logged)
 * so audit failures never break the user's action.
 */
export function recordAudit(opts: AuditOptions): void {
  const data = auditRow(opts);
  if (!data) {
    console.warn("[audit] dropping event - no tenantId", { kind: opts.kind });
    return;
  }
  // Wrap in try/catch so synchronous throws (e.g. AuditEvent missing because
  // `prisma db push` hasn't run yet) never break the calling request.
  try {
    const client: any = prisma;
    if (!client?.auditEvent?.create) {
      console.warn("[audit] AuditEvent table missing - run `npx prisma db push`");
      return;
    }
    writeAuditRow(client, data).catch((err: any) => {
      console.error("[audit] write failed", err?.message ?? err, { kind: opts.kind });
    });
  } catch (err: any) {
    console.error("[audit] sync throw", err?.message ?? err, { kind: opts.kind });
  }
}

/**
 * Awaited, throwing counterpart of recordAudit(), for the rare action whose
 * audit row IS the state change — an incident ack, note or rollback request
 * has no other record. Swallowing a failed write there would answer 200 for
 * an action that never happened, which is exactly the Action Center bug
 * (FE-ACT-02) this exists to rule out. Everywhere else, keep recordAudit().
 */
export async function persistAudit(opts: AuditOptions): Promise<void> {
  const data = auditRow(opts);
  if (!data) throw new Error(`[audit] ${String(opts.kind)} has no tenantId`);
  await writeAuditRow(prisma, data);
}

export function captureRequest(req?: NextRequest): { ip?: string; userAgent?: string } {
  const h = req?.headers ?? currentRequestHeaders();
  if (!h) return {};
  const resolved = clientIp({ headers: h } as Pick<NextRequest, "headers">);
  const ip = resolved === "unknown" ? undefined : resolved;
  const userAgent = h.get("user-agent") ?? undefined;
  return { ip: ip || undefined, userAgent };
}

/**
 * Headers of the request being handled, for a row written where no
 * NextRequest is in hand — NextAuth's signIn / signOut events and the
 * credentials authorize() failure path. Every sign-in row used to carry no
 * IP at all (BE-SEC-05), which is exactly the row a credential-stuffing
 * investigation needs. Outside a request (cron scripts, tests) there is
 * none, and the row is written without one as before.
 */
function currentRequestHeaders(): { get(name: string): string | null } | null {
  try { return headers(); } catch { return null; }
}

/**
 * List recent audit events for a tenant. Used by /admin/audit. Returns the
 * newest first; pass `cursor` (an event id) for pagination via Prisma's
 * cursor-based skip.
 *
 * Tolerates the AuditEvent table being absent (returns empty list) so the
 * admin page renders an empty state when `prisma db push` hasn't run yet.
 */
export async function listAuditEvents(opts: {
  tenantId: string;
  /**
   * When set, ALSO includes events for this Organization even if they're
   * attributed to a DIFFERENT tenant's `tenantId` (org-level grants/role
   * changes elsewhere in the org) — see AuditOptions.organizationId. Pass
   * this only for a Platform Admin viewing the org-wide audit view.
   */
  organizationId?: string;
  kind?: string;
  userId?: string;
  limit?: number;
  cursor?: string | null;
}): Promise<{
  items: Array<{
    id: string; tenantId: string; userId: string | null; userEmail: string | null;
    kind: string; target: string | null; ip: string | null; userAgent: string | null;
    metaJson: string; createdAt: Date; organizationId: string | null;
  }>;
  nextCursor: string | null;
}> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const where: any = opts.organizationId
    ? { OR: [{ tenantId: opts.tenantId }, { organizationId: opts.organizationId }] }
    : { tenantId: opts.tenantId };
  if (opts.kind) where.kind = opts.kind;
  if (opts.userId) where.userId = opts.userId;
  const client: any = prisma;
  if (!client?.auditEvent?.findMany) {
    return { items: [], nextCursor: null };
  }
  try {
    const items = await client.auditEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = items.length > limit;
    const trimmed = hasMore ? items.slice(0, limit) : items;
    return {
      items: trimmed,
      nextCursor: hasMore ? trimmed[trimmed.length - 1].id : null,
    };
  } catch (err: any) {
    console.warn("[audit] read failed:", err?.message ?? err);
    return { items: [], nextCursor: null };
  }
}
