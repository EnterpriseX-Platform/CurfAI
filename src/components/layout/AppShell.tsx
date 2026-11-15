"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LogOut, ChevronDown, Plus, Check, Sparkles, Monitor, Menu, Loader2, UserRound } from "lucide-react";
import { cn, initials } from "@/lib/utils";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { LanguageSwitcher } from "@/components/common/LanguageSwitcher";
import { AiCreditsChip } from "@/components/layout/AiCreditsChip";
import { MenuHelpDialog } from "@/components/layout/MenuHelpDialog";
import { CommandPalette, type LocalPaletteItem } from "@/components/layout/CommandPalette";
import { SectionColumn, SystemRail, SystemSwitcher, TabBar, useConsoleNav } from "@/components/layout/SystemsNav";
import { eeClient } from "@/ee/client";

/** Community edition: paid nav, palette and count badges are absent. */
const IS_COMMUNITY = eeClient.edition === "community";
// Cloud billing UI — Community tenants never hold a Stripe subscription, so
// the registry's Community stub never fills this in and it resolves to null
// there, same as every other paid component attached to a shared surface
// (see src/lib/ee/clientTypes.ts).
const PastDueBanner = eeClient.layout?.PastDueBanner ?? null;
import { CurfLogo } from "@/components/common/CurfLogo";
import { useResilientSession } from "@/lib/useResilientSession";
import { useWorkspaceSwitch } from "@/lib/useWorkspaceSwitch";
import { RELEASE_LOG } from "@/lib/releaseLog";
import { useT } from "@/lib/i18n/LocaleContext";

// Single source of truth for the version badge — RELEASE_LOG[0] is always
// the newest entry (see releaseLog.ts's own "add one entry per version
// bump, newest first" convention). A literal string here silently drifted
// from the actual shipped version before.
const CURRENT_VERSION = RELEASE_LOG[0]?.version ?? "";

// Product names, not UI copy — the same in every locale, like the prototype.
const TIER_LABELS: Record<string, string> = {
  community: "Community", growth: "Growth", business: "Business", enterprise: "Enterprise",
};
function tierLabel(tier?: string | null): string | null {
  return tier ? TIER_LABELS[tier] ?? null : null;
}

export function AppShell({
  children,
  breadcrumbs,
  actions,
  navExtra,
}: {
  children: React.ReactNode;
  breadcrumbs?: Array<{ label: string; href?: string }>;
  actions?: React.ReactNode;
  /** The page's own content under its system's sections (the Ask chat's threads). */
  navExtra?: React.ReactNode;
}) {
  // The sections column is a static column from lg; below it, a drawer
  // (beside the rail on a tablet, alone on a phone, where the tab bar
  // replaces the rail).
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  // Community tenants never hold a Stripe subscription — skip the fetch
  // entirely rather than have it always resolve to "not past due".
  const { role } = useResilientSession();
  const nav = useConsoleNav();

  // Close on navigation so tapping a link doesn't leave the drawer covering
  // the page it just opened.
  useEffect(() => { setNavOpen(false); }, [pathname]);
  // On desktop the page body scrolls inside <main>, not the window (so the
  // rail stays put). The browser's scroll-to-top on navigation only
  // applies to the window, so reset the scroll container ourselves.
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => { mainRef.current?.scrollTo({ top: 0 }); }, [pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setNavOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);
  // `/` opens the command palette (paid) and `g` the systems switcher, from
  // anywhere — never while the person is typing, never with a modifier held.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || el?.isContentEditable) return;
      if (e.key === "/" && !IS_COMMUNITY) { e.preventDefault(); setPaletteOpen(true); }
      else if (e.key === "g" || e.key === "G") { e.preventDefault(); setSwitcherOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Every section is a jump target in the palette, named with its system.
  const sectionItems = useMemo<LocalPaletteItem[]>(
    () => nav.systems.flatMap((s) => s.sections.map((x) => ({
      id: `${s.id}/${x.id}`, label: nav.sectionName(s, x), hint: nav.sysName(s), onSelect: () => router.push(x.href),
    }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nav's helpers are rebuilt each render; the systems and labels are what change
    [nav.systems, nav.t],
  );

  return (
    // `md:h-screen` pins the shell to the viewport: the rail and the sections
    // keep their own scroll and the page body scrolls inside <main>.
    <div className="min-h-screen bg-background md:grid md:h-screen md:grid-cols-[64px_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] md:overflow-hidden lg:grid-cols-[64px_248px_minmax(0,1fr)]">
      {!IS_COMMUNITY && <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} localItems={sectionItems} localNeedsQuery />}
      <SystemSwitcher nav={nav} open={switcherOpen} onClose={() => setSwitcherOpen(false)} />
      <div className="hidden md:block md:min-h-0">
        <SystemRail nav={nav} onOpenSwitcher={() => setSwitcherOpen(true)} footer={<ProfileBlock compact />} />
      </div>
      {/* A link in the drawer closes it, even one that keeps the path (/ask?thread=…). */}
      <div
        onClick={(e) => { if ((e.target as HTMLElement).closest("a")) setNavOpen(false); }}
        className={cn(
          "fixed inset-y-0 left-0 z-50 transition-transform duration-200 ease-out md:left-16 lg:static lg:z-auto lg:min-h-0 lg:translate-x-0",
          navOpen ? "translate-x-0" : "-translate-x-[calc(100%_+_4rem)]",
        )}
      >
        <SectionColumn nav={nav} onOpenSwitcher={() => setSwitcherOpen(true)} extra={navExtra} footer={<div className="md:hidden"><ProfileBlock /></div>} />
      </div>
      {navOpen && (
        <button
          type="button"
          aria-label={nav.t("nav.closeSections")}
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-40 bg-foreground/30 backdrop-blur-[1px] lg:hidden"
        />
      )}
      <div className="flex min-h-screen min-w-0 flex-col overflow-hidden md:min-h-0">
        <TopBar breadcrumbs={breadcrumbs} actions={actions} onOpenNav={() => setNavOpen(true)} onOpenPalette={() => setPaletteOpen(true)} />
        {PastDueBanner && <PastDueBanner isAdmin={role === "admin"} />}
        {/* pb clears the phone's tab bar. */}
        <main ref={mainRef} className="flex-1 overflow-auto pb-20 md:pb-0">{children}</main>
      </div>
      <TabBar nav={nav} onOpenSections={() => setNavOpen(true)} />
    </div>
  );
}

/** The person's own menu: a round avatar at the foot of the rail (compact), or a full row at the foot of the phone's section drawer. */
function ProfileBlock({ compact }: { compact?: boolean }) {
  const { t } = useT();
  // See useResilientSession() for why this isn't a plain useSession() call
  // — without it, a session-fetch blip leaves this block (and its avatar)
  // stuck on the skeleton below forever, since next-auth's own client never
  // retries once a fetch has failed once.
  const { user } = useResilientSession();
  const router = useRouter();
  const monogram = initials((user?.name ?? user?.email ?? "?") as string);
  // Second line is the person's role in this workspace (what the rail is
  // about), not their email (which the menu already leads with).
  const role = (user as any)?.role as string | undefined;
  // t() returns the key itself when there is no string for it, which is how
  // "nav.role.developer" once showed up verbatim under someone's name. Fall
  // back to the role slug rather than the key if one is ever missing again.
  const roleKey = `nav.role.${role}`;
  const roleName = t(roleKey);
  const roleLabel = role ? (roleName === roleKey ? role : roleName) : (user?.email ?? "");

  // Same footprint while the session loads — no "Signed in" placeholder
  // text that then gets replaced by a name.
  if (!user) {
    if (compact) return <div className="h-[34px] w-[34px] shrink-0 rounded-full bg-primary-soft" aria-hidden="true" />;
    return (
      <div className="border-t border-sidebar-border px-2.5 py-2.5" aria-hidden="true">
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <div className="h-7 w-7 shrink-0 rounded-full bg-primary-soft" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="skeleton h-3 w-20" />
            <div className="skeleton h-2.5 w-12" />
          </div>
        </div>
      </div>
    );
  }

  const trigger = compact ? (
    <button
      type="button"
      aria-label={`${user?.name ?? user?.email ?? t("account.signedIn")}, ${roleLabel}`}
      className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full bg-primary-soft text-xs font-semibold text-primary-ink transition-shadow hover:ring-2 hover:ring-border"
    >
      {monogram}
    </button>
  ) : null;

  return (
    <div className={compact ? undefined : "border-t border-sidebar-border px-2.5 py-2.5"}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {trigger ?? <button className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-2xs font-semibold text-primary-ink">
              {monogram}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold leading-tight">{user?.name ?? user?.email ?? t("account.signedIn")}</p>
              <p className="truncate text-xs text-faint">{roleLabel}</p>
            </div>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-faint" />
          </button>}
        </DropdownMenuTrigger>
        <DropdownMenuContent side={compact ? "right" : "top"} align={compact ? "end" : "start"} className="w-56">
          <DropdownMenuLabel className="flex items-center justify-between gap-2">
            <span className="truncate">{user?.name ?? t("account.fallback")}</span>
            <span className="shrink-0 font-mono text-2xs font-normal text-faint">v{CURRENT_VERSION}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {compact && <p className="truncate px-2 pb-1.5 text-xs text-faint">{roleLabel}</p>}
          <DropdownMenuItem onClick={() => router.push("/account")}>
            <UserRound className="mr-2 h-4 w-4" /> {t("nav.account")}
          </DropdownMenuItem>
          {/* The Executive view (/executive) — what executives see; not in the Community edition. */}
          {!IS_COMMUNITY && (
            <DropdownMenuItem onClick={() => router.push("/executive")}>
              <Monitor className="mr-2 h-4 w-4" /> {t("nav.executiveView")}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => signOut({ redirect: false }).then(() => window.location.assign("/api/auth/end-session"))}>
            <LogOut className="mr-2 h-4 w-4" /> {t("action.signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Workspace switcher. Reads `session.user.memberships` (computed at signin
 * by the JWT callback) and lets the user flip the active tenant via
 * `useSession().update({ activeTenantId })`. The jwt() callback in auth.ts
 * picks up the trigger="update" arg and rewrites token.tenantId/role/id to
 * the matching User row, then the session callback exposes it.
 */
function TenantSwitcher() {
  const { t } = useT();
  // Shared with the Executive header — see lib/useWorkspaceSwitch.ts.
  const { update, hasSession, memberships, activeTenantId, active, busy, setBusy, switchTo: switchWorkspace, refreshOnOpen } = useWorkspaceSwitch();
  const data = hasSession ? { user: true } : null;
  // Controlled so the "Create a workspace" item can close the menu itself
  // (see its onSelect below) — onSelect's own preventDefault() suppresses
  // Radix's normal auto-close-on-select, so without this the dropdown was
  // staying open and rendering on top of the Dialog it triggers.
  const [menuOpen, setMenuOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Portal-mount detection for the full-screen overlay below — `document`
  // doesn't exist on the server, and the sidebar wrapper's own
  // `lg:translate-x-0` (for the mobile slide-in drawer) establishes a
  // containing block for `position: fixed` descendants, so a plain
  // `fixed inset-0` here resolves against the sidebar column instead of
  // the viewport. Same gotcha and fix as CommentButton.tsx.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Until the session resolves, reserve the block's exact footprint (mark +
  // two lines) instead of rendering nothing — otherwise the whole rail
  // jumps down by 44px on every cold load once the name arrives.
  if (!data?.user) {
    return (
      <div className="flex shrink-0 items-center gap-2.5 px-1.5 py-1" aria-hidden="true">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground text-background md:hidden">
          <CurfLogo variant="icon" size={18} mono />
        </span>
        <div className="hidden space-y-1.5 sm:block">
          <div className="skeleton h-3 w-24" />
          <div className="skeleton h-2.5 w-14" />
        </div>
      </div>
    );
  }

  // Land where that workspace's role lands ("/" redirects through
  // landingPathFor), not wherever the switch was clicked from — a page scoped
  // to the old tenant is jarring context. A full navigation (inside the hook),
  // not router.push()+refresh(): that silently dropped from a closing Radix item.
  const switchTo = (tenantId: string) => switchWorkspace(tenantId, "/");

  /**
   * Create another workspace for the signed-in account. Previously this
   * pushed to /signup, which asked an already-authenticated admin for their
   * email and password again — and a mistyped password there could leave the
   * account unable to sign in (see POST /api/workspaces). Now it takes just a
   * name, then refreshes the membership list and switches to the new tenant.
   */
  async function createWorkspace() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? "Could not create workspace");
      // Pull the new membership into the token, then make it active.
      await update({ refreshMemberships: true });
      await update({ activeTenantId: json.tenant.id });
      setCreateOpen(false);
      setNewName("");
      // Reuse switchTo()'s full-screen overlay (below) for this same dead
      // gap — the dialog closes here but the fetch is already done, so
      // there'd otherwise be a moment with nothing on screen indicating
      // progress until the full navigation actually lands.
      setBusy(true);
      // Full navigation, not router.push()+refresh() — see switchTo()'s
      // comment above for why the soft-nav version doesn't reliably fire.
      window.location.href = "/";
    } catch (e: any) {
      setCreateError(e?.message ?? "Could not create workspace");
    } finally { setCreating(false); }
  }

  return (
    // The workspace block in the top bar: workspace name and tier (the Curf mark is at the head of the rail; on a phone, which has no rail, it stays here).
    <div className="min-w-0 shrink-0">
      {/* window.location.href below is a full page unload — the trigger
          button's own disabled/dim state (further down) is easy to miss and
          leaves the screen looking frozen for however long the new page
          takes to paint. This covers the whole viewport the instant a
          switch starts, through the session update and the unload itself. */}
      {busy && mounted && createPortal(
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-background/80 backdrop-blur-sm">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-sm font-medium text-foreground">{t("workspace.switching")}</p>
        </div>,
        document.body,
      )}
      <DropdownMenu open={menuOpen} onOpenChange={(o) => { setMenuOpen(o); void refreshOnOpen(o); }}>
        <DropdownMenuTrigger asChild>
          <button
            disabled={busy}
            className="flex max-w-[220px] items-center gap-2.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted disabled:opacity-60 max-sm:max-w-[170px]"
            title={t("nav.switchWorkspace")}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground text-background md:hidden">
              <CurfLogo variant="icon" size={18} mono />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold leading-tight">
                {active?.tenantName ?? t("nav.workspaceFallback")}
              </p>
              {/* Tier once the session carries it; the slug for older tokens
                  (opening this menu refreshes memberships and back-fills it). */}
              <p className="truncate text-xs text-faint max-sm:hidden">{tierLabel(active?.tenantTier) ?? active?.tenantSlug ?? ""}</p>
            </div>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-faint" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="w-60">
          <DropdownMenuLabel className="text-2xs uppercase tracking-wider text-muted-foreground">
            {t("nav.yourWorkspaces")}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {memberships.length === 0 ? (
            <DropdownMenuItem disabled className="text-xs italic">
              {t("nav.noMemberships")}
            </DropdownMenuItem>
          ) : (
            memberships.map((m) => (
              <DropdownMenuItem
                key={m.tenantId}
                onClick={() => switchTo(m.tenantId)}
                className="flex items-start gap-2"
              >
                <div className="mt-0.5 w-3.5">
                  {m.tenantId === activeTenantId && <Check className="h-3.5 w-3.5 text-primary" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">
                    {m.tenantName}
                    {m.isVirtual && (
                      <span className="ml-1.5 rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-primary" title={t("nav.orgOversightHint")}>
                        {t("nav.orgOversight")}
                      </span>
                    )}
                  </p>
                  <p className="truncate text-2xs text-muted-foreground">
                    {m.tenantSlug} - <span className="capitalize">{m.role}</span>
                  </p>
                </div>
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => { e.preventDefault(); setMenuOpen(false); setCreateOpen(true); }}
          >
            <Plus className="mr-2 h-4 w-4" /> {t("action.createWorkspace")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={(o) => { setCreateOpen(o); if (!o) setCreateError(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("action.createWorkspace")}</DialogTitle>
            <DialogDescription>
              {t("workspace.createDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Label htmlFor="new-workspace-name">{t("workspace.nameLabel")}</Label>
            <Input
              id="new-workspace-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && newName.trim() && !creating) void createWorkspace(); }}
              placeholder={t("workspace.namePlaceholder")}
              autoFocus
            />
            {createError && <p className="text-xs text-destructive">{createError}</p>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>
              {t("action.cancel")}
            </Button>
            <Button onClick={() => void createWorkspace()} disabled={creating || !newName.trim()}>
              {creating ? t("action.creating") : t("action.createWorkspace")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TopBar({
  breadcrumbs,
  actions,
  onOpenNav,
  onOpenPalette,
}: {
  breadcrumbs?: Array<{ label: string; href?: string }>;
  actions?: React.ReactNode;
  onOpenNav?: () => void;
  onOpenPalette?: () => void;
}) {
  const { t } = useT();
  const crumbs = breadcrumbs ?? [];
  return (
    // From md the bar is one fixed h-14 row, so nothing in it may wrap — a long
    // report name used to break onto three lines and spill out of the bar.
    // Breadcrumbs truncate, and the page's actions (up to ~9 controls on a
    // report) keep their size and scroll if the viewport can't fit them. On a
    // phone the page's actions take a second row and wrap, because a hidden
    // sideways scroll cut "Generate" and "New" off at the edge.
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-background px-4 py-2 sm:px-5 md:h-14 md:flex-nowrap md:py-0">
      {/* Tablet only: a phone opens the same drawer from More in its tab bar. */}
      <button
        type="button"
        onClick={onOpenNav}
        aria-label={t("nav.openSections")}
        className="-ml-1 hidden shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground md:block lg:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>
      <TenantSwitcher />
      <span className="hidden h-5 w-px shrink-0 bg-border sm:block" aria-hidden="true" />
      {/* min-w keeps the current page readable even when the action row is
          long — otherwise a report with ~9 controls squeezed the breadcrumb
          down to a single character. A phone shows no crumb, so none there. */}
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1.5 text-sm sm:min-w-[7rem]">
        {crumbs.map((b, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <div
              key={i}
              // Only the current page's crumb survives on narrow screens;
              // the ancestors are still reachable from the sidebar.
              className={cn("flex min-w-0 items-center gap-1.5", !isLast && "hidden md:flex", isLast && "max-sm:hidden")}
            >
              {i > 0 && <span className="shrink-0 text-muted-foreground/60">/</span>}
              {b.href ? (
                <Link
                  href={b.href}
                  title={b.label}
                  className="truncate rounded px-1 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {b.label}
                </Link>
              ) : (
                <span className="truncate font-medium text-foreground" title={b.label}>
                  {b.label}
                </span>
              )}
            </div>
          );
        })}
      </nav>
      {/* The palette searches the catalog and hands off to Ask Curf — both paid. */}
      {!IS_COMMUNITY && <AskBar onOpen={onOpenPalette} />}
      {actions && (
        <div className="order-last flex w-full flex-wrap items-center gap-2 md:order-none md:w-auto md:min-w-0 md:shrink md:flex-nowrap md:overflow-x-auto md:whitespace-nowrap md:[-ms-overflow-style:none] md:[scrollbar-width:none] md:[&::-webkit-scrollbar]:hidden">
          {actions}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
        {!IS_COMMUNITY && <AiCreditsChip />}
        <MenuHelpDialog />
        <LanguageSwitcher compact />
      </div>
    </header>
  );
}

/**
 * The global search/ask trigger. Opens the CommandPalette (search across
 * reports, lake tables, and more, or hand the query to Ask Curf) — dressed
 * as an input to advertise the `/` shortcut AppShell registers. Hidden
 * below xl so a report's own action row (up to ~9 controls) keeps its room.
 */
function AskBar({ onOpen }: { onOpen?: () => void }) {
  const { t } = useT();
  // The Ask page is itself the ask field (the "/" shortcut still opens the palette).
  const onAsk = usePathname()?.startsWith("/ask");
  if (onAsk) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={t("nav.askCurf")}
      className="hidden h-9 w-[300px] shrink-0 items-center gap-2 rounded-md border border-transparent bg-muted px-3 text-[13px] text-faint transition-colors hover:border-border xl:flex"
    >
      <Sparkles className="h-[15px] w-[15px] shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate text-left">{t("nav.askPlaceholder")}</span>
      <kbd className="rounded-sm border border-border bg-card px-1.5 py-px font-mono text-2xs text-faint">/</kbd>
    </button>
  );
}
