"use client";
/**
 * UpgradeLock — UI primitive for "this is gated behind a higher tier" surfaces.
 *
 * Three variants for the three places an upgrade gate naturally appears:
 *   - "wrap"   wraps its children in a dimmed overlay with a centered CTA.
 *              Use this for a config panel section or a chart picker tile —
 *              the user still gets to peek at what they'd be buying.
 *   - "card"   a standalone notice with feature label + tier + CTA. Drop
 *              this into an empty state where you would otherwise render
 *              the feature (e.g. an empty kiosk-token panel for Free).
 *   - "inline" a tiny lock-pill that sits inline next to a control's label
 *              ("Sankey"), used for unavailable picker options.
 *
 * The component is `"use client"` because the CTA is a button that should
 * navigate via plain Link — no client-side state.
 *
 *   <UpgradeLock feature="connector.snowflake" currentTier={user.tier} />
 *   <UpgradeLock feature="viz.chart.sankey" currentTier={tier} variant="inline" />
 *   <UpgradeLock feature="ai.story_mode" currentTier={tier} variant="wrap">
 *     <StoryModePreview />
 *   </UpgradeLock>
 *
 * The component looks up its own messaging from FEATURE_TIERS — callers
 * never pass strings. That keeps the gate machinery a single source of
 * truth: change the required tier in featureGate.ts and every UpgradeLock
 * follows along automatically.
 */
import Link from "next/link";
import { eeClient } from "@/ee/client";
import { Lock, Sparkles, ArrowRight } from "lucide-react";
import {
  FEATURE_TIERS,
  featureAvailable,
  humanizeFeatureKey,
  type FeatureKey,
} from "@/lib/featureGate";
import { planForTier } from "@/lib/billing";
import { useT } from "@/lib/i18n/LocaleContext";

const TAGLINE_KEY: Record<string, string> = {
  community: "upgradeLock.tagline.community",
  growth: "upgradeLock.tagline.growth",
  business: "upgradeLock.tagline.business",
  enterprise: "upgradeLock.tagline.enterprise",
};

export type UpgradeLockProps = {
  /** Feature key that drives the required-tier lookup. */
  feature: FeatureKey;
  /** Tenant's current tier from the session (`user.tier` after login). */
  currentTier: string | null | undefined;
  /** Visual variant — see file header. Default: "card". */
  variant?: "card" | "wrap" | "inline";
  /** Optional override for the upgrade CTA destination. Defaults to /admin/billing. */
  upgradeUrl?: string;
  /** Wrap variant only — the children rendered behind the dimmed overlay. */
  children?: React.ReactNode;
  /** Card variant only — replace the default body line with custom copy. */
  description?: string;
  /** Card variant only — replace the default heading. */
  title?: string;
  className?: string;
};

/**
 * UpgradeLock — renders gated UI when the tenant's tier is below the
 * required tier for `feature`. When the tenant already has access, the
 * component is transparent: `wrap` returns its children, `card`/`inline`
 * return null. This lets callers render `<UpgradeLock>` unconditionally
 * inside their JSX and let the component decide whether to show itself.
 */
export function UpgradeLock({
  feature,
  currentTier,
  variant = "card",
  upgradeUrl = eeClient.edition === "community" ? "https://curf.ai/pricing/" : "/admin/billing",
  children,
  description,
  title,
  className,
}: UpgradeLockProps) {
  const { t } = useT();
  const hasAccess = featureAvailable(currentTier, feature);

  // Already on the right tier — pass-through. Wrap renders the children
  // unchanged; card/inline render nothing (callers should usually render
  // a different control when access is granted, but defaulting to null
  // keeps `<UpgradeLock>` safe to drop in everywhere).
  if (hasAccess) {
    if (variant === "wrap") return <>{children}</>;
    return null;
  }

  const requiredTier = FEATURE_TIERS[feature];
  const requiredPlan = planForTier(requiredTier);
  const featureLabel = humanizeFeatureKey(feature);
  const translatedTagline = t(TAGLINE_KEY[requiredTier] ?? "") || requiredPlan.tagline;

  // ----- Inline pill -------------------------------------------------------
  if (variant === "inline") {
    return (
      <span
        className={
          "inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground " +
          (className ?? "")
        }
        title={t("upgradeLock.inlineTitleTemplate").replace("{feature}", featureLabel).replace("{plan}", requiredPlan.name)}
      >
        <Lock className="h-3 w-3" />
        {requiredPlan.name}
      </span>
    );
  }

  // ----- Wrap (dimmed children + centered CTA) -----------------------------
  if (variant === "wrap") {
    return (
      <div className={"relative isolate " + (className ?? "")}>
        {/* Dimmed preview of what they'd unlock. We use opacity + grayscale
            instead of pointer-events:none alone so accessibility tools see
            the gated content as informational, not interactive. */}
        <div
          aria-hidden
          className="pointer-events-none select-none opacity-40 saturate-50 blur-[1px]"
        >
          {children}
        </div>
        {/* Center overlay with the upgrade CTA. Blur backdrop so it floats
            cleanly over busy background content (e.g. a chart preview). */}
        <div className="absolute inset-0 z-10 grid place-items-center p-4">
          <div className="max-w-sm rounded-2xl border border-border bg-background/95 p-5 text-center shadow-xl backdrop-blur-md">
            <div className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">
              <Sparkles className="h-5 w-5" />
            </div>
            <p className="text-sm font-semibold text-foreground">
              {title ?? t("upgradeLock.titleTemplate").replace("{feature}", featureLabel).replace("{plan}", requiredPlan.name)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {description ?? translatedTagline}
            </p>
            <Link
              href={upgradeUrl}
              className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
            >
              {t("upgradeLock.upgradeToPlan").replace("{plan}", requiredPlan.name)}
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // ----- Card (default) ----------------------------------------------------
  return (
    <div
      className={
        "flex items-start gap-3 rounded-xl border border-border bg-card p-4 " +
        (className ?? "")
      }
    >
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
        <Lock className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">
          {title ?? t("upgradeLock.titleTemplate").replace("{feature}", featureLabel).replace("{plan}", requiredPlan.name)}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {description ?? t("upgradeLock.cardDescTemplate").replace("{plan}", requiredPlan.name).replace("{price}", String(requiredPlan.seats?.editorUsd ?? 0)).replace("{tagline}", translatedTagline)}
        </p>
        <Link
          href={upgradeUrl}
          className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
        >
          {t("upgradeLock.upgradeToUnlock")}
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}

/**
 * Convenience hook-free predicate. Re-exported for callers that just want
 * a boolean ("should I render the real picker option or grey it out?")
 * without pulling in featureGate directly.
 */
export function isFeatureAvailable(currentTier: string | null | undefined, feature: FeatureKey): boolean {
  return featureAvailable(currentTier, feature);
}
