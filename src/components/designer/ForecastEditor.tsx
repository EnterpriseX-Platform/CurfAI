"use client";
/**
 * ForecastEditor — bespoke UI for ChartConfigSchema.forecast.
 *
 * Renders three controls:
 *   - Method: linear or smoothed (ai.forecast_linear) or LLM
 *     (ai.forecast_llm). Each option carries a one-line explainer so
 *     authors understand the trade-off (deterministic vs richer narrative),
 *     and a plan badge read from FEATURE_TIERS so it can't drift from the
 *     real gate.
 *   - Periods: stepper 1..24, with a hint of what 4 / 12 / 24 typically
 *     mean in dashboard time (a quarter / a year / two years for monthly).
 *   - Show bands: toggle for the shaded confidence-region overlay.
 *
 * Setting the editor to "off" returns undefined so the field disappears
 * from the saved JSON entirely (no orphan zero-period config).
 */
import { Sparkles, Activity, TrendingUp } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/LocaleContext";
import { FEATURE_TIERS, type FeatureKey } from "@/lib/featureTiers";
import { planForTier } from "@/lib/plans";

type Forecast = {
  method: "linear" | "ets" | "llm";
  periods: number;
  showBands: boolean;
};

export function ForecastEditor({
  value, onChange,
}: {
  value: Forecast | undefined;
  onChange: (next: Forecast | undefined) => void;
}) {
  const { t } = useT();
  const enabled = !!value;
  const fc: Forecast = value ?? { method: "linear", periods: 4, showBands: true };

  function patch(p: Partial<Forecast>) {
    onChange({ ...fc, ...p });
  }
  function disable() {
    onChange(undefined);
  }
  function enable() {
    onChange({ method: "linear", periods: 4, showBands: true });
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-2.5">
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-[11px]">{t("forecastEditor.title")}</Label>
          <p className="text-[10px] text-muted-foreground">{t("forecastEditor.hint")}</p>
        </div>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => (e.target.checked ? enable() : disable())}
          className="h-4 w-4 accent-[hsl(var(--primary))]"
        />
      </div>

      {enabled && (
        <>
          {/* Method picker — three cards with icon + name + explainer */}
          <div className="grid grid-cols-3 gap-2">
            {METHOD_OPTIONS.map((opt) => {
              const active = fc.method === opt.slug;
              const Icon = opt.Icon;
              return (
                <button
                  key={opt.slug}
                  type="button"
                  onClick={() => patch({ method: opt.slug })}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-md border p-2 text-left transition-colors",
                    active ? "border-primary bg-primary/5" : "border-border bg-background hover:bg-muted",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <Icon className="h-3.5 w-3.5 text-primary" />
                    <span className="text-[11px] font-medium">{t(`forecast.method.${opt.slug}.label`)}</span>
                    <span className="rounded-full bg-muted px-1.5 py-0 text-[9px] uppercase tracking-wider text-muted-foreground">
                      {planForTier(FEATURE_TIERS[opt.feature]).name}
                    </span>
                  </div>
                  <p className="text-[10px] leading-snug text-muted-foreground">{t(`forecastEditor.method.${opt.slug}.hint`)}</p>
                </button>
              );
            })}
          </div>

          {/* Periods stepper */}
          <div className="grid gap-1">
            <Label className="text-[10px]">{t("forecastEditor.periods")}</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={24}
                value={fc.periods}
                onChange={(e) => patch({ periods: Math.max(1, Math.min(24, Number(e.target.value))) })}
                className="h-7 w-20 text-xs"
              />
              <p className="text-[10px] text-muted-foreground">
                ~{fc.periods === 4 ? t("forecastEditor.aQuarter") : fc.periods === 12 ? t("forecastEditor.aYear") : fc.periods === 52 ? t("forecastEditor.aYearWeekly") : t("forecastEditor.nSteps").replace("{n}", String(fc.periods))}
              </p>
            </div>
          </div>

          {/* Bands toggle */}
          <div className="flex items-center justify-between rounded-md border border-border bg-background px-2.5 py-1.5">
            <div>
              <Label className="text-[11px]">{t("forecastEditor.band")}</Label>
              <p className="text-[10px] text-muted-foreground">{t("forecastEditor.bandHint")}</p>
            </div>
            <input
              type="checkbox"
              checked={fc.showBands}
              onChange={(e) => patch({ showBands: e.target.checked })}
              className="h-4 w-4 accent-[hsl(var(--primary))]"
            />
          </div>
        </>
      )}
    </div>
  );
}

// Names are forecast.method.<slug>.label (shared with the viewer's forecast
// control); the author-facing hints are forecastEditor.method.<slug>.hint.
// `feature` is the gate the report save route checks for that method.
const METHOD_OPTIONS: { slug: "linear" | "ets" | "llm"; feature: FeatureKey; Icon: typeof Activity }[] = [
  { slug: "linear", feature: "ai.forecast_linear", Icon: Activity },
  { slug: "ets",    feature: "ai.forecast_linear", Icon: TrendingUp },
  { slug: "llm",    feature: "ai.forecast_llm",    Icon: Sparkles },
];
