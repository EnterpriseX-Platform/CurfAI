/**
 * Append-only audit trail. Every security-meaningful action calls
 * `recordAudit({...})` to drop a row in AuditEvent. Read-only from the app
 * perspective - the table is never updated, never deleted (retention is
 * operational policy: archive monthly to cold storage if you need to keep
 * forever).
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import type { CurfSessionUser } from "@/lib/auth";

export type AuditKind =
  | "signin" | "signout" | "signin.failed"
  | "user.create" | "user.update" | "user.delete" | "user.invite"
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
  tenantId?: string;
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
};

/**
 * Capture a single audit row. Non-blocking: errors are swallowed (logged)
 * so audit failures never break the user's action.
 */
export function recordAudit(opts: AuditOptions): void {
  const tenantId = opts.tenantId ?? opts.user?.tenantId;
  if (!tenantId) {
    console.warn("[audit] dropping event - no tenantId", { kind: opts.kind });
    return;
  }
  const { ip, userAgent } = captureRequest(opts.req);
  const userId = opts.userId ?? (opts.user?.viaApiKey ? null : opts.user?.id ?? null);
  const userEmail = opts.userEmail ?? opts.user?.email ?? null;
  // Wrap in try/catch so synchronous throws (e.g. AuditEvent missing because
  // `prisma db push` hasn't run yet) never break the calling request.
  try {
    const client: any = prisma;
    if (!client?.auditEvent?.create) {
      console.warn("[audit] AuditEvent table missing - run `npx prisma db push`");
      return;
    }
    client.auditEvent.create({
      data: {
        tenantId,
        userId,
        userEmail,
        kind: String(opts.kind),
        target: opts.target ?? null,
        ip: ip ?? null,
        userAgent: userAgent ?? null,
        metaJson: JSON.stringify(opts.meta ?? {}),
        organizationId: opts.organizationId ?? null,
      },
    }).catch((err: any) => {
      console.error("[audit] write failed", err?.message ?? err, { kind: opts.kind });
    });
  } catch (err: any) {
    console.error("[audit] sync throw", err?.message ?? err, { kind: opts.kind });
  }
}

export function captureRequest(req?: NextRequest): { ip?: string; userAgent?: string } {
  if (!req) return {};
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const ip = fwd.split(",")[0]?.trim() || req.headers.get("x-real-ip") || undefined;
  const userAgent = req.headers.get("user-agent") ?? undefined;
  return { ip: ip || undefined, userAgent };
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
