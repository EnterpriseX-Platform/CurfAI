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
export function canBuild(role: string | null | undefined): boolean {
  return role === "admin" || role === "developer";
}
