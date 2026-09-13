"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  FileText, Database, LogOut, ChevronDown, Plus, Search, LayoutTemplate, Clock,
  Shield, ShieldCheck, Users, Radio, KeyRound, History, Building2, Check, CreditCard, Sparkles,
  Monitor, Mail, Layers, Activity, Webhook, Globe, Zap, Bot, NotebookText,
  Workflow, LayoutDashboard, Wand2, Menu, Ruler, Target, Rocket, Terminal, Tv, Library, Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
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
import { MenuHelpDialog } from "@/components/layout/MenuHelpDialog";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { eeClient } from "@/ee/client";

/** Community edition: paid nav, palette and count badges are absent. */
const IS_COMMUNITY = eeClient.edition === "community";
import { CurfLogo } from "@/components/common/CurfLogo";
import { isPlatformAdmin } from "@/lib/platformAdmin";
import { onNavCountsRefresh } from "@/lib/navCounts";
import { useResilientSession } from "@/lib/useResilientSession";
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
}: {
  children: React.ReactNode;
  breadcrumbs?: Array<{ label: string; href?: string }>;
  actions?: React.ReactNode;
}) {
  // Below lg the rail left only ~125px of content on a phone — KPI values
  // rendered as "$7…". The rail becomes an off-canvas drawer there.
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pathname = usePathname();

  // Close on navigation so tapping a link doesn't leave the drawer covering
  // the page it just opened.
  useEffect(() => { setNavOpen(false); }, [pathname]);
  // On desktop the page body scrolls inside <main>, not the window (so the
  // sidebar stays put). The browser's scroll-to-top on navigation only
  // applies to the window, so reset the scroll container ourselves.
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => { mainRef.current?.scrollTo({ top: 0 }); }, [pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setNavOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);
  // `/` opens the command palette from anywhere — the top bar's ask field
  // advertises it. Never while the person is typing, and never with a
  // modifier held. The palette itself owns Escape/Enter/arrow keys once open.
  useEffect(() => {
    if (IS_COMMUNITY) return; // no palette in Community
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || el?.isContentEditable) return;
      e.preventDefault();
      setPaletteOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    // `lg:h-screen` pins the shell to the viewport: the sidebar column keeps
    // its own scroll (nav inside <Sidebar> is overflow-y-auto) and the page
    // body scrolls inside <main>, so the left nav never scrolls away.
    <div className="min-h-screen bg-background lg:grid lg:h-screen lg:grid-cols-[224px_1fr] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {/* Desktop: a static grid column. Small screens: a slide-in panel. */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-[224px] transition-transform duration-200 ease-out lg:static lg:z-auto lg:w-auto lg:translate-x-0",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <Sidebar />
      </div>
      {navOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-40 bg-foreground/30 backdrop-blur-[1px] lg:hidden"
        />
      )}
      <div className="flex min-h-screen min-w-0 flex-col overflow-hidden lg:min-h-0">
        <TopBar breadcrumbs={breadcrumbs} actions={actions} onOpenNav={() => setNavOpen(true)} onOpenPalette={() => setPaletteOpen(true)} />
        <main ref={mainRef} className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  match?: (pathname: string) => boolean;
  badge?: string | number | null;
  /**
   * The count needs a human (e.g. requests awaiting *my* approval), so it
   * renders in the critical colour. Everything else stays faint — a count is
   * information, not an alarm.
   */
  critical?: boolean;
  disabled?: boolean;
};

type NavSection = {
  label?: string;
  items: NavItem[];
  adminOnly?: boolean;
  /** Hide this section entirely for role="viewer" - they're consumers, not editors. */
  editorPlus?: boolean;
};
type NavItemExt = NavItem & { editorPlus?: boolean };

/** Nav entries that exist in the Community edition (everything else is a
 *  paid route, or — API keys — a Growth feature the pricing page lists). */
const COMMUNITY_NAV = [
  "/reports", "/on-screen", "/dashboards", "/tables", "/connections", "/templates",
  "/admin/tenant", "/admin/users", "/admin/audit", "/admin/compliance", "/admin/release-log",
];

function Sidebar() {
  const { t } = useT();
  // See useResilientSession() for why this isn't a plain useSession() call:
  // it self-heals next-auth's client from a stuck-null-session state (the
  // "sidebar menu disappeared" bug) instead of requiring a hard refresh.
  const { role, email: sessionEmail } = useResilientSession();
  // Platform-admin (NOT tenant-admin) — only Anthropic ops staff. Email-based
  // check via @/lib/platformAdmin so the same predicate guards the route + the
  // sidebar entry. Session email now comes from the server-seeded session
  // (see useResilientSession.ts), so it's already correct on first paint —
  // no hydration gate needed to avoid an SSR/CSR mismatch.
  const isPlatAdmin = sessionEmail ? isPlatformAdmin(sessionEmail) : false;
  const [counts, setCounts] = useState<{
    reports?: number; sources?: number; dashboards?: number; onScreen?: number;
    notebooks?: number; templates?: number; decisions?: number; metrics?: number;
    inbox?: number; watchers?: number; dataQuality?: number;
  }>({});

  useEffect(() => {
    async function loadCounts() {
      try {
        const count = (url: string) => fetch(url, { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null);
        // Paid routes don't exist in the Community edition — skip them
        // rather than collecting 404s in the console.
        const paid = (url: string) => (IS_COMMUNITY ? Promise.resolve(null) : count(url));
        const [rep, ds, dash, onScreen, nb, tpl, dec, met, opStats, watch, dq] = await Promise.all([
          count("/api/reports?_count=1"),
          count("/api/data-sources"),
          count("/api/dashboards"),
          count("/api/on-screen"),
          paid("/api/v1/notebooks"),
          paid("/api/operate/templates"),
          paid("/api/decisions"),
          paid("/api/metrics"),
          // Inbox count = requests whose current approval step is *mine*
          // (pendingMyApproval) — the one number in the rail that needs a
          // human, which is why it alone renders in the critical colour.
          paid("/api/operate/stats"),
          paid("/api/watchers"),
          // Admin-only route — 403s for editors, badge just stays hidden for them.
          paid("/api/admin/dq"),
        ]);
        setCounts({
          reports: Array.isArray(rep?.items) ? rep.items.length : undefined,
          sources: Array.isArray(ds?.items) ? ds.items.length : undefined,
          dashboards: Array.isArray(dash?.items) ? dash.items.length : undefined,
          onScreen: Array.isArray(onScreen?.items) ? onScreen.items.length : undefined,
          notebooks: Array.isArray(nb?.items) ? nb.items.length : undefined,
          templates: Array.isArray(tpl?.items) ? tpl.items.length : undefined,
          decisions: Array.isArray(dec?.items) ? dec.items.length : undefined,
          metrics: Array.isArray(met?.items) ? met.items.length : undefined,
          inbox: typeof opStats?.pendingMyApproval === "number" ? opStats.pendingMyApproval : undefined,
          watchers: Array.isArray(watch?.items) ? watch.items.length : undefined,
          dataQuality: Array.isArray(dq?.items) ? dq.items.length : undefined,
        });
      } catch { /* ignore */ }
    }
    loadCounts();
    // Same-page create/delete flows (e.g. the Dashboards manager) call
    // refreshNavCounts() so this badge doesn't stay stale until a reload.
    return onNavCountsRefresh(loadCounts);
  }, []);

  // ── Reorganized 5-group structure ──────────────────────────────────
  // The sidebar grew organically as we shipped 200+ features. This pass
  // re-groups every item by *who uses it* and *what stage of the workflow
  // it's in*, instead of by author convenience.
  //
  //   WORKSPACE — read + author       (Brief, Reports, Dashboards, Notebooks)
  //   OPERATE   — take action         (Inbox, Templates, Action Center, Watchers)
  //   DATA      — where data lives    (Tables, Catalog, Connections, Agent, Quality)
  //   DISCOVER  — share + import      (Marketplace, Block templates)
  //   ADMIN     — governance + infra  (Tenant, Users, Billing, Integrations, Audit, …)
  //
  // The big move: Operate + Action Center + Watchers come OUT of Admin
  // and into a top-level Operate group, because directors approving
  // requests aren't admins. Admin shrinks 24 → ~9 by merging settings
  // pages and putting modern-stack/integrations/access into umbrella
  // entries (each links to a tabbed page that subsumes the old siblings).
  const sections: NavSection[] = [
    {
      label: t("nav.section.workspace"),
      items: [
        // Master Builder — generative entry point. Sits at the very top
        // because it's the "I'm new and want a working workspace fast"
        // path, plus it's the recurring iteration surface for ongoing
        // builds. Editor + admin only — viewers (and executives) don't author.
        ...(role !== "viewer" && role !== "executive" ? [
          { href: "/build", label: t("nav.masterBuilder"), icon: Wand2,
            match: (p: string) => p === "/build" || p.startsWith("/build/") } as NavItemExt,
        ] : []),
        // Brief — daily exec narrative; primary "what changed" surface.
        { href: "/brief", label: t("nav.brief"), icon: Zap,
          match: (p: string) => p === "/brief" || p.startsWith("/brief/") } as NavItemExt,
        // Ask Curf (workspace-wide) — the "ask from anywhere" entry point,
        // no report picked first. Gated Business+ server-side; the page
        // itself renders the UpgradeLock for tenants below that tier.
        { href: "/ask", label: t("nav.askCurf"), icon: Sparkles,
          match: (p: string) => p === "/ask" || p.startsWith("/ask/") } as NavItemExt,
        { href: "/reports", label: t("nav.reports"), icon: FileText, badge: counts.reports ?? null,
          match: (p) => p === "/reports" || p.startsWith("/reports/") },
        // On Screen — always-passive wall display, a separate menu from
        // Dashboards (not a toggle on it): drill-through/Why?/Comment/Ask/
        // Embed/forecast controls never appear here. Visibility ACL gates
        // which displays each user sees, same as Dashboards.
        { href: "/on-screen", label: t("nav.onScreen"), icon: Tv, badge: counts.onScreen ?? null,
          match: (p: string) => p === "/on-screen" || p.startsWith("/on-screen/") } as NavItemExt,
        // Dashboards are wall-display surfaces — visible to viewers too, since
        // a dashboard is just a curated read-only view of reports they can
        // already access. Visibility ACL gates which dashboards each user
        // sees. /dashboards itself is the grid/KPI hub (Analysis App roadmap
        // Day 1); /dashboards/manage (linked from the hub, not from the
        // sidebar) has the full create/edit/kiosk-token CRUD screen — kept
        // as one nav entry since both are views over the same rows.
        { href: "/dashboards", label: t("nav.dashboards"), icon: Monitor, badge: counts.dashboards ?? null,
          match: (p: string) => p === "/dashboards" || p.startsWith("/dashboards/") } as NavItemExt,
        // Notebooks moved up from Data — they're exploratory authoring
        // (SQL/chart/markdown/agent cells), conceptually closer to Reports
        // than to "where data lives".
        ...(role !== "viewer" && role !== "executive" ? [
          { href: "/notebooks", label: t("nav.notebooks"), icon: NotebookText, badge: counts.notebooks ?? null,
            match: (p: string) => p.startsWith("/notebooks") } as NavItemExt,
        ] : []),
      ],
    },
    // ── OPERATE ─────────────────────────────────────────────────────
    // New top-level group. The unicorn pitch surface — every path from
    // "noticed something" to "took action" lives here. Authoring items
    // (Inbox/Templates/Insights/Action Center) are editor+/admin only —
    // viewer and executive don't approve requests or run templates.
    // Watchers + Decisions are the exception (2026-08 role restructure):
    // both are visible read-only to every role, including viewer and
    // executive — the pages themselves (not the sidebar) gate the actual
    // mutating actions (create/edit/run a watcher, log a decision).
    {
      label: t("nav.section.operate"),
      items: [
        ...(role !== "viewer" && role !== "executive" ? [
          // The inbox is the home base — what's awaiting me, what I sent,
          // what's in flight, what's done.
          { href: "/operate", label: t("nav.inbox"), icon: Workflow, badge: counts.inbox ?? null, critical: true,
            match: (p: string) => p === "/operate" || (p.startsWith("/operate/") && !p.startsWith("/operate/templates") && !p.startsWith("/operate/incidents") && !p.startsWith("/operate/watchers") && !p.startsWith("/operate/insights")) } as NavItemExt,
          { href: "/operate/templates", label: t("nav.operateTemplates"), icon: LayoutTemplate, badge: counts.templates ?? null,
            match: (p: string) => p.startsWith("/operate/templates") } as NavItemExt,
          // Insights — tenant-wide rollups (volume, SLA hit rate, value
          // through Curf). The C-suite view of Operate. Sits right under
          // Templates because it visualises template performance.
          { href: "/operate/insights", label: t("nav.insights"), icon: LayoutDashboard,
            match: (p: string) => p.startsWith("/operate/insights") } as NavItemExt,
          // Action Center — incident timeline (watcher fires + dispatched
          // activations + human acks). Was buried in Admin; promoted here
          // because it's an exec-facing "what fired and who handled it" view.
          { href: "/operate/incidents", label: t("nav.actionCenter"), icon: Activity,
            match: (p: string) => p.startsWith("/operate/incidents") } as NavItemExt,
        ] : []),
        // Watchers — the auto-trigger engine. Naturally adjacent to the
        // manual-approval inbox; both are paths into the same Operate runtime.
        { href: "/operate/watchers", label: t("nav.watchers"), icon: Radio, badge: counts.watchers ?? null,
          match: (p: string) => p.startsWith("/operate/watchers") } as NavItemExt,
        // Decisions — did the action someone logged actually move the
        // number? Closes the loop Operate's other views only open.
        { href: "/decisions", label: t("nav.decisions"), icon: Target, badge: counts.decisions ?? null,
          match: (p: string) => p.startsWith("/decisions") } as NavItemExt,
      ],
    },
    // ── DATA ────────────────────────────────────────────────────────
    ...(role !== "viewer" && role !== "executive" ? [{
      label: t("nav.section.data"),
      items: [
        // Curf Tables (managed table store) — first in the group because
        // for a no-warehouse customer this is the entry point.
        { href: "/tables", label: t("nav.tables"), icon: Database, badge: null,
          match: (p: string) => p.startsWith("/tables") } as NavItemExt,
        // Cross-resource search: lake tables + MVs + reports + saved views
        // + connections. The unified browser tenants reach for once their
        // catalog grows past 50 rows.
        { href: "/catalog", label: t("nav.catalog"), icon: Search, badge: null,
          match: (p: string) => p.startsWith("/catalog") } as NavItemExt,
        // Semantic Metric Layer — one governed number per name, so Ask/
        // Brief/Watcher all agree on what "Revenue" means. Sits next to
        // Catalog: both are about naming things consistently, not raw data.
        { href: "/metrics", label: t("nav.metrics"), icon: Ruler, badge: counts.metrics ?? null,
          match: (p: string) => p.startsWith("/metrics") } as NavItemExt,
        // Connections — collapses old /data-sources + /connectors into one
        // entry. The page itself has "Managed" / "Available" tabs.
        { href: "/connections", label: t("nav.connections"), icon: Database, badge: counts.sources ?? null,
          match: (p: string) => p.startsWith("/connections") || p.startsWith("/data-sources") || p.startsWith("/connectors") } as NavItemExt,
        // Knowledge Centre (D2) — PDF/DOCX/text corpus + grounded Q&A.
        // Sits next to Connections: both are "bring your own content" surfaces.
        { href: "/knowledge", label: t("nav.knowledge"), icon: Library, badge: null,
          match: (p: string) => p.startsWith("/knowledge") } as NavItemExt,
        // Agent — multi-turn tool-using conversation over data.
        { href: "/agent", label: t("nav.agent"), icon: Bot, badge: null,
          match: (p: string) => p.startsWith("/agent") } as NavItemExt,
        // Data quality — moved out of Admin. It's data-plane concern, not
        // governance. Lives next to Tables + Catalog where DQ rules apply.
        { href: "/data/quality", label: t("nav.dataQuality"), icon: ShieldCheck, badge: counts.dataQuality ?? null,
          match: (p: string) => p.startsWith("/data/quality") || p.startsWith("/admin/quality") } as NavItemExt,
      ],
    }] : []),
    // ── DISCOVER ────────────────────────────────────────────────────
    // Cross-tenant share/import surfaces. Stays light (2 items) on purpose
    // — these are "lookup something to start with" not "things I work in".
    ...(role !== "viewer" && role !== "executive" ? [{
      label: t("nav.section.discover"),
      items: [
        { href: "/marketplace", label: t("nav.marketplace"), icon: Globe,
          match: (p: string) => p.startsWith("/marketplace") } as NavItemExt,
        // Block templates for the report designer. Distinct from Operate
        // templates (which are workflow recipes). Renamed in label-only
        // to "Block library" to disambiguate.
        { href: "/templates", label: t("nav.blockLibrary"), icon: LayoutTemplate,
          match: (p: string) => p.startsWith("/templates") } as NavItemExt,
      ],
    }] : []),
    // ── ADMIN ───────────────────────────────────────────────────────
    // Slimmed from 24 to 9. Each item that *could* live here but is used
    // by non-admins moved out. What's left is genuine governance + infra.
    {
      label: t("nav.section.admin"),
      adminOnly: true,
      items: [
        // Platform-admin-only: invite-only beta queue. Gated behind
        // isPlatformAdmin (Anthropic ops staff), so even tenant admins
        // don't see this entry. The page itself 404s for non-platform-admins
        // — sidebar visibility is just a polish layer.
        ...(isPlatAdmin ? [
          { href: "/admin/waitlist", label: t("nav.waitlist"), icon: Mail,
            match: (p: string) => p.startsWith("/admin/waitlist") } as NavItemExt,
        ] : []),
        // Tenant settings — rolls in old "Brief settings" + "Digest" as
        // tabs on the same page (settings, branding, brief config, digest).
        { href: "/admin/tenant", label: t("nav.tenant"), icon: Building2,
          match: (p) => p.startsWith("/admin/tenant") || p.startsWith("/admin/brief") || p.startsWith("/admin/digest") },
        // Users + Roles merged. The page has tabs for both.
        { href: "/admin/users", label: t("nav.usersRoles"), icon: Users,
          match: (p) => p.startsWith("/admin/users") || p.startsWith("/admin/roles") },
        // Access — points directly at the API-keys page since the unified
        // /admin/access tabbed shell hasn't shipped yet. Sidebar still
        // highlights the right tab when the user lands on /api-keys, /sso,
        // or the eventual /access page.
        { href: "/admin/api-keys", label: t("nav.access"), icon: KeyRound,
          match: (p) => p.startsWith("/admin/access") || p.startsWith("/admin/sso") || p.startsWith("/admin/api-keys") },
        // API Explorer — Swagger-style live tester for the public /api/v1
        // surface. Sits right after Access since minting a key there is
        // the first step to actually calling anything from here.
        { href: "/admin/api-explorer", label: t("nav.apiExplorer"), icon: Terminal,
          match: (p) => p.startsWith("/admin/api-explorer") },
        { href: "/admin/billing", label: t("nav.billing"), icon: CreditCard,
          match: (p) => p.startsWith("/admin/billing") },
        // Integrations umbrella — Slack/Teams/Discord + Webhooks (HMAC) +
        // Activations (reverse-ETL push). All "Curf reaching outside" surfaces.
        { href: "/admin/integrations", label: t("nav.integrations"), icon: Webhook,
          match: (p) => p.startsWith("/admin/integrations") || p.startsWith("/admin/webhooks") || p.startsWith("/admin/activations") },
        // (Schedules entry removed — there's no dedicated /admin/schedules
        // page. Delivery schedules live inside report viewer "Schedule"
        // dialogs; watcher schedules live on /operate/watchers; brief
        // delivery cron lives in /admin/brief/delivery. The Schedule
        // model itself doesn't need its own admin surface.)
        // Modern data stack — points at /admin/external-tables until the
        // unified tabbed shell lands. Both External tables + dbt highlight
        // the same nav entry via the match() fallback.
        { href: "/admin/external-tables", label: t("nav.modernStack"), icon: Layers,
          match: (p) => p.startsWith("/admin/modern-stack") || p.startsWith("/admin/external-tables") || p.startsWith("/admin/dbt") },
        // Observability — points at /admin/audit until the unified
        // tabbed Observability shell lands. Sidebar still highlights for
        // /audit, /usage, /lineage so navigation feels consistent across
        // the three related pages.
        { href: "/admin/audit", label: t("nav.observability"), icon: Activity,
          match: (p) => p.startsWith("/admin/observability") || p.startsWith("/admin/audit") || p.startsWith("/admin/usage") || p.startsWith("/admin/lineage") || p.startsWith("/admin/actions") },
        // Workspace setup — one-click bootstrap (B2B SaaS preset, etc.).
        { href: "/admin/workspace-templates", label: t("nav.workspaceSetup"), icon: Sparkles,
          match: (p) => p.startsWith("/admin/workspace-templates") },
        // Compliance — public-facing security/compliance summary.
        { href: "/admin/compliance", label: t("nav.compliance"), icon: Shield,
          match: (p) => p.startsWith("/admin/compliance") },
        // Release log — what shipped in each version. Hand-maintained,
        // see src/lib/releaseLog.ts.
        { href: "/admin/release-log", label: t("nav.releaseLog"), icon: Rocket,
          match: (p) => p.startsWith("/admin/release-log") },
      ],
    },
  ];

  // The rail is deliberately quiet: the workspace block doubles as the
  // brand and the switcher, the primary "New report" action lives in the
  // Reports page header where the object lives (once), and there is no
  // search box until there is a real command palette behind it. The 10px
  // side padding is load-bearing — the active item's 2px accent mark is
  // offset by exactly that much so it sits flush on the rail's edge.
  // Community edition: only the surfaces that exist in that build. Paid
  // pages aren't gated here, they're absent (see scripts/community-export),
  // so a link would just 404. Sections left empty disappear with them.
  const visibleSections = IS_COMMUNITY
    ? sections
        .map((section) => ({ ...section, items: section.items.filter((item) => COMMUNITY_NAV.some((p) => item.href === p || item.href.startsWith(p + "/"))) }))
        .filter((section) => section.items.length > 0)
    : sections;

  return (
    <aside className="flex h-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <TenantSwitcher />

      <nav className="flex-1 overflow-y-auto px-2.5 pb-3">
        {visibleSections.map((section, si) => {
          if (section.adminOnly && role !== "admin") return null;
          return <Section key={si} section={section} />;
        })}
      </nav>

      <ProfileBlock />
    </aside>
  );
}

function Section({ section }: { section: NavSection }) {
  const { t } = useT();
  const pathname = usePathname() ?? "";
  return (
    <div>
      {section.label && (
        // The label's top padding is the only separator between groups —
        // no rules, no extra gaps.
        <p className="px-3 pb-2 pt-4 text-[11px] font-medium uppercase tracking-[.06em] text-faint">
          {section.label}
        </p>
      )}
      <div className="space-y-0.5">
      {section.items.map((it) => {
        const Icon = it.icon;
        const active = it.match
          ? it.match(pathname)
          : pathname === it.href || pathname.startsWith(it.href + "/");
        // Active = ink weight plus a 2px accent mark on the rail's edge, not
        // a filled pill. The accent is reserved for what you can act on;
        // "where am I" is answered by weight alone.
        const base = "relative flex h-9 items-center gap-2.5 rounded-md pl-3 pr-2 text-[13px] font-medium transition-colors";
        const classes = cn(
          base,
          active
            ? "font-semibold text-foreground before:absolute before:-left-2.5 before:bottom-2 before:top-2 before:w-0.5 before:rounded-[1px] before:bg-primary before:content-['']"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
          it.disabled && "cursor-not-allowed opacity-75 hover:bg-transparent hover:text-muted-foreground"
        );
        // A count of zero is not information; render nothing.
        const n = typeof it.badge === "number" ? it.badge : Number(it.badge ?? 0);

        const content = (
          <>
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{it.label}</span>
            {n > 0 && (
              <span
                className={cn(
                  "ml-auto font-mono text-xs tabular-nums",
                  it.critical ? "font-medium text-destructive" : "text-faint",
                )}
                title={it.critical ? t("nav.awaitingTitle").replace("{n}", String(n)) : undefined}
              >
                {n}
              </span>
            )}
            {it.disabled && (
              <span className="ml-auto font-mono text-[11px] text-faint">
                {t("nav.soon")}
              </span>
            )}
          </>
        );

        if (it.disabled) return <div key={it.href} className={classes}>{content}</div>;
        return <Link key={it.href} href={it.href} className={classes}>{content}</Link>;
      })}
      </div>
    </div>
  );
}

function ProfileBlock() {
  const { t } = useT();
  const { data } = useSession();
  const user = data?.user;
  const router = useRouter();
  const initials = (user?.name ?? user?.email ?? "?")
    .split(/\s+/).map((s) => s[0]).slice(0, 2).join("").toUpperCase();
  // Second line is the person's role in this workspace (what the rail is
  // about), not their email (which the menu already leads with).
  const role = (user as any)?.role as string | undefined;
  const roleLabel = role ? t(`nav.role.${role}`) : (user?.email ?? "");

  // Same footprint while the session loads — no "Signed in" placeholder
  // text that then gets replaced by a name.
  if (!user) {
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

  return (
    <div className="border-t border-sidebar-border px-2.5 py-2.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[11px] font-semibold text-primary-ink">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold leading-tight">{user?.name ?? user?.email ?? t("account.signedIn")}</p>
              <p className="truncate text-xs text-faint">{roleLabel}</p>
            </div>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-faint" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-56">
          <DropdownMenuLabel className="flex items-center justify-between gap-2">
            <span className="truncate">{user?.name ?? t("account.fallback")}</span>
            <span className="shrink-0 font-mono text-[10px] font-normal text-faint">v{CURRENT_VERSION}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => router.push("/reports")}>
            <FileText className="mr-2 h-4 w-4" /> {t("nav.reports")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push("/data-sources")}>
            <Database className="mr-2 h-4 w-4" /> {t("nav.connections")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => signOut({ callbackUrl: "/" })}>
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
  const { data, update } = useSession();
  const memberships = ((data?.user as any)?.memberships ?? []) as Array<{
    tenantId: string; tenantSlug: string; tenantName: string; role: string; tenantTier?: string;
    // True for a workspace surfaced via Platform Admin org oversight rather
    // than an actual Membership row — see loadMembershipsForUserId() in
    // src/lib/auth.ts. Shown with a small badge below, not blank.
    isVirtual?: boolean;
  }>;
  const activeTenantId = (data?.user as any)?.activeTenantId ?? (data?.user as any)?.tenantId;
  const active = memberships.find((m) => m.tenantId === activeTenantId);
  const [busy, setBusy] = useState(false);
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
      <div className="px-2.5 pb-1 pt-3" aria-hidden="true">
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
            <CurfLogo variant="icon" size={18} mono />
          </span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="skeleton h-3 w-24" />
            <div className="skeleton h-2.5 w-14" />
          </div>
        </div>
      </div>
    );
  }

  async function switchTo(tenantId: string) {
    if (tenantId === activeTenantId) return;
    setBusy(true);
    try {
      await update({ activeTenantId: tenantId });
      // Land on Brief, not wherever the switch happened to be clicked from —
      // a page scoped to the old tenant (a specific report, an admin screen
      // the new tenant's role can't see) is jarring context to land in right
      // after switching.
      //
      // router.push("/brief") + router.refresh() here silently did nothing —
      // reproduced live: the session update succeeded (sidebar showed the
      // new tenant name) but the URL never left the page it was clicked
      // from and every server-rendered surface kept the OLD tenant's data.
      // This item's onClick fires from inside a Radix DropdownMenuItem,
      // which is itself in the middle of its own close/unmount transition
      // right as push() is called — plausibly enough to have App Router
      // drop the scheduled navigation. A full navigation sidesteps that
      // entirely: by the time this runs, `update()` has already resolved
      // (its Set-Cookie is applied), so the fresh request Brief makes here
      // is guaranteed to carry the new session, not a stale/racing one.
      window.location.href = "/brief";
    } finally { setBusy(false); }
  }

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
      window.location.href = "/brief";
    } catch (e: any) {
      setCreateError(e?.message ?? "Could not create workspace");
    } finally { setCreating(false); }
  }

  // The membership list is baked into the JWT at signin, so a workspace
  // created from another session (or via the API) stays invisible here until
  // the user logs out and back in. Re-pull from the DB whenever the menu
  // opens — opening it is exactly the moment the list must be current.
  async function refreshOnOpen(open: boolean) {
    if (!open || busy) return;
    try { await update({ refreshMemberships: true }); } catch { /* stale list is still usable */ }
  }

  return (
    // The workspace block: Curf mark in an ink square, workspace name, tier.
    // It is the rail's brand row and its switcher at once.
    <div className="px-2.5 pb-1 pt-3">
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
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted disabled:opacity-60"
            title={t("nav.switchWorkspace")}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
              <CurfLogo variant="icon" size={18} mono />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold leading-tight">
                {active?.tenantName ?? t("nav.workspaceFallback")}
              </p>
              {/* Tier once the session carries it; the slug for older tokens
                  (opening this menu refreshes memberships and back-fills it). */}
              <p className="truncate text-xs text-faint">{tierLabel(active?.tenantTier) ?? active?.tenantSlug ?? ""}</p>
            </div>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-faint" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="w-60">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
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
                      <span className="ml-1.5 rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-primary" title={t("nav.orgOversightHint")}>
                        {t("nav.orgOversight")}
                      </span>
                    )}
                  </p>
                  <p className="truncate text-[10px] text-muted-foreground">
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
  const crumbs = breadcrumbs ?? [];
  return (
    // h-14 is a fixed height, so nothing in here may wrap — a long report
    // name used to break onto three lines and spill out of the bar, and the
    // action row (up to ~9 controls on a report) pushed past the right edge.
    // Breadcrumbs truncate, actions keep their size and scroll if the viewport
    // genuinely can't fit them.
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4 sm:px-5">
      <button
        type="button"
        onClick={onOpenNav}
        aria-label="Open navigation"
        className="-ml-1 shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>
      {/* min-w keeps the current page readable even when the action row is
          long — otherwise a report with ~9 controls squeezed the breadcrumb
          down to a single character. */}
      <nav aria-label="Breadcrumb" className="flex min-w-[7rem] flex-1 items-center gap-1.5 text-sm">
        {crumbs.map((b, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <div
              key={i}
              // Only the current page's crumb survives on narrow screens;
              // the ancestors are still reachable from the sidebar.
              className={cn("flex min-w-0 items-center gap-1.5", !isLast && "hidden sm:flex")}
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
      <div className="flex min-w-0 shrink items-center gap-2 overflow-x-auto whitespace-nowrap [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {actions}
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
  return (
    <button
      type="button"
      onClick={onOpen}
      title={t("nav.askCurf")}
      className="hidden h-9 w-[300px] shrink-0 items-center gap-2 rounded-md border border-transparent bg-muted px-3 text-[13px] text-faint transition-colors hover:border-border xl:flex"
    >
      <Sparkles className="h-[15px] w-[15px] shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate text-left">{t("nav.askPlaceholder")}</span>
      <kbd className="rounded-sm border border-border bg-card px-1.5 py-px font-mono text-[11px] text-faint">/</kbd>
    </button>
  );
}
