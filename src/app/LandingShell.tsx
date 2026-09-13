"use client";
/**
 * Community edition landing page. Replaces the Cloud marketing landing
 * (which advertises Master Builder, waitlist access and the paid tiers)
 * with a plain front door for a self-hosted install: sign in, or create
 * the first workspace. Same props as the Cloud component so page.tsx is
 * untouched.
 */
import Link from "next/link";
import { ArrowRight, FileText, Database, Send, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LanguageSwitcher } from "@/components/common/LanguageSwitcher";
import { CurfLogo } from "@/components/common/CurfLogo";
import { useT } from "@/lib/i18n/LocaleContext";
import type { TemplateLocale } from "@/lib/templates/registry";
import type { Block } from "@/lib/reporting/schema";

type TeaserTemplate = {
  slug: string; icon: string; accent: string; industry: string;
  title: Record<TemplateLocale, string>;
  description: Record<TemplateLocale, string>;
  blocks: Block[];
};

const FEATURES = [
  { icon: FileText, title: "Block-based reports", body: "Eighteen block types, themes, parameters, multi-page layouts and version history. Export pixel-identical PDF, Excel, Word and CSV." },
  { icon: Database, title: "Your data, directly", body: "Postgres, MySQL, SQLite and any REST API, or drop a spreadsheet into the built-in lake. Parameters are bound, never concatenated; DDL and DML are blocked." },
  { icon: Send, title: "Scheduled email", body: "Send any report on a cron you choose. One endpoint, POST /api/cron/tick, drives every schedule." },
  { icon: ShieldCheck, title: "Every number, provable", body: "Each cell carries a SHA-256 fingerprint of the query and rows that produced it. Hover to see the receipt." },
];

export function LandingShell({
  signedIn, userName, docsUrl, teaserTemplates,
}: {
  signedIn: boolean;
  userName: string | null;
  docsUrl: string;
  teaserTemplates: TeaserTemplate[];
}) {
  const { t, locale } = useT();
  const safe = (locale === "th" || locale === "zh" ? locale : "en") as TemplateLocale;
  // Community doesn't ship the docs site; they live with Curf Cloud unless
  // DOCS_URL points somewhere else.
  const docsBase = docsUrl || "https://app.curf.ai";
  const docsLink = (path: string = "") => `${docsBase}/docs${safe === "en" ? "" : `/${safe}`}${path}`;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/70 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2"><CurfLogo variant="lockup" size={26} /></Link>
          <div className="flex items-center gap-1">
            <Link href="/templates" className="hidden rounded-md px-3 py-1.5 text-[13px] font-medium text-foreground/70 transition-colors hover:text-foreground sm:inline-flex">{t("nav.templates")}</Link>
            <a href={docsLink("/guide")} className="hidden rounded-md px-3 py-1.5 text-[13px] font-medium text-foreground/70 transition-colors hover:text-foreground sm:inline-flex">{t("nav.gettingStartedDocs")}</a>
            <a href={docsLink("/developer")} className="hidden rounded-md px-3 py-1.5 text-[13px] font-medium text-foreground/70 transition-colors hover:text-foreground sm:inline-flex">{t("nav.devDocs")}</a>
            <div className="mx-1 hidden h-4 w-px bg-border sm:block" />
            <LanguageSwitcher />
            <Button asChild size="sm" className="ml-1">
              <Link href={signedIn ? "/reports" : "/login"}>{signedIn ? t("nav.reports") : t("action.signIn")}</Link>
            </Button>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-6 pb-16 pt-16 text-center sm:pt-24">
        <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-border bg-background/60 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" /> Curf Community Edition
        </div>
        <h1 className="mx-auto max-w-3xl text-balance text-5xl font-medium tracking-[-0.025em] text-foreground sm:text-6xl">
          Reports that <span className="italic font-normal text-primary">show their work.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-balance text-base text-muted-foreground sm:text-lg">
          The open-source edition of Curf: a block-based report designer over Postgres, MySQL, SQLite and REST, with pixel-identical exports, scheduled email, and a provenance hash on every number.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button asChild size="lg"><Link href={signedIn ? "/reports" : "/signup"}>{signedIn ? t("nav.reports") : "Create a workspace"} <ArrowRight className="ml-1.5 h-4 w-4" /></Link></Button>
          <Button asChild size="lg" variant="outline"><a href={docsLink("/guide")}>{t("nav.gettingStartedDocs")}</a></Button>
        </div>
        {userName && <p className="mt-4 text-xs text-muted-foreground">{t("landing.hero.signedInAs")} {userName}</p>}
      </section>

      <section className="mx-auto max-w-6xl px-6 py-12">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-6">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted/50 text-foreground/70"><f.icon className="h-4 w-4" /></div>
              <h2 className="text-base font-medium tracking-[-0.01em]">{f.title}</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {teaserTemplates.length > 0 && (
        <section className="mx-auto max-w-6xl px-6 pb-24">
          <div className="mb-8 max-w-2xl">
            <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{t("nav.templates")}</p>
            <h2 className="text-balance text-3xl font-medium tracking-[-0.02em]">{t("landing.templates.title")}</h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {teaserTemplates.map((tpl) => (
              <Link key={tpl.slug} href="/templates" className="rounded-2xl border border-border bg-card p-6 transition-all hover:border-foreground/20">
                <h3 className="text-base font-medium tracking-[-0.01em]">{tpl.title[safe] ?? tpl.title.en}</h3>
                <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted-foreground">{tpl.description[safe] ?? tpl.description.en}</p>
              </Link>
            ))}
          </div>
        </section>
      )}

      <footer className="border-t border-border/60 bg-background">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-6 py-10 text-[11px] tracking-wide text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>© {new Date().getFullYear()} Curf · Community Edition · MIT licensed</span>
          <span>Curf Cloud adds Master Builder, Ask Curf, watchers, Operate and Analytic Apps — <a href="https://curf.ai" className="underline">curf.ai</a></span>
        </div>
      </footer>
    </div>
  );
}
