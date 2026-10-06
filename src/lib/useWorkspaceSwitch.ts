"use client";
/**
 * One implementation of "switch the active workspace", shared by the Console
 * (AppShell's TenantSwitcher) and the Executive header (ExecShell).
 *
 * The memberships come from `session.user.memberships`; a switch is
 * `useSession().update({ activeTenantId })`, which the jwt() callback in
 * lib/auth.ts only honours for a tenant the user currently has a membership
 * in (it re-reads memberships from the DB on every update) — an unlisted id is
 * silently ignored, so the client list is a convenience, not the gate.
 */
import { useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useResilientSession } from "@/lib/useResilientSession";

export type WorkspaceMembership = {
  tenantId: string; tenantSlug: string; tenantName: string; role: string; tenantTier?: string;
  /** A workspace surfaced through Platform Admin org oversight, not a Membership row. */
  isVirtual?: boolean;
};

export function useWorkspaceSwitch() {
  // `update` is a stable mutator; reads go through useResilientSession() so a
  // session-fetch blip doesn't leave the switcher blank (see its doc comment).
  const { update } = useSession();
  const { session: data } = useResilientSession();
  const memberships = ((data?.user as any)?.memberships ?? []) as WorkspaceMembership[];
  const activeTenantId = (data?.user as any)?.activeTenantId ?? (data?.user as any)?.tenantId as string | undefined;
  const active = memberships.find((m) => m.tenantId === activeTenantId);
  const [busy, setBusy] = useState(false);
  // A membership refresh opened with the menu may still be in flight when an item is clicked.
  const refreshing = useRef<Promise<unknown> | null>(null);

  /**
   * Adopt `tenantId`, then do a FULL navigation to `landing` — router.push +
   * refresh from inside a closing Radix menu item silently drops (see the
   * history in AppShell), and a full load also clears every per-workspace
   * client cache (router cache, nav counts).
   */
  async function switchTo(tenantId: string, landing: string) {
    if (tenantId === activeTenantId) return;
    setBusy(true);
    try {
      // Two session POSTs carry the same old cookie; let the refresh land first so it can't overwrite the switch.
      await refreshing.current?.catch(() => {});
      await update({ activeTenantId: tenantId });
      window.location.href = landing;
    } finally { setBusy(false); }
  }

  /** The membership list is baked into the token; re-pull it whenever a menu opens. */
  async function refreshOnOpen(open: boolean) {
    if (!open || busy) return;
    const run = update({ refreshMemberships: true });
    refreshing.current = run;
    try { await run; } catch { /* stale list is still usable */ } finally { if (refreshing.current === run) refreshing.current = null; }
  }

  return { update, hasSession: !!data?.user, memberships, activeTenantId, active, busy, setBusy, switchTo, refreshOnOpen };
}
