/**
 * Pure role predicates, importable from client and server alike (lib/auth.ts
 * pulls in Prisma + NextAuth, so client components can't reach its
 * MEMBERSHIP_ROLES).
 *
 * "developer" was "editor" before the 2026-08 role restructure. The rename
 * left a dozen hand-rolled `role === "editor"` checks behind — no Membership
 * carries that value any more, so each one silently locked developers out
 * of the thing it guarded (creating reports and notebooks, instant views,
 * lake schema edits). Every such check now goes through here; the API-route
 * equivalent is requireAdminOrEditor() in lib/auth.ts.
 */
import { EDITION } from "@/lib/ee/edition";
export function canBuild(role: string | null | undefined): boolean {
  return role === "admin" || role === "developer";
}

/**
 * Who may change a lake table's columns (add, formula, rename, drop, tags):
 * a builder — of a table they can read, which is the only kind the table
 * page shows. The routes' own check is lib/lake/tableAccess.ts's "build";
 * the page and its Manage panel ask this, so the buttons match what the
 * server allows (they had drifted: audit 2026-09-30, C7).
 */
export function canEditLakeColumns(role: string | null | undefined): boolean {
  return canBuild(role);
}

/**
 * Who may change who sees a lake table: its owner, or an admin — also of a
 * table they can't read, the way back from an owner-only table whose owner
 * has left (the visibility route).
 */
export function canEditLakeVisibility(role: string | null | undefined, ownerUserId: string | null | undefined, userId: string): boolean {
  return role === "admin" || (!!ownerUserId && ownerUserId === userId);
}

/**
 * Who may save, rename and delete an app's What-if scenarios: builders, plus
 * executives — they are the main what-if audience, and a named scenario is
 * app-scoped and low-risk.
 */
export function canSaveScenarios(role: string | null | undefined): boolean {
  return canBuild(role) || role === "executive";
}

/**
 * Who may log, review and track Decisions (incl. tracking a What-if scenario
 * as one): builders plus executives — decisions are theirs to own (CEO
 * decision 2026-09-24). Viewers stay read-only.
 */
export function canLogDecisions(role: string | null | undefined): boolean {
  return canBuild(role) || role === "executive";
}

/**
 * Who gets the Operate inbox — approvals they owe, requests they sent:
 * builders plus executives, the people approval chains usually name.
 * Authoring templates stays canBuild().
 */
export function canUseOperateInbox(role: string | null | undefined): boolean {
  return canBuild(role) || role === "executive";
}

/**
 * Executives and viewers use the Executive view (/executive, its own
 * sign-in and layout — CEO 2026-09-25) rather than the Curf Console, which
 * stays the builder's tool. src/middleware.ts sends them there from the
 * Console; builders and admins can open it too, to see what executives see.
 */
export function usesExecutiveView(role: string | null | undefined): boolean {
  return role === "executive" || role === "viewer";
}

/** An app opened from the Executive view: the marker gives its app bar a back arrow to /executive. */
export const FROM_EXECUTIVE = "executive";
export function execAppHref(slug: string): string {
  return `/apps/${slug}?from=${FROM_EXECUTIVE}`;
}

/** Where a signed-in member lands (login and "/"). */
export function landingPathFor(role: string | null | undefined): string {
  // The Community edition has no Executive view.
  return EDITION !== "community" && usesExecutiveView(role) ? "/executive" : "/brief";
}
