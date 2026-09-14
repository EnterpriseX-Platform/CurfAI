"use client";
import { useMemo, useState } from "react";
import {
  LineChart, TrendingUp, Boxes, Users, Megaphone, Store, BarChart3,
  Landmark, ShieldCheck, Building2, ReceiptText, Notebook, ClipboardList, Receipt,
  FileText as FileTextIcon, ArrowRight,
} from "lucide-react";
import type { TemplateLocale } from "@/lib/templates/registry";
import type { Block } from "@/lib/reporting/schema";
import { TemplateThumbnail } from "@/components/common/TemplateThumbnail";
import { useT } from "@/lib/i18n/LocaleContext";
import { PageHeader } from "@/components/layout/PageHeader";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  LineChart, TrendingUp, Boxes, Users, Megaphone, Store, BarChart3,
  Landmark, ShieldCheck, Building2, ReceiptText, Notebook, ClipboardList, Receipt,
  FileText: FileTextIcon,
};

type GalleryTemplate = {
  slug: string;
  industry: string;
  icon: string;
  title: Record<TemplateLocale, string>;
  description: Record<TemplateLocale, string>;
  blocks: Block[];
};

export function TemplateGallery({ templates }: { templates: GalleryTemplate[] }) {
  const { locale, t } = useT();
  const industries = useMemo(
    () => Array.from(new Set(templates.map((x) => x.industry))),
    [templates]
  );
  const [active, setActive] = useState<string | null>(null);

  const filtered = active ? templates.filter((x) => x.industry === active) : templates;
  const safeLocale = (locale === "th" || locale === "zh" ? locale : "en") as TemplateLocale;

  return (
    <div className="mx-auto max-w-6xl px-8 pb-12 pt-7">
      <PageHeader title={t("templates.title")} description={t("templates.subtitle")} />


      <div className="mb-6 flex flex-wrap items-center gap-1.5">
        <Chip label="All" active={active == null} onClick={() => setActive(null)} />
        {industries.map((i) => (
          <Chip
            key={i}
            label={t(`templates.industry.${i}`)}
            active={active === i}
            onClick={() => setActive(i)}
          />
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((tpl) => {
          const Icon = ICONS[tpl.icon] ?? BarChart3;
          return (
            <form
              key={tpl.slug}
              action="/api/reports/from-template"
              method="POST"
              className="group flex flex-col gap-3 rounded-xl border border-border bg-card p-5 shadow-xs transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md"
            >
              <input type="hidden" name="slug" value={tpl.slug} />
              <div className="overflow-hidden rounded-lg border border-border bg-muted p-1.5" style={{ aspectRatio: "16 / 10" }}>
                <div className="flex h-full items-center justify-center rounded-md bg-card p-1">
                  <TemplateThumbnail blocks={tpl.blocks} />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Icon className="h-4 w-4" />
                </div>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t(`templates.industry.${tpl.industry}`)}
                </span>
              </div>
              <div className="min-h-[96px]">
                <h3 className="font-semibold tracking-tight">{tpl.title[safeLocale] ?? tpl.title.en}</h3>
                <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{tpl.description[safeLocale] ?? tpl.description.en}</p>
              </div>
              <div className="flex items-center justify-end border-t border-border/70 pt-3">
                <button
                  type="submit"
                  className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
                >
                  {t("action.useTemplate")} <ArrowRight className="h-3 w-3" />
                </button>
              </div>
            </form>
          );
        })}
      </div>
    </div>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground hover:border-foreground/20 hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}
