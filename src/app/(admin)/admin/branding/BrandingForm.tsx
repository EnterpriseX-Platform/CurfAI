"use client";
/**
 * BrandingForm — interactive surface for /admin/branding.
 *
 * Fields:
 *   - Logo URL (free text — the full brand-image upload pipeline is a later
 *     slice; for now URLs from a CDN are the path of least friction)
 *   - Accent color (hex picker)
 *   - Default theme (Theme picker — used when a report has no theme)
 *   - Custom palette (10-color grid; each cell opens a native color picker)
 *
 * Save is debounced. The PUT endpoint normalizes hex (adds leading #) and
 * 402s if the tenant lost Business after this page rendered.
 */
import { useEffect, useRef, useState } from "react";
import { Check, Trash2 } from "lucide-react";
import { THEME_PRESETS } from "@/lib/reporting/themes";
import { CHART_STYLE_PRESETS } from "@/lib/reporting/chartStyles";
import type { Theme, ChartStyle } from "@/lib/reporting/schema";
import { ChartStylePreview } from "./ChartStylePreview";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/LocaleContext";

type Brand = {
  logoUrl?: string;
  accentColor?: string;
  defaultTheme?: Theme;
  defaultChartStyle?: ChartStyle;
  customPalette?: string[];
};

const DEFAULT_PALETTE_SEED = ["#6366f1", "#10b981", "#f59e0b", "#f43f5e", "#06b6d4", "#8b5cf6", "#0ea5e9", "#ec4899", "#f97316", "#84cc16"];

export function BrandingForm({ initial }: { initial: Brand }) {
  const { t } = useT();
  const [brand, setBrand] = useState<Brand>(initial);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/admin/tenant/brand", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify(brand),
        });
        if (res.ok) { setSavedAt(Date.now()); setError(null); }
        else { setError((await res.json())?.error ?? t("admin.branding.saveFailed")); }
      } catch (e: any) { setError(e?.message ?? t("admin.branding.saveFailed")); }
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [brand, t]);

  function patch(p: Partial<Brand>) { setBrand((cur) => ({ ...cur, ...p })); }

  return (
    <div className="space-y-8">
      <Section title={t("admin.branding.logoTitle")} hint={t("admin.branding.logoHint")}>
        <Input
          value={brand.logoUrl ?? ""}
          onChange={(e) => patch({ logoUrl: e.target.value })}
          placeholder="https://your-cdn.example.com/logo.svg"
          className="font-mono text-xs"
        />
      </Section>

      <Section title={t("admin.branding.accentTitle")} hint={t("admin.branding.accentHint")}>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={brand.accentColor ?? "#6366f1"}
            onChange={(e) => patch({ accentColor: e.target.value })}
            className="h-9 w-12 cursor-pointer rounded-md border border-border bg-background"
          />
          <Input
            value={brand.accentColor ?? ""}
            onChange={(e) => patch({ accentColor: e.target.value })}
            placeholder="#6366f1"
            className="w-32 font-mono text-xs"
          />
        </div>
      </Section>

      <Section title={t("admin.branding.themeTitle")} hint={t("admin.branding.themeHint")}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {Object.values(THEME_PRESETS).map((preset) => (
            <button
              key={preset.slug}
              type="button"
              onClick={() => patch({ defaultTheme: preset.slug })}
              className={cn(
                "flex flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-shadow",
                brand.defaultTheme === preset.slug
                  ? "border-primary shadow-sm ring-2 ring-primary/40"
                  : "border-border bg-background hover:bg-muted/40",
              )}
            >
              <div className="flex items-center gap-2">
                <span aria-hidden className="h-4 w-4 rounded-full ring-1 ring-border" style={{ background: preset.swatch }} />
                <span className="text-sm font-medium">{preset.label}</span>
                {brand.defaultTheme === preset.slug && <Check className="h-3.5 w-3.5 text-primary" />}
              </div>
              <div className="flex overflow-hidden rounded ring-1 ring-border">
                {preset.palette.slice(0, 5).map((c, i) => (
                  <span key={i} className="block h-3 w-4" style={{ background: c }} />
                ))}
              </div>
            </button>
          ))}
        </div>
      </Section>

      {/* Sits directly under the theme picker because the two are halves of one
          decision: theme sets the colours, style sets the form. */}
      <Section title={t("admin.branding.chartStyleTitle")} hint={t("admin.branding.chartStyleHint")}>
        <div className="grid gap-2 sm:grid-cols-3">
          {Object.values(CHART_STYLE_PRESETS).map((preset) => {
            const active = (brand.defaultChartStyle ?? "classic") === preset.slug;
            return (
              <button
                key={preset.slug}
                type="button"
                onClick={() => patch({ defaultChartStyle: preset.slug })}
                aria-pressed={active}
                className={cn(
                  "flex flex-col gap-2 rounded-lg border p-3 text-left transition-shadow",
                  active
                    ? "border-primary shadow-sm ring-2 ring-primary/40"
                    : "border-border bg-background hover:bg-muted/40",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {t(`admin.branding.chartStyle.${preset.slug}`)}
                  </span>
                  {active && <Check className="h-3.5 w-3.5 text-primary" />}
                </div>
                <div className="rounded-md bg-card p-1.5 ring-1 ring-border">
                  <ChartStylePreview
                    style={preset}
                    color={
                      brand.customPalette?.[0]
                      ?? THEME_PRESETS[brand.defaultTheme ?? "default"].palette[0]
                    }
                  />
                </div>
                <span className="text-[11px] leading-snug text-muted-foreground">
                  {t(`admin.branding.chartStyle.${preset.slug}Desc`)}
                </span>
                {/* Style sets form, theme sets colour — so the exhibit look
                    needs both halves. Without this the pairing is invisible and
                    Enterprise reads as "Classic with fewer gridlines". */}
                {preset.slug === "enterprise" && brand.defaultTheme !== "boardroom" && (
                  <span className="text-[11px] leading-snug text-primary">
                    {t("admin.branding.chartStyle.pairsWith")}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </Section>

      <Section
        title={t("admin.branding.paletteTitle")}
        hint={t("admin.branding.paletteHint")}
      >
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {(brand.customPalette ?? []).map((color, i) => (
              <PaletteSwatch
                key={i}
                color={color}
                onChange={(c) => {
                  const next = [...(brand.customPalette ?? [])];
                  next[i] = c;
                  patch({ customPalette: next });
                }}
                onRemove={() => {
                  const next = [...(brand.customPalette ?? [])];
                  next.splice(i, 1);
                  patch({ customPalette: next.length ? next : undefined });
                }}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              type="button"
              onClick={() => {
                const cur = brand.customPalette ?? [];
                if (cur.length >= 10) return;
                patch({ customPalette: [...cur, DEFAULT_PALETTE_SEED[cur.length] ?? "#6366f1"] });
              }}
              disabled={(brand.customPalette ?? []).length >= 10}
            >
              + {t("admin.branding.addColor")}
            </Button>
            {(brand.customPalette ?? []).length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => patch({ customPalette: undefined })}
              >
                {t("admin.branding.clearAll")}
              </Button>
            )}
            <span className="text-[10px] text-muted-foreground">
              {t("admin.branding.colorsCount").replace("{n}", String((brand.customPalette ?? []).length))}
            </span>
          </div>
        </div>
      </Section>

      <p className="text-xs text-muted-foreground">
        {error ? <span className="text-destructive">{error}</span>
          : savedAt ? <>{t("admin.branding.saved")} <Check className="mr-1 inline-block h-3 w-3 text-success" />{new Date(savedAt).toLocaleTimeString()}</>
          : t("account.savesAutomatically")}
      </p>
    </div>
  );
}

function PaletteSwatch({ color, onChange, onRemove }: {
  color: string;
  onChange: (c: string) => void;
  onRemove: () => void;
}) {
  const { t } = useT();
  return (
    <div className="group relative inline-block">
      <input
        type="color"
        value={color}
        onChange={(e) => onChange(e.target.value)}
        className="block h-9 w-9 cursor-pointer rounded-md border border-border bg-transparent"
        title={color}
      />
      <button
        type="button"
        onClick={onRemove}
        className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full bg-destructive text-white shadow group-hover:flex"
        title={t("action.remove")}
      >
        <Trash2 className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
