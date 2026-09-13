/**
 * Platform-admin gate (separate from per-tenant admin).
 *
 * A "platform admin" is a Curf operator — the people who triage the
 * invite-only beta waitlist, configure system-wide knobs, etc. They are
 * identified ONLY by email match against `CURF_PLATFORM_ADMIN_EMAILS`,
 * never by the per-tenant `User.role` field. This means a tenant admin
 * cannot escalate to platform admin from inside the app.
 *
 * Comma-separated env var:
 *   CURF_PLATFORM_ADMIN_EMAILS=alice@curf.app,bob@curf.app
 *
 * If the env var is empty/unset, NO ONE is a platform admin — fail closed.
 */
import type { CurfSessionUser } from "@/lib/auth";

export function isPlatformAdmin(emailOrUser: string | CurfSessionUser | null | undefined): boolean {
  const email = typeof emailOrUser === "string" ? emailOrUser : emailOrUser?.email;
  if (!email) return false;
  const allow = (process.env.CURF_PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allow.length === 0) return false;
  return allow.includes(email.toLowerCase());
}

/**
 * Throw early in routes that should be platform-admin only. The thrown
 * error carries an HTTP status — callers wrap in try/catch and forward
 * the status to NextResponse.json.
 */
export async function requirePlatformAdmin(req: Request): Promise<CurfSessionUser> {
  const { requireUser } = await import("@/lib/auth");
  const user = await requireUser(req as any);
  if (!user) throw Object.assign(new Error("Unauthorized"), { status: 401 });
  if (!isPlatformAdmin(user)) throw Object.assign(new Error("Platform admin only"), { status: 403 });
  return user;
}
