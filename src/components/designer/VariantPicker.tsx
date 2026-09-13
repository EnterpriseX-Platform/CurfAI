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

type Variant = "success" | "warning" | "danger" | "info" | "neutral";

const VARIANTS: { slug: Variant; label: string; chip: string; ring: string }[] = [
  { slug: "success", label: "Success", chip: "bg-success/15 text-success ring-success/40", ring: "ring-success" },
  { slug: "warning", label: "Warning", chip: "bg-warning/15  text-warning  ring-warning/40",  ring: "ring-warning" },
  { slug: "danger",  label: "Danger",  chip: "bg-destructive/15   text-destructive   ring-destructive/40",   ring: "ring-destructive" },
  { slug: "info",    label: "Info",    chip: "bg-primary/15 text-primary-ink ring-primary/40", ring: "ring-primary" },
  { slug: "neutral", label: "Neutral", chip: "bg-muted-foreground/15  text-muted-foreground  ring-faint/40",  ring: "ring-faint" },
];

/** Curated icon set. Order matters — "auto" first, "none" last. */
const ICON_OPTIONS: { kind: VariantIconKindT; label: string; Icon: LucideIcon }[] = [
  { kind: "auto",      label: "Auto (match variant)", Icon: Wand2 },
  { kind: "check",     label: "Check",                Icon: CheckCircle2 },
  { kind: "warning",   label: "Warning triangle",     Icon: AlertTriangle },
  { kind: "alert",     label: "Alert / X",            Icon: XCircle },
  { kind: "info",      label: "Info",                 Icon: Info },
  { kind: "arrowUp",   label: "Up",                   Icon: ArrowUpRight },
  { kind: "arrowDown", label: "Down",                 Icon: ArrowDownRight },
  { kind: "minus",     label: "Neutral / minus",      Icon: MinusCircle },
  { kind: "star",      label: "Star",                 Icon: Star },
  { kind: "flag",      label: "Flag",                 Icon: Flag },
  { kind: "sparkle",   label: "Sparkle",              Icon: Sparkles },
  { kind: "none",      label: "No icon",              Icon: Ban },
];

export function VariantChips({
  value, onChange, size = "md",
}: {
  value: Variant;
  onChange: (next: Variant) => void;
  size?: "sm" | "md";
}) {
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
            title={v.label}
          >
            {v.label}
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
  const fg = VARIANT_FG[variant];
  const current = value ?? "auto";
  return (
    <div className="grid grid-cols-6 gap-1">
      {ICON_OPTIONS.map(({ kind, label, Icon }) => {
        const active = current === kind;
        return (
          <button
            key={kind}
            type="button"
            onClick={() => onChange(kind)}
            title={label}
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
