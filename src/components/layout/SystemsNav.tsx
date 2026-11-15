"use client";
/**
 * The console's navigation (docs/design/consoles-build-plan.md, C1): an icon
 * rail of pinned systems, the current system's sections, a sheet of every
 * system ("All systems", G) where any can be pinned, and a bottom tab bar on
 * phones. What exists and who sees it is lib/nav/systems.ts; this file only
 * draws it. Pins and "recently used" are per-person conveniences kept in the
 * browser, so a cleared storage just shows the role's defaults again.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  Home, Sparkles, FileText, Monitor, Zap, Wand2, NotebookText, Workflow, Database, Plug,
  BarChart3, AppWindow, Shield, Cpu, LayoutGrid, Pin, ChevronDown, Search, Menu,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/lib/i18n/LocaleContext";
import { useResilientSession } from "@/lib/useResilientSession";
import { loadNavCounts, onNavCountsRefresh, peekNavCounts, type NavCounts } from "@/lib/navCounts";
import { eeClient } from "@/ee/client";
import { CurfLogo } from "@/components/common/CurfLogo";
import { landingPathFor } from "@/lib/roles";
import {
  GROUPS, MAX_PINS, groupKey, locate, railPins, sectionKey, sysDescKey, sysNameKey, visibleSystems,
  type IconName, type SectionDef, type SystemDef,
} from "@/lib/nav/systems";

const IS_COMMUNITY = eeClient.edition === "community";

export const SYSTEM_ICONS: Record<IconName, React.ComponentType<{ className?: string }>> = {
  home: Home, ask: Sparkles, reports: FileText, dashboards: Monitor, briefs: Zap, builder: Wand2,
  notebooks: NotebookText, operate: Workflow, data: Database, connections: Plug, executive: BarChart3,
  apps: AppWindow, admin: Shield, platform: Cpu,
};

/** One empty value, so resetting to "no counts yet" twice doesn't re-render. */
const NO_COUNTS: NavCounts = {};
const RECENT_MAX = 5;

function readList(key: string | null): string[] | null {
  if (!key) return null;
  try {
    const v = JSON.parse(window.localStorage.getItem(key) ?? "null");
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
  } catch { return null; }
}
function writeList(key: string | null, list: string[]) {
  if (!key) return;
  try { window.localStorage.setItem(key, JSON.stringify(list)); } catch { /* storage off: the defaults stand */ }
}

export type ConsoleNav = ReturnType<typeof useConsoleNav>;

/** Everything the rail, the section column, the switcher and the tab bar share. */
export function useConsoleNav() {
  const { t, locale } = useT();
  const pathname = usePathname() ?? "";
  const { role, session } = useResilientSession();
  const user = session?.user as any;
  // Read off the session (baked in server-side), never from the server-only
  // env var: both render passes must agree on whether Platform exists.
  const isPlatformAdmin = !!user?.isPlatformAdmin;
  const tenantId: string | undefined = user?.activeTenantId ?? user?.tenantId;
  const userId: string | undefined = user?.id;

  // Badge counts and the workspace's apps: one GET /api/nav/counts, kept per
  // workspace for a moment (lib/navCounts.ts) so page changes don't recount.
  const countsKey = tenantId ? `${userId}:${tenantId}:${role}` : null;
  const [counts, setCounts] = useState<NavCounts>(() => (countsKey && peekNavCounts(countsKey)) || NO_COUNTS);
  useEffect(() => {
    if (!countsKey) return;
    let live = true;
    const load = () => void loadNavCounts(countsKey).then((c) => { if (live && c) setCounts(c); });
    setCounts(peekNavCounts(countsKey) ?? NO_COUNTS);
    load();
    const off = onNavCountsRefresh(load);
    return () => { live = false; off(); };
  }, [countsKey]);

  const viewer = useMemo(() => ({ role, isPlatformAdmin, community: IS_COMMUNITY }), [role, isPlatformAdmin]);
  const systems = useMemo(() => visibleSystems(viewer, counts.apps ?? [], locale), [viewer, counts.apps, locale]);
  const byId = useMemo(() => new Map(systems.map((s) => [s.id, s])), [systems]);

  const pinKey = tenantId && userId ? `curf.pins.${tenantId}.${userId}` : null;
  const recentKey = userId ? `curf.nav.recent.${userId}` : null;
  const [storedPins, setStoredPins] = useState<string[] | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => { setStoredPins(readList(pinKey)); }, [pinKey]);
  useEffect(() => { setRecent(readList(recentKey) ?? []); }, [recentKey]);
  const pins = useMemo(() => railPins(viewer, systems, storedPins), [viewer, systems, storedPins]);

  const here = useMemo(() => locate(pathname, systems), [pathname, systems]);
  // A page outside the map (an account page) keeps the last system open.
  const [lastSystemId, setLastSystemId] = useState<string | null>(null);
  useEffect(() => {
    if (!here) return;
    setLastSystemId(here.system.id);
    setRecent((prev) => {
      if (prev[0] === here.system.id) return prev;
      const next = [here.system.id, ...prev.filter((id) => id !== here.system.id)].slice(0, RECENT_MAX);
      writeList(recentKey, next);
      return next;
    });
  }, [here, recentKey]);
  const current: SystemDef | undefined = here?.system ?? (lastSystemId ? byId.get(lastSystemId) : undefined) ?? byId.get(pins[0] ?? "") ?? systems[0];

  /** null when pinned/unpinned, else the reason it wasn't (the rail is full). */
  const togglePin = (id: string): string | null => {
    const next = pins.includes(id) ? pins.filter((p) => p !== id) : pins.length >= MAX_PINS ? null : [...pins, id];
    if (!next) return t("nav.railFull").replace("{n}", String(MAX_PINS));
    setStoredPins(next);
    writeList(pinKey, next);
    return null;
  };

  const sysName = (s: SystemDef) => t(sysNameKey(s.id));
  const sectionName = (s: SystemDef, x: SectionDef) => x.label ?? t(sectionKey(s.id, x.id));
  const countOf = (x: SectionDef) => (x.badge ? Number(counts[x.badge] ?? 0) : 0);
  /** A system with something waiting on the person: the rail shows a dot. */
  const needsYou = (s: SystemDef) => s.sections.some((x) => x.critical && countOf(x) > 0);

  // Where the brand mark goes: the person's landing page, which every edition ships.
  const home = landingPathFor(role);
  return { t, home, systems, byId, pins, togglePin, current, section: here?.section ?? null, recent, sysName, sectionName, countOf, needsYou };
}

function RailButton({ label, active, onClick, href, dot, children }: {
  label: string; active?: boolean; onClick?: () => void; href?: string; dot?: boolean; children: React.ReactNode;
}) {
  const cls = cn(
    "group relative grid h-11 w-11 shrink-0 place-items-center rounded-xl transition-colors",
    active
      ? "bg-primary-soft text-primary-ink before:absolute before:-left-2.5 before:bottom-2.5 before:top-2.5 before:w-[3px] before:rounded-r-[3px] before:bg-primary before:content-['']"
      : "text-muted-foreground hover:bg-muted hover:text-foreground",
  );
  const inner = (
    <>
      {children}
      {dot && <span className="absolute right-2 top-2 h-[7px] w-[7px] rounded-full bg-destructive ring-2 ring-card" aria-hidden="true" />}
      {/* The name on hover or focus; the button's accessible name is aria-label. */}
      <span className="pointer-events-none absolute left-[54px] top-1/2 z-30 -translate-y-1/2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs text-background opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
        {label}
      </span>
    </>
  );
  if (href) return <Link href={href} aria-label={label} aria-current={active ? "true" : undefined} className={cls}>{inner}</Link>;
  return <button type="button" aria-label={label} onClick={onClick} className={cls}>{inner}</button>;
}

/** The icon rail: pinned systems, All systems, and the person's own menu at the foot. */
export function SystemRail({ nav, onOpenSwitcher, footer }: { nav: ConsoleNav; onOpenSwitcher: () => void; footer?: React.ReactNode }) {
  return (
    <aside aria-label={nav.t("nav.systems")} className="flex h-full w-16 flex-col items-center gap-1.5 border-r border-sidebar-border bg-sidebar py-3.5">
      {/* The brand sits at the head of the rail; on a phone there is no rail, so the workspace block in the top bar keeps its own mark. */}
      <Link href={nav.home} aria-label="Curf" title="Curf" data-testid="rail-logo" className="mb-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-foreground text-background transition-opacity hover:opacity-85">
        <CurfLogo variant="icon" size={20} mono />
      </Link>
      <div className="grid gap-1.5">
        {nav.pins.map((id) => {
          const s = nav.byId.get(id);
          if (!s) return null;
          const Icon = SYSTEM_ICONS[s.icon];
          return (
            <RailButton key={id} label={nav.sysName(s)} href={s.sections[0]!.href} active={nav.current?.id === id} dot={nav.needsYou(s)}>
              <Icon className="h-5 w-5" />
            </RailButton>
          );
        })}
      </div>
      <div className="my-1.5 h-px w-7 shrink-0 bg-border" aria-hidden="true" />
      <RailButton label={`${nav.t("nav.allSystems")} (G)`} onClick={onOpenSwitcher}>
        <LayoutGrid className="h-5 w-5" />
      </RailButton>
      <div className="flex-1" />
      {footer}
    </aside>
  );
}

/** The current system's sections, under a button that opens the switcher. */
export function SectionColumn({ nav, onOpenSwitcher, extra, footer }: { nav: ConsoleNav; onOpenSwitcher: () => void; extra?: React.ReactNode; footer?: React.ReactNode }) {
  const s = nav.current;
  const recents = nav.recent.filter((id) => id !== s?.id && nav.byId.has(id)).slice(0, 4);
  return (
    <div className="flex h-full w-[248px] flex-col gap-3.5 overflow-y-auto overflow-x-hidden border-r border-sidebar-border bg-sidebar px-3 py-3.5 text-sidebar-foreground">
      {s && (
        <button
          type="button"
          onClick={onOpenSwitcher}
          aria-haspopup="dialog"
          className="flex w-full items-center gap-2.5 rounded-md border border-border bg-card p-2 text-left transition-colors hover:bg-muted"
        >
          <SystemTile system={s} />
          {/* The name only: the description is in the switcher, where there is room to read it. */}
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{nav.sysName(s)}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-faint" />
        </button>
      )}
      {/* A system with one section has nothing to choose between. */}
      {s && s.sections.length > 1 && (
        <div>
          <p className="px-2 pb-1.5 text-2xs font-medium uppercase tracking-[.06em] text-faint">{nav.t("nav.sections")}</p>
          <nav aria-label={nav.sysName(s)} className="grid gap-0.5">
            {s.sections.map((x) => {
              const active = nav.section === x;
              const n = nav.countOf(x);
              return (
                <Link
                  key={x.id}
                  href={x.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13.5px] font-medium transition-colors",
                    active ? "bg-primary-soft text-primary-ink" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{nav.sectionName(s, x)}</span>
                  {n > 0 && (
                    <span
                      className={cn("rounded-full px-[7px] font-mono text-[11px] tabular-nums", x.critical ? "bg-destructive text-destructive-foreground" : "bg-muted text-muted-foreground")}
                      title={x.critical ? nav.t("nav.awaitingTitle").replace("{n}", String(n)) : undefined}
                    >
                      {n}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
        </div>
      )}
      {extra}
      <div className="mt-auto grid gap-2">
        <p className="px-2 text-2xs font-medium uppercase tracking-[.06em] text-faint">{nav.t("nav.recentlyUsed")}</p>
        <div className="flex flex-wrap gap-1.5 px-1">
          {recents.length === 0 ? (
            <span className="px-1 text-xs text-faint">{nav.t("nav.recentlyUsedEmpty")}</span>
          ) : recents.map((id) => {
            const r = nav.byId.get(id)!;
            const Icon = SYSTEM_ICONS[r.icon];
            return (
              <Link key={id} href={r.sections[0]!.href} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card py-[3px] pl-1.5 pr-2.5 text-xs text-muted-foreground hover:text-foreground">
                <Icon className="h-3.5 w-3.5 text-primary" />
                {nav.sysName(r)}
              </Link>
            );
          })}
        </div>
        {footer}
      </div>
    </div>
  );
}

function SystemTile({ system, large }: { system: SystemDef; large?: boolean }) {
  const Icon = SYSTEM_ICONS[system.icon];
  return (
    <span className={cn("grid shrink-0 place-items-center rounded-md bg-primary-soft text-primary-ink", large ? "h-10 w-10" : "h-8 w-8")}>
      <Icon className={large ? "h-5 w-5" : "h-4 w-4"} />
    </span>
  );
}

/** Every system the person can open, grouped, filterable, with a pin on each. */
export function SystemSwitcher({ nav, open, onClose }: { nav: ConsoleNav; open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { if (open) { setQ(""); setSel(0); setNote(null); } }, [open]);

  const needle = q.trim().toLowerCase();
  const groups = GROUPS.map((g) => ({
    g,
    items: nav.systems.filter((s) => s.group === g && (!needle
      || [nav.sysName(s), nav.t(sysDescKey(s.id)), ...s.sections.map((x) => nav.sectionName(s, x))].join(" ").toLowerCase().includes(needle))),
  })).filter((x) => x.items.length > 0);
  const flat = groups.flatMap((x) => x.items);
  const go = (s: SystemDef) => { onClose(); router.push(s.sections[0]!.href); };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); setSel((i) => Math.min(flat.length - 1, i + 1)); }
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter" && flat[sel]) { e.preventDefault(); go(flat[sel]!); }
  };

  let n = 0;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[84vh] w-[min(980px,calc(100vw_-_32px))] max-w-none gap-0 overflow-y-auto p-0">
        <DialogTitle className="sr-only">{nav.t("nav.allSystems")}</DialogTitle>
        <div className="sticky top-0 z-[1] flex items-center gap-3 border-b border-border bg-card px-4 py-3.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={onKey}
            placeholder={nav.t("nav.filterSystems")}
            aria-label={nav.t("nav.filterSystems")}
            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-faint"
          />
        </div>
        {note && <p role="status" className="mx-4 mt-3 rounded-md bg-warning/10 px-3 py-2 text-xs text-foreground">{note}</p>}
        <div className="grid gap-5 p-4">
          {groups.length === 0 && <p className="px-2 text-sm text-muted-foreground">{nav.t("nav.noSystemMatch")}</p>}
          {groups.map(({ g, items }) => (
            <section key={g}>
              <h3 className="mb-2.5 text-2xs font-medium uppercase tracking-[.06em] text-faint">{nav.t(groupKey(g))}</h3>
              <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr))]">
                {items.map((s) => {
                  const i = n++;
                  const pinned = nav.pins.includes(s.id);
                  return (
                    <div key={s.id} className="relative">
                      <button
                        type="button"
                        onClick={() => go(s)}
                        aria-current={nav.current?.id === s.id ? "true" : undefined}
                        className={cn(
                          "flex h-full w-full items-start gap-3 rounded-xl border border-border bg-card py-3 pl-3 pr-10 text-left transition-shadow hover:border-primary hover:ring-[3px] hover:ring-primary-soft",
                          i === sel && "border-primary ring-[3px] ring-primary-soft",
                          nav.current?.id === s.id && "bg-muted",
                        )}
                      >
                        <SystemTile system={s} large />
                        <span className="min-w-0">
                          <span className="block font-semibold">{nav.sysName(s)}</span>
                          <span className="mt-0.5 block text-[12.5px] leading-snug text-muted-foreground">{nav.t(sysDescKey(s.id))}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-pressed={pinned}
                        aria-label={(pinned ? nav.t("nav.unpin") : nav.t("nav.pin")).replace("{name}", nav.sysName(s))}
                        title={(pinned ? nav.t("nav.unpin") : nav.t("nav.pin")).replace("{name}", nav.sysName(s))}
                        onClick={() => setNote(nav.togglePin(s.id))}
                        className={cn("absolute right-2 top-2 grid h-[30px] w-[30px] place-items-center rounded-md hover:bg-muted", pinned ? "text-primary" : "text-faint hover:text-foreground")}
                      >
                        <Pin className={cn("h-4 w-4", pinned && "fill-current")} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Phones: Home, two pinned systems and More, instead of the rail. More opens the
 *  section drawer, whose first row is the way to every other system. */
export function TabBar({ nav, onOpenSections }: { nav: ConsoleNav; onOpenSections: () => void }) {
  const picks = [nav.byId.get("home"), ...nav.pins.filter((id) => id !== "home").slice(0, 2).map((id) => nav.byId.get(id))]
    .filter((s): s is SystemDef => !!s);
  const cls = "grid min-w-0 justify-items-center gap-0.5 rounded-[10px] px-0.5 py-1 text-[10.5px]";
  return (
    <nav
      aria-label={nav.t("nav.systems")}
      className="fixed inset-x-0 bottom-0 z-30 grid auto-cols-fr grid-flow-col border-t border-border bg-card px-2 pt-1.5 pb-[max(6px,env(safe-area-inset-bottom))] md:hidden"
    >
      {picks.map((s) => {
        const Icon = SYSTEM_ICONS[s.icon];
        const active = nav.current?.id === s.id;
        return (
          <Link key={s.id} href={s.sections[0]!.href} aria-current={active ? "true" : undefined} className={cn(cls, active ? "bg-primary-soft text-primary-ink" : "text-muted-foreground")}>
            <Icon className="h-5 w-5" />
            <span className="max-w-full truncate">{nav.sysName(s)}</span>
          </Link>
        );
      })}
      <button type="button" onClick={onOpenSections} className={cn(cls, "text-muted-foreground")}>
        <Menu className="h-5 w-5" />
        <span className="max-w-full truncate">{nav.t("nav.more")}</span>
      </button>
    </nav>
  );
}
