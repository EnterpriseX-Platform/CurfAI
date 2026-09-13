"use client";
/**
 * BarList — Tremor-style ranked top-N with inline value bars.
 *
 * Each row renders the bar AS the row background (an inset percentage
 * fill behind the label + value). Looks like one of those "spending
 * categories" widgets in a polished SaaS dashboard. Designed to be
 * dropped in anywhere a top-N ranked list belongs (top approvers, top
 * contractors, top failed destinations).
 *
 * Owned in this repo (Tremor-Raw style) so we can edit freely.
 */
import { cn } from "@/lib/utils";

export type BarListItem = {
  /** Row label, shown left-aligned. */
  name: string;
  /** Numeric value powering the bar fill + the right-aligned readout. */
  value: number;
  /** Optional href — when set the row becomes a link. */
  href?: string;
  /** Optional small secondary text shown after the name. */
  meta?: string;
};

// Status tones ride the semantic tokens (success / warning / destructive) so
// they follow the theme, including dark surfaces. `violet` and `sky` are
// categorical accents with no semantic meaning and stay on the palette.
const TONES = {
  primary: { bar: "bg-primary/15",     text: "text-foreground" },
  emerald: { bar: "bg-success/15",     text: "text-success" },
  amber:   { bar: "bg-warning/15",     text: "text-warning" },
  rose:    { bar: "bg-destructive/15", text: "text-destructive" },
  violet:  { bar: "bg-primary-soft",     text: "text-primary-ink" },
  sky:     { bar: "bg-primary-soft",        text: "text-primary-ink" },
} as const;

export type BarListTone = keyof typeof TONES;

export function BarList({
  data, valueFormatter, tone = "primary", className,
}: {
  data: BarListItem[];
  /** Format the right-aligned numeric. Defaults to `toLocaleString`. */
  valueFormatter?: (v: number) => string;
  tone?: BarListTone;
  className?: string;
}) {
  const t = TONES[tone];
  const max = Math.max(1, ...data.map((d) => d.value));
  const fmt = valueFormatter ?? ((v: number) => v.toLocaleString());

  if (data.length === 0) {
    return (
      <div className={cn("rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground", className)}>
        No data.
      </div>
    );
  }

  return (
    <ul className={cn("space-y-1.5", className)}>
      {data.map((row, i) => {
        const pct = Math.max(2, Math.round((row.value / max) * 100));
        const Tag: any = row.href ? "a" : "div";
        const props = row.href ? { href: row.href } : {};
        return (
          <li key={i} className="relative">
            {/* Bar fill — sits behind the row content as an inset. */}
            <span
              className={cn("absolute inset-y-0 left-0 rounded-md transition-all", t.bar)}
              style={{ width: `${pct}%` }}
              aria-hidden
            />
            <Tag
              {...props}
              className={cn(
                "relative flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm",
                t.text,
                row.href && "transition hover:brightness-95 cursor-pointer",
              )}
            >
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{row.name}</span>
                {row.meta && <span className="ml-2 text-xs opacity-70">{row.meta}</span>}
              </span>
              <span className="shrink-0 font-semibold tabular-nums">{fmt(row.value)}</span>
            </Tag>
          </li>
        );
      })}
    </ul>
  );
}
