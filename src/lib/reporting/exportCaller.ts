/**
 * Who an export renders as. A downloaded or emailed file leaves the app, so
 * it must carry no more than its caller could see on screen: data-source ACL
 * and lake column redaction are applied per viewer by runReportWithProof(),
 * and blocks a report author hid from the caller's roles, with the queries
 * only they used, are dropped by visibleReport() (lib/reporting/
 * visibleReport.ts). The PDF / chart-capture page applies all three for the
 * forwarded session. With no session it runs the queries as the viewer its
 * render token names (lib/reporting/renderToken.ts), and filters blocks as
 * that viewer when the token says so, as nobody otherwise. A renderer called
 * without a viewer runs its queries as the system and skips the first two.
 *
 * On-demand exports render as the person or API key asking for the file,
 * blocks included, in every format. A scheduled delivery has no one asking:
 * its data renders as the schedule's creator (deliveryViewer()), its blocks
 * as nobody.
 */
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { getUserRoles, memberRoleSlugs, type CurfSessionUser } from "@/lib/auth";
import { ANONYMOUS_VIEWER, type RunViewer } from "@/lib/reporting/runner";

/** The runner's viewer identity for this caller. An API key has no
 *  Membership to read custom role slugs from, so it carries none. */
export async function exportViewer(user: CurfSessionUser): Promise<RunViewer> {
  return { id: user.id, isAdmin: user.role === "admin", roles: user.viaApiKey ? [] : await getUserRoles() };
}

/**
 * The viewer a scheduled delivery renders as: its creator, as they stand in
 * the schedule's workspace at send time. A demotion or a removed custom role
 * applies from the next send.
 *
 * A creator who has left the workspace can see none of it, so the delivery
 * falls back to what an unauthenticated share link gets (ANONYMOUS_VIEWER):
 * workspace-wide sources only, sensitivity-tagged lake columns redacted.
 * It keeps sending rather than going quiet, the way an API key outlives the
 * member who created it.
 */
export async function deliveryViewer(schedule: { tenantId: string; createdById: string }): Promise<RunViewer> {
  return memberViewer(schedule.tenantId, schedule.createdById);
}

/**
 * A member's viewer with no session to read it from (a notebook cell, a
 * scheduled job): their role and role slugs in `tenantId` now, through the
 * same rule getUserRoles() uses. Someone no longer a member there gets
 * ANONYMOUS_VIEWER.
 */
export async function memberViewer(tenantId: string, userId: string): Promise<RunViewer> {
  const m = await prisma.membership.findUnique({
    where: { userId_tenantId: { userId, tenantId } },
    select: { role: true, rolesJson: true },
  });
  if (!m) return ANONYMOUS_VIEWER;
  return { id: userId, isAdmin: m.role === "admin", roles: memberRoleSlugs(m.role, m.rolesJson) };
}

/** "name=value" of the caller's NextAuth session cookie, for the headless
 *  viewer (renderPdf, renderXlsx's chart capture) to render as them. */
export function forwardedSessionCookie(req: NextRequest): string | undefined {
  const c = req.cookies.get("next-auth.session-token") ?? req.cookies.get("__Secure-next-auth.session-token");
  return c ? c.name + "=" + encodeURIComponent(c.value) : undefined;
}
