"use client";
/**
 * VariantPicker — paired controls for picking a variant + an iconKind.
 *
 * Used inside the conditional-rules editor and the chart-annotations editor.
 * Two halves:
 *
 *   1. Variant chips: 5 colored pills (success/warning/danger/info/neutral).
 *      Selected chip is filled with its semantic color; others are outlined.
 *
 *   2. Icon kind: a swatch grid showing each curated Lucide icon at 16px in
 *      its variant-matched color. Includes "auto" (the variant's default
 *      icon) and "none" (suppress) as first-class options. The swatch
 *      labels are tooltips, not visible text — the icons themselves carry
 *      the meaning.
 *
 * Both halves are uncontrolled wrappers over the parent's onChange — pass
 * (variant, iconKind) callbacks separately so callers can hold them in
 * different fields.
 */
import {
  CheckCircle2, AlertTriangle, XCircle, Info,
  ArrowUpRight, ArrowDownRight, MinusCircle, Star, Flag, Sparkles,
  Wand2, Ban,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { VariantIconKindT } from "@/lib/reporting/schema";
import { VARIANT_FG } from "@/components/blocks/VariantIcon";
import { useT } from "@/lib/i18n/LocaleContext";

type Variant = "success" | "warning" | "danger" | "info" | "neutral";

// Chip names are variant.<slug>, icon tooltips variantIcon.<kind>.
const VARIANTS: { slug: Variant; chip: string; ring: string }[] = [
  { slug: "success", chip: "bg-success/15 text-success ring-success/40", ring: "ring-success" },
  { slug: "warning", chip: "bg-warning/15  text-warning  ring-warning/40",  ring: "ring-warning" },
  { slug: "danger",  chip: "bg-destructive/15   text-destructive   ring-destructive/40",   ring: "ring-destructive" },
  { slug: "info",    chip: "bg-primary/15 text-primary-ink ring-primary/40", ring: "ring-primary" },
  { slug: "neutral", chip: "bg-muted-foreground/15  text-muted-foreground  ring-faint/40",  ring: "ring-faint" },
];

/** Curated icon set. Order matters — "auto" first, "none" last. */
const ICON_OPTIONS: { kind: VariantIconKindT; Icon: LucideIcon }[] = [
  { kind: "auto",      Icon: Wand2 },
  { kind: "check",     Icon: CheckCircle2 },
  { kind: "warning",   Icon: AlertTriangle },
  { kind: "alert",     Icon: XCircle },
  { kind: "info",      Icon: Info },
  { kind: "arrowUp",   Icon: ArrowUpRight },
  { kind: "arrowDown", Icon: ArrowDownRight },
  { kind: "minus",     Icon: MinusCircle },
  { kind: "star",      Icon: Star },
  { kind: "flag",      Icon: Flag },
  { kind: "sparkle",   Icon: Sparkles },
  { kind: "none",      Icon: Ban },
];

export function VariantChips({
  value, onChange, size = "md",
}: {
  value: Variant;
  onChange: (next: Variant) => void;
  size?: "sm" | "md";
}) {
  const { t } = useT();
  return (
    <div className="flex flex-wrap gap-1">
      {VARIANTS.map((v) => {
        const active = value === v.slug;
        return (
          <button
            key={v.slug}
            type="button"
            onClick={() => onChange(v.slug)}
            className={cn(
              "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium ring-1 transition-colors",
              v.chip,
              active ? "ring-2 " + v.ring : "ring-transparent opacity-60 hover:opacity-100",
              size === "sm" && "px-2 py-px text-[10px]",
            )}
            title={t(`variant.${v.slug}`)}
          >
            {t(`variant.${v.slug}`)}
          </button>
        );
      })}
    </div>
  );
}

export function IconKindGrid({
  value, variant, onChange,
}: {
  value: VariantIconKindT | undefined;
  /** Drives the rendered foreground color of each preview swatch. */
  variant: Variant;
  onChange: (next: VariantIconKindT) => void;
}) {
  const { t } = useT();
  const fg = VARIANT_FG[variant];
  const current = value ?? "auto";
  return (
    <div className="grid grid-cols-6 gap-1">
      {ICON_OPTIONS.map(({ kind, Icon }) => {
        const active = current === kind;
        return (
          <button
            key={kind}
            type="button"
            onClick={() => onChange(kind)}
            title={t(`variantIcon.${kind}`)}
            className={cn(
              "flex h-8 items-center justify-center rounded-md border transition-colors",
              active
                ? "border-primary bg-primary/10"
                : "border-border bg-background hover:bg-muted",
            )}
          >
            <Icon
              width={14}
              height={14}
              strokeWidth={1.75}
              color={kind === "auto" || kind === "none" ? "#64748b" : fg}
            />
          </button>
        );
      })}
    </div>
  );
}
