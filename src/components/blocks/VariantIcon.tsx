/**
 * VariantIcon — the premium indicator. One curated, theme-respecting SVG
 * stroke icon used everywhere a variant gets a glyph (conditional table
 * rules, chart annotations, alert chips, …).
 *
 * Why not emoji: emoji render with platform-specific styles (Apple's
 * "🟢" is round and saturated; Windows' is flat with a thicker outline;
 * Linux fallback is monochrome). For a paid product, that inconsistency
 * looks toy-grade. Lucide strokes render identically across every device,
 * scale cleanly to any size, and inherit color from the variant token.
 *
 * Always 12px square, stroke-1.75, color = variant foreground. The
 * variant chip's background already encodes the meaning; the icon is the
 * *literal* glyph (check / triangle / X) reinforcing it.
 *
 * Author override path: pass `fallback` (the rule.icon free-form string)
 * to render that text instead of the SVG. We keep this for backward
 * compatibility with reports authored before iconKind existed.
 */
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Info,
  ArrowUpRight,
  ArrowDownRight,
  MinusCircle,
  Star,
  Flag,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { VariantIconKindT } from "@/lib/reporting/schema";

type Variant = "success" | "warning" | "danger" | "info" | "neutral";

/**
 * Darkened, chip-readable foreground per variant — deliberately NOT
 * theme.semantic's base accent (those are tuned for chart strokes/fills on
 * a white canvas, not for text/icon contrast on a light chip background).
 * Exported so every other spot that needs this "readable on its own chip"
 * color (e.g. VariantPicker.tsx's swatches) imports this single source
 * instead of re-declaring its own copy that can drift.
 */
export const VARIANT_FG: Record<Variant, string> = {
  success: "#0E7C5B", // = --success; 5.2:1 on white, readable on its own /10 tint
  warning: "#A8690F", // = --warning
  danger:  "#B4304A", // = --destructive
  info:    "#2B28A6", // = --primary-ink (the darker accent, for text on a tint)
  neutral: "#5D6375", // = --muted-foreground
};

const KIND_TO_ICON: Record<Exclude<VariantIconKindT, "auto" | "none">, LucideIcon> = {
  check:     CheckCircle2,
  warning:   AlertTriangle,
  alert:     XCircle,
  info:      Info,
  arrowUp:   ArrowUpRight,
  arrowDown: ArrowDownRight,
  minus:     MinusCircle,
  star:      Star,
  flag:      Flag,
  sparkle:   Sparkles,
};

/** Map "auto" to a Lucide icon based on variant — the most coherent default. */
const VARIANT_AUTO: Record<Variant, LucideIcon> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger:  XCircle,
  info:    Info,
  neutral: MinusCircle,
};

export function resolveVariantIcon(
  kind: VariantIconKindT | undefined,
  variant: Variant,
): LucideIcon | null {
  const k = kind ?? "auto";
  if (k === "none") return null;
  if (k === "auto") return VARIANT_AUTO[variant];
  return KIND_TO_ICON[k] ?? VARIANT_AUTO[variant];
}

export function VariantIcon({
  kind, variant, fallback, size = 12, className,
}: {
  kind?: VariantIconKindT;
  variant: Variant;
  /** Legacy free-form icon string. Used only when `kind` is unset. */
  fallback?: string;
  size?: number;
  className?: string;
}) {
  // Precedence:
  //   kind set        → curated Lucide SVG (the premium path)
  //   kind unset + fallback set → render the legacy string verbatim
  //   neither         → nothing
  if (kind === undefined && fallback) {
    return <span aria-hidden className={className}>{fallback}</span>;
  }
  // No kind specified and no legacy fallback → nothing.
  if (kind === undefined) return null;
  const Icon = resolveVariantIcon(kind, variant);
  if (!Icon) return null;
  return (
    <Icon
      aria-hidden
      width={size}
      height={size}
      strokeWidth={1.75}
      color={VARIANT_FG[variant]}
      className={className}
    />
  );
}
