/**
 * Shared tab row for the four Observability pages (/admin/audit, /admin/usage,
 * /admin/lineage, /admin/actions). The sidebar has a single "Observability"
 * entry pointing at /admin/audit (see AppShell.tsx) — until a unified tabbed
 * shell replaces these as one route, this is the only way to reach the other
 * three pages from the UI at all.
 */
import Link from "next/link";
import { t, type Locale } from "@/lib/i18n/dict";

const TABS = [
  { href: "/admin/audit", labelKey: "admin.audit.title" },
  { href: "/admin/usage", labelKey: "admin.usage.title" },
  { href: "/admin/lineage", labelKey: "admin.lineage.breadcrumb" },
  { href: "/admin/actions", labelKey: "admin.actions.breadcrumb" },
] as const;

export function ObservabilityTabs({ locale, active }: { locale: Locale; active: (typeof TABS)[number]["href"] }) {
  return (
    <nav className="mb-6 flex gap-1 border-b border-border">
      {TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className={
            "border-b-2 px-3 py-2 text-sm font-medium transition-colors " +
            (tab.href === active
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground")
          }
        >
          {t(locale, tab.labelKey)}
        </Link>
      ))}
    </nav>
  );
}
