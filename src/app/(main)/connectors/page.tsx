/**
 * /connectors — connector marketplace gallery.
 *
 * Two sections:
 *   1. Native kinds — the storage-level connectors the runner supports.
 *   2. SaaS recipes — pre-templated REST connections for Stripe/HubSpot/etc.
 *      Click a recipe → modal collects API key → POST to /api/data-sources
 *      with the prefilled payload.
 *
 * This page complements /data-sources (the manage list) by being the
 * "what's possible" inventory. Discovery vs management.
 */
import Link from "next/link";
import { cookies } from "next/headers";
import { AppShell } from "@/components/layout/AppShell";
import {
  Database, Globe, Cloud, FileSpreadsheet, Layers, Zap, CreditCard, Users, BarChart3, ExternalLink, Plus,
} from "lucide-react";
import { CONNECTOR_KINDS, CONNECTOR_RECIPES } from "@/lib/connectors/registry";
import type { ConnectorKindMeta } from "@/lib/connectors/registry";
import { ConnectorRecipeButton } from "./ConnectorRecipeButton";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { PageHeader } from "@/components/layout/PageHeader";

const ICONS = {
  Database, Globe, Cloud, FileSpreadsheet, Layers, Zap, CreditCard, Users, BarChart3,
} as const;

function readLocale(): Locale {
  const v = cookies().get("rd_locale")?.value;
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "en";
}

export default function ConnectorsPage() {
  const locale = readLocale();
  return (
    <AppShell breadcrumbs={[{ label: t(locale, "connectors.title") }]}>
      <div className="mx-auto max-w-6xl px-8 pb-12 pt-7">
        <PageHeader title={t(locale, "connectors.title")} description={t(locale, "connectors.subtitle")} />


        <Section title={t(locale, "connectors.nativeTitle")} subtitle={t(locale, "connectors.nativeSubtitle")}>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {CONNECTOR_KINDS.map((k) => <KindCard key={k.kind} kind={k} locale={locale} />)}
          </div>
        </Section>

        <Section title={t(locale, "connectors.recipesTitle")} subtitle={t(locale, "connectors.recipesSubtitle")}>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {CONNECTOR_RECIPES.map((r) => {
              const Icon = ICONS[r.iconName];
              return (
                <div key={r.id} className="group flex flex-col justify-between rounded-lg border border-border bg-card p-4 shadow-xs transition-shadow hover:shadow-md">
                  <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-border">
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold">{r.label}</h3>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{r.blurb}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <a
                      href={r.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground"
                    >
                      {t(locale, "connectors.docsLink")} <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                    <ConnectorRecipeButton recipeId={r.id} />
                  </div>
                </div>
              );
            })}
          </div>
        </Section>

        <Section title={t(locale, "connectors.whatsNextTitle")} subtitle={t(locale, "connectors.whatsNextSubtitle")}>
          <ul className="grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
            <li className="rounded-md border border-dashed border-border p-3">
              <span className="font-medium text-foreground">Salesforce</span> — {t(locale, "connectors.next.salesforce")}
            </li>
            <li className="rounded-md border border-dashed border-border p-3">
              <span className="font-medium text-foreground">Snowplow + dbt</span> — {t(locale, "connectors.next.snowplow")}
            </li>
            <li className="rounded-md border border-dashed border-border p-3">
              <span className="font-medium text-foreground">Custom plugin SDK</span> — {t(locale, "connectors.next.pluginSdk")}
            </li>
            <li className="rounded-md border border-dashed border-border p-3">
              <span className="font-medium text-foreground">CDC (change data capture)</span> — {t(locale, "connectors.next.cdc")}
            </li>
          </ul>
        </Section>
      </div>
    </AppShell>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <div className="mb-4">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

function KindCard({ kind, locale }: { kind: ConnectorKindMeta; locale: Locale }) {
  const Icon = ICONS[kind.iconName];
  return (
    <Link
      href={`/data-sources?kind=${kind.kind}`}
      className="group flex flex-col justify-between rounded-lg border border-border bg-card p-4 shadow-xs transition-shadow hover:shadow-md"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground ring-1 ring-border group-hover:bg-primary/10 group-hover:text-primary">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-semibold">{kind.label}</h3>
            {kind.feature && (
              <span className="rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[9px] font-medium text-warning ">
                {t(locale, "connectors.paidBadge")}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{kind.blurb}</p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>{kind.capabilities.join(" · ")}</span>
        <span className="inline-flex items-center gap-0.5 font-semibold text-primary opacity-0 group-hover:opacity-100">
          <Plus className="h-2.5 w-2.5" /> {t(locale, "connectors.connectHover")}
        </span>
      </div>
    </Link>
  );
}
