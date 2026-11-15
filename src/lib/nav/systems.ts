/**
 * The console's systems map: every page of the app filed under one system and
 * one section, the way docs/prototypes/curf-consoles.html shows it
 * (docs/design/consoles-build-plan.md, C1). The rail, the systems switcher,
 * the command palette and the tests all read this one list.
 *
 * URLs are today's (decision D2): a section links to the page it is, and the
 * rail marks the section whose path is the longest prefix of the current URL.
 * Who sees a section follows the sidebar rules it replaces, section by
 * section; the pages themselves still enforce access. Labels are i18n keys
 * (nav.sys.*, nav.sec.*, nav.group.*), never text, so this module stays free
 * of the dictionaries and of React.
 */
import type { NavCounts } from "@/lib/navCounts";
import { canUseOperateInbox } from "@/lib/roles";

/** Who a section is for. The pages enforce access; this only decides what the rail lists. */
export type Audience =
  | "all"
  /** Builders: every role but viewer and executive (the old sidebar's rule for authoring pages). */
  | "builder"
  /** The approvals inbox: builders and executives (canUseOperateInbox). */
  | "inbox"
  | "admin"
  /** Curf's own operators (session isPlatformAdmin). */
  | "platform"
  /** The Executive view: executives and viewers use it, admins may open it. */
  | "execView";

export type GroupId = "everyday" | "build" | "run" | "lead" | "apps" | "control";
export const GROUPS: GroupId[] = ["everyday", "build", "run", "lead", "apps", "control"];

export type IconName =
  | "home" | "ask" | "reports" | "dashboards" | "briefs" | "builder" | "notebooks"
  | "operate" | "data" | "connections" | "executive" | "apps" | "admin" | "platform";

export type SectionDef = {
  id: string;
  href: string;
  /** More path prefixes that belong to this section (pages it absorbs). `href` always counts. */
  also?: string[];
  who?: Audience;
  badge?: Exclude<keyof NavCounts, "apps">;
  /** The count needs a person (awaiting my approval): shown in the critical colour. */
  critical?: boolean;
  /** Literal text instead of the nav.sec.<system>.<id> key (an app's own title). */
  label?: string;
};

export type SystemDef = {
  id: string;
  group: GroupId;
  icon: IconName;
  sections: SectionDef[];
};

export const SYSTEMS: SystemDef[] = [
  { id: "home", group: "everyday", icon: "home", sections: [
    { id: "today", href: "/brief" },
    { id: "inbox", href: "/operate", who: "inbox", badge: "inbox", critical: true },
    { id: "incidents", href: "/operate/incidents", who: "builder" },
  ] },
  { id: "ask", group: "everyday", icon: "ask", sections: [
    // The agent is a mode of the chat (C3); /agent redirects to it.
    { id: "chat", href: "/ask", also: ["/agent"], badge: "askUnread" },
  ] },
  { id: "reports", group: "everyday", icon: "reports", sections: [
    { id: "all", href: "/reports", badge: "reports" },
    { id: "scheduled", href: "/schedules", who: "builder" },
    { id: "import", href: "/reports/import", who: "builder" },
    { id: "blocks", href: "/templates", who: "builder" },
  ] },
  { id: "dashboards", group: "everyday", icon: "dashboards", sections: [
    { id: "all", href: "/dashboards", badge: "dashboards" },
    { id: "screens", href: "/on-screen", badge: "onScreen" },
  ] },
  { id: "briefs", group: "everyday", icon: "briefs", sections: [
    { id: "morning", href: "/admin/brief", who: "admin" },
    { id: "delivery", href: "/admin/brief/delivery", who: "admin" },
    { id: "digest", href: "/admin/digest", who: "admin" },
  ] },
  { id: "builder", group: "build", icon: "builder", sections: [
    { id: "builds", href: "/build", who: "builder", badge: "buildRunning" },
    { id: "apps", href: "/admin/apps", who: "admin" },
    { id: "packs", href: "/marketplace", who: "builder" },
    { id: "setup", href: "/admin/workspace-templates", who: "admin" },
  ] },
  { id: "notebooks", group: "build", icon: "notebooks", sections: [
    { id: "all", href: "/notebooks", who: "builder", badge: "notebooks" },
    { id: "snippets", href: "/admin/snippets", who: "admin" },
  ] },
  { id: "operate", group: "run", icon: "operate", sections: [
    { id: "watchers", href: "/operate/watchers", badge: "watchers" },
    { id: "workflows", href: "/operate/templates", who: "builder", badge: "templates" },
    { id: "insights", href: "/operate/insights", who: "builder" },
    { id: "decisions", href: "/decisions", badge: "decisions" },
  ] },
  { id: "data", group: "run", icon: "data", sections: [
    { id: "tables", href: "/tables", who: "builder" },
    { id: "catalog", href: "/catalog", who: "builder" },
    { id: "metrics", href: "/metrics", who: "builder", badge: "metrics" },
    { id: "quality", href: "/data/quality", also: ["/admin/quality"], who: "builder", badge: "dataQuality" },
    { id: "lineage", href: "/admin/lineage", who: "admin" },
    { id: "knowledge", href: "/knowledge", who: "builder" },
  ] },
  { id: "connections", group: "run", icon: "connections", sections: [
    { id: "sources", href: "/connections", also: ["/data-sources", "/connectors"], who: "builder", badge: "sources" },
    { id: "syncs", href: "/admin/connections", who: "admin" },
    { id: "external", href: "/admin/external-tables", also: ["/admin/dbt", "/admin/modern-stack"], who: "admin" },
    { id: "destinations", href: "/admin/activations", who: "admin" },
  ] },
  { id: "executive", group: "lead", icon: "executive", sections: [
    { id: "home", href: "/executive", who: "execView" },
    { id: "apps", href: "/executive/apps", who: "execView" },
    { id: "approvals", href: "/executive/approvals", who: "execView" },
    { id: "tracking", href: "/executive/tracking", who: "execView" },
    { id: "team", href: "/executive/team", also: ["/executive/assist"], who: "execView" },
    { id: "review", href: "/executive/review", who: "execView" },
    { id: "strategist", href: "/executive/strategist", also: ["/executive/deck", "/executive/paper"], who: "execView" },
  ] },
  // Sections are the workspace's own apps, filled in by visibleSystems().
  { id: "apps", group: "apps", icon: "apps", sections: [] },
  { id: "admin", group: "control", icon: "admin", sections: [
    { id: "overview", href: "/admin", who: "admin" },
    { id: "members", href: "/admin/users", also: ["/admin/roles"], who: "admin" },
    { id: "org", href: "/admin/org", who: "admin" },
    { id: "access", href: "/admin/api-keys", also: ["/admin/access", "/admin/sso"], who: "admin" },
    { id: "explorer", href: "/admin/api-explorer", who: "admin" },
    { id: "integrations", href: "/admin/integrations", also: ["/admin/webhooks"], who: "admin" },
    { id: "billing", href: "/admin/billing", who: "admin" },
    { id: "taxdocs", href: "/admin/billing/tax-documents", who: "admin" },
    { id: "usage", href: "/admin/usage", who: "admin" },
    { id: "audit", href: "/admin/audit", also: ["/admin/observability", "/admin/actions"], who: "admin" },
    { id: "compliance", href: "/admin/compliance", who: "admin" },
    { id: "workspace", href: "/admin/tenant", who: "admin" },
    { id: "orgsecurity", href: "/admin/org-security", who: "admin" },
    { id: "branding", href: "/admin/branding", who: "admin" },
    { id: "releases", href: "/admin/release-log", who: "admin" },
  ] },
  { id: "platform", group: "control", icon: "platform", sections: [
    { id: "tenants", href: "/admin/platform/tenants", who: "platform" },
    { id: "models", href: "/admin/platform/models", who: "platform" },
    { id: "costs", href: "/admin/platform/ai-costs", who: "platform" },
    { id: "privacy", href: "/admin/platform/privacy", who: "platform" },
    { id: "jobs", href: "/admin/platform/jobs", who: "platform" },
    { id: "invoices", href: "/admin/platform/invoices", who: "platform" },
    { id: "waitlist", href: "/admin/waitlist", who: "platform" },
    { id: "roadmap", href: "/admin/roadmap-status", who: "platform" },
  ] },
];

/**
 * The Community edition's pages (everything else is a paid route, absent
 * from that build, so a link would 404). Same list the old sidebar kept.
 */
export const COMMUNITY_PATHS = [
  "/reports", "/on-screen", "/dashboards", "/tables", "/connections", "/templates",
  "/admin/tenant", "/admin/users", "/admin/audit", "/admin/compliance", "/admin/release-log",
];

/** The rail holds this many systems at most. */
export const MAX_PINS = 8;

const DEFAULT_PINS: Record<string, string[]> = {
  admin: ["home", "ask", "reports", "builder", "data", "operate", "admin"],
  developer: ["home", "ask", "reports", "data", "notebooks", "operate"],
  editor: ["home", "ask", "reports", "data", "notebooks", "operate"],
  viewer: ["home", "ask", "reports", "dashboards"],
  executive: ["executive", "home", "ask", "dashboards"],
};

export type NavViewer = {
  role: string | null | undefined;
  isPlatformAdmin?: boolean;
  community?: boolean;
};

/** An app of the workspace, for the Apps system's sections. */
export type NavApp = { slug: string; title: string; titleI18n?: Record<string, string> };

export function canSee(who: Audience | undefined, v: NavViewer): boolean {
  const role = v.role ?? "";
  switch (who ?? "all") {
    case "all": return true;
    case "builder": return role !== "viewer" && role !== "executive";
    case "inbox": return canUseOperateInbox(role);
    case "admin": return role === "admin";
    case "platform": return !!v.isPlatformAdmin;
    case "execView": return !v.community && (role === "admin" || role === "executive" || role === "viewer");
  }
}

const inCommunity = (href: string) => COMMUNITY_PATHS.some((p) => href === p || href.startsWith(p + "/"));

/** The systems this person sees, each with only the sections they see; a system left with none is gone. */
export function visibleSystems(v: NavViewer, apps: NavApp[] = [], locale?: string): SystemDef[] {
  const title = (a: NavApp) => (locale && a.titleI18n?.[locale]) || a.title;
  // Two apps with one title (a rebuild beside the original) are told apart by their slug.
  const seen = new Map<string, number>();
  for (const a of apps) seen.set(title(a), (seen.get(title(a)) ?? 0) + 1);
  const label = (a: NavApp) => (seen.get(title(a))! > 1 ? `${title(a)} · ${a.slug}` : title(a));
  return SYSTEMS.map((s) => {
    const sections = s.id === "apps"
      ? (v.community ? [] : apps.map((a) => ({ id: a.slug, href: `/apps/${a.slug}`, label: label(a) })))
      : s.sections.filter((x) => canSee(x.who, v) && (!v.community || inCommunity(x.href)));
    return { ...s, sections };
  }).filter((s) => s.sections.length > 0);
}

const prefixMatch = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + "/");

/**
 * The system and section a URL belongs to: the section with the longest path
 * prefix of it, so /operate/templates/x is Workflows, not the Inbox at
 * /operate. Null when no visible section claims the URL (an account page).
 */
export function locate(pathname: string, systems: SystemDef[]): { system: SystemDef; section: SectionDef } | null {
  let best: { system: SystemDef; section: SectionDef; len: number } | null = null;
  for (const system of systems) {
    for (const section of system.sections) {
      for (const p of [section.href, ...(section.also ?? [])]) {
        if (prefixMatch(pathname, p) && (!best || p.length > best.len)) best = { system, section, len: p.length };
      }
    }
  }
  return best && { system: best.system, section: best.section };
}

/**
 * The systems on the rail: what the person pinned (kept per person, in the
 * browser), else their role's defaults plus the Apps system and, for Curf's
 * operators, Platform. Only systems they can see, at most MAX_PINS.
 */
export function railPins(v: NavViewer, systems: SystemDef[], stored?: string[] | null): string[] {
  const visible = new Set(systems.map((s) => s.id));
  if (Array.isArray(stored)) return stored.filter((id) => visible.has(id)).slice(0, MAX_PINS);
  const base = [...(DEFAULT_PINS[v.role ?? ""] ?? DEFAULT_PINS.viewer!), "apps", ...(v.isPlatformAdmin ? ["platform"] : [])];
  return [...new Set(base)].filter((id) => visible.has(id)).slice(0, MAX_PINS);
}

/** i18n keys for a system's name and description, a section's name, and a group's name. */
export const sysNameKey = (id: string) => `nav.sys.${id}`;
export const sysDescKey = (id: string) => `nav.sys.${id}.desc`;
export const sectionKey = (systemId: string, sectionId: string) => `nav.sec.${systemId}.${sectionId}`;
export const groupKey = (g: GroupId) => `nav.group.${g}`;
