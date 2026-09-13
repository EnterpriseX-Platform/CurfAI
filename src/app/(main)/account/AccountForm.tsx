"use client";
/**
 * AccountForm — interactive surface for /account.
 *
 * Holds local state, debounces saves to PUT /api/user/preferences. Each
 * row is its own grouping (Theme / Mode / Density / Motion) so the page
 * stays scannable even as we add prefs in future slices.
 */
import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { THEME_PRESETS } from "@/lib/reporting/themes";
import type { Theme } from "@/lib/reporting/schema";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/LocaleContext";
import { applyThemeMode } from "@/lib/themeMode";

type Prefs = {
  themeOverride?: Theme | null;
  mode?: "light" | "dark" | "auto";
  density?: "comfortable" | "compact";
  fontScale?: number;
  reducedMotion?: boolean;
};

export function AccountForm({ initial }: { initial: Prefs }) {
  const { t } = useT();
  const [prefs, setPrefs] = useState<Prefs>(initial);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/user/preferences", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify(prefs),
        });
        if (res.ok) setSavedAt(Date.now());
      } catch { /* swallow — the user can re-edit and try again */ }
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [prefs]);

  function patch(p: Partial<Prefs>) {
    setPrefs((cur) => ({ ...cur, ...p }));
  }

  return (
    <div className="space-y-8">
      {/* Theme override */}
      <Section
        title={t("account.themeHeading")}
        hint={t("account.themeHint")}
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <ThemeCard
            active={!prefs.themeOverride}
            onClick={() => patch({ themeOverride: null })}
            swatch="#94a3b8"
            label={t("account.useReportTheme")}
            description={t("account.useReportThemeDesc")}
          />
          {Object.values(THEME_PRESETS).map((preset) => (
            <ThemeCard
              key={preset.slug}
              active={prefs.themeOverride === preset.slug}
              onClick={() => patch({ themeOverride: preset.slug })}
              swatch={preset.swatch}
              label={preset.label}
              description={preset.description}
              palette={preset.palette.slice(0, 5)}
            />
          ))}
        </div>
      </Section>

      <Section
        title={t("account.modeHeading")}
        hint={t("account.modeHint")}
      >
        <ChipRow
          options={[
            { slug: "auto", label: t("account.modeAuto") },
            { slug: "light", label: t("account.modeLight") },
            { slug: "dark", label: t("account.modeDark") },
          ]}
          value={prefs.mode ?? "auto"}
          // Applied to <html> at once; the save below makes it stick for the
          // next load (ThemeModeBoot reads it server-side).
          onChange={(v) => { applyThemeMode(v as Prefs["mode"] & string); patch({ mode: v as Prefs["mode"] }); }}
        />
      </Section>

      <Section
        title={t("account.densityHeading")}
        hint={t("account.densityHint")}
      >
        <ChipRow
          options={[
            { slug: "comfortable", label: t("account.densityComfortable") },
            { slug: "compact",     label: t("account.densityCompact") },
          ]}
          value={prefs.density ?? "comfortable"}
          onChange={(v) => patch({ density: v as Prefs["density"] })}
        />
      </Section>

      <Section title={t("account.motionHeading")} hint={t("account.motionHint")}>
        <label className="flex cursor-pointer items-center justify-between rounded-md border border-border bg-background px-3 py-2.5">
          <div>
            <Label className="text-sm">{t("account.reducedMotion")}</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("account.reducedMotionDesc")}
            </p>
          </div>
          <input
            type="checkbox"
            checked={!!prefs.reducedMotion}
            onChange={(e) => patch({ reducedMotion: e.target.checked })}
            className="h-4 w-4 accent-[hsl(var(--primary))]"
          />
        </label>
      </Section>

      <p className="text-xs text-muted-foreground">
        {savedAt ? <>{t("account.saved")} <Check className="mr-1 inline-block h-3 w-3 text-success" />{new Date(savedAt).toLocaleTimeString()}</> : t("account.savesAutomatically")}
      </p>
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

function ThemeCard({ active, onClick, swatch, label, description, palette }: {
  active: boolean;
  onClick: () => void;
  swatch: string;
  label: string;
  description: string;
  palette?: string[];
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition-shadow",
        active ? "border-primary shadow-sm ring-2 ring-primary/40" : "border-border bg-background hover:bg-muted/40",
      )}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="h-4 w-4 rounded-full ring-1 ring-border" style={{ background: swatch }} />
        <span className="text-sm font-medium">{label}</span>
        {active && <Check className="h-3.5 w-3.5 text-primary" />}
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">{description}</p>
      {palette && palette.length > 0 && (
        <div className="flex overflow-hidden rounded ring-1 ring-border">
          {palette.map((c, i) => (
            <span key={i} className="block h-3 w-4" style={{ background: c }} />
          ))}
        </div>
      )}
    </button>
  );
}

function ChipRow({ options, value, onChange }: {
  options: { slug: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={o.slug}
          type="button"
          onClick={() => onChange(o.slug)}
          className={cn(
            "rounded-full border px-3 py-1 text-xs transition-colors",
            value === o.slug ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background hover:bg-muted",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
