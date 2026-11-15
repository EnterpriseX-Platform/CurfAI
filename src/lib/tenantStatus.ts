/**
 * Whether a workspace may be used at all.
 *
 * A workspace is open when its status is "active" (or not set — a row from before the column existed). Anything else is
 * closed to its members, its API keys, its public links and its background jobs alike:
 *   suspended         — an operator closed it (lib/platform/tenants.ts); nothing is deleted
 *   pending_deletion  — an admin or operator scheduled it for deletion and the grace period is running
 *                       (lib/lifecycle/deletion.ts); nothing is deleted yet either
 *
 * Pure, so the sign-in code, the session callback, the cron queries and the public-link guard all ask the same question
 * and a third kind of closed workspace is one line here rather than a hunt through the codebase.
 */
export const TENANT_STATUSES = ["active", "suspended", "pending_deletion"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export function tenantOpen(status: string | null | undefined): boolean {
  return !status || status === "active";
}

/** The Prisma `where` fragment for "only open workspaces", for a relation to Tenant. */
export const OPEN_TENANT = { status: "active" } as const;

/** Why a closed workspace is closed, for messages; null when it is open. */
export function closedReason(status: string | null | undefined): "suspended" | "pending_deletion" | null {
  if (tenantOpen(status)) return null;
  return status === "pending_deletion" ? "pending_deletion" : "suspended";
}
