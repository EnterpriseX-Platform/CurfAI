"use client";
/**
 * Shared KPI card language — one set of presentational pieces so every
 * card that shows a hash-verified number (report-tab KPI blocks, the
 * Executive Brief's headline row, and any future surface) reads as the
 * same object: same radius/shadow/padding, same tiered value size, same
 * count-up behaviour, same delta and receipt typography.
 *
 * `KpiBlock.tsx` is the original implementation these pieces were lifted
 * out of; it now consumes them instead of re-declaring its own markup.
 * `BriefKpiCard.tsx` (the Executive Brief's card) is the second consumer —
 * before this module existed it re-implemented a subset by hand, which is
 * exactly the copy-paste drift ("$0.00 vs $443.5M for the same query")
 * this tier of work exists to close.
 */
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Should the count-up run at all, given how the page is being viewed?
 *
 * A hidden tab never services requestAnimationFrame, so an animation that
 * snaps to 0 and waits for the first frame leaves the card reading "0" for
 * as long as the tab stays backgrounded. That is a *wrong number* on screen,
 * not a missing flourish — a wall display waking up, a background tab being
 * screenshotted, or a PDF captured headless would all show zero.
 *
 * So: animate only when the document is actually visible and the viewer has
 * not asked for reduced motion. Otherwise render the real value immediately.
 *
 * Exported for tests — jsdom cannot drive rAF timing convincingly, but the
 * decision itself is pure.
 */
export function shouldAnimateCountUp(
  doc: { visibilityState?: DocumentVisibilityState } | undefined,
  prefersReducedMotion: boolean,
): boolean {
  if (prefersReducedMotion) return false;
  // `undefined` means we have no signal (SSR, older embed); animating is the
  // friendlier default there because a real browser will service the frames.
  return doc?.visibilityState !== "hidden";
}

/**
 * Count-up animation. Eases from 0 to `value` over ~900ms with cubic
 * ease-out, calling `format` on every frame so the readout reflects
 * whatever shape the consumer wants (compact $17.2M, 71%, etc).
 *
 * Re-runs whenever `value` changes — dashboards that swap parameters
 * see a fresh animation, not a jump cut.
 */
export function AnimatedNumber({
  value, format, className = "", style, title,
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}) {
  // `animated` holds the current frame's interpolated number while the
  // animation is running. Stays `undefined` during SSR + the first
  // client render so the markup is byte-identical across both passes
  // (avoids the React hydration-mismatch warning entirely).
  //
  // Once `useEffect` fires (post-hydration), we snap to 0 and animate
  // up to `value` over ~900ms with easeOutCubic.
  const [animated, setAnimated] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!Number.isFinite(value)) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (!shouldAnimateCountUp(document, reduced)) {
      // Leave `animated` undefined so the true value renders straight away.
      setAnimated(undefined);
      return;
    }
    let raf = 0;
    let start: number | null = null;
    const from = 0;
    const DURATION = 900;
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);
    setAnimated(from);
    const tick = (now: number) => {
      if (start == null) start = now;
      const t = Math.min(1, (now - start) / DURATION);
      setAnimated(from + (value - from) * ease(t));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // Switching away mid-flight stops the frames and would freeze the readout
    // part-way to the real number. Snap to the truth instead.
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        cancelAnimationFrame(raf);
        setAnimated(undefined);
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [value]);
  const display = animated === undefined ? value : animated;
  return <span className={className} style={style} title={title}>{format(display)}</span>;
}

/**
 * What the card shows is decided by how tall the author made it (grid rows
 * of 40px, see ReportDocument's ROW_HEIGHT_PX) — the layout is fixed, so
 * content that wouldn't fit is simply not asked for:
 *
 *   tiny    h ≤ 2  (≤ 80px)   label · value
 *   compact h = 3  (120px)    + delta
 *   mid     h = 4  (160px)    + sparkline
 *   tall    h = 5  (200px)    + receipt row, bigger value
 *   hero    h ≥ 6  (≥ 240px)  + Why? / Replay actions, biggest value
 *
 * Dashboard cells (`bare`) are large and have no grid rows; they behave as
 * `tall`. The Executive Brief's headline row (BriefKpiCard) picks `mid` or
 * `tall` directly — it has no grid height of its own to derive a tier from.
 */
export type Tier = "tiny" | "compact" | "mid" | "tall" | "hero";
export function tierFor(h: number | undefined, bare: boolean): Tier {
  const rows = bare ? 5 : (h ?? 3);
  if (rows >= 6) return "hero";
  if (rows >= 5) return "tall";
  if (rows >= 4) return "mid";
  if (rows >= 3) return "compact";
  return "tiny";
}
export const VALUE_PX: Record<Tier, number> = { tiny: 22, compact: 26, mid: 26, tall: 32, hero: 40 };

/**
 * The card's frame: radius, border, shadow and padding — the one thing
 * every KPI card shares regardless of what it shows inside. `bare` drops
 * the border/shadow/padding for a dashboard cell that already draws its
 * own frame around the block.
 */
export function KpiCardFrame({
  tier, bare, className, children,
}: {
  tier: Tier;
  bare?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "group relative flex h-full min-w-0 flex-col gap-1.5",
        bare ? "px-1 py-1" : "rounded-report border border-border bg-card px-[18px] py-3.5",
        !bare && tier === "hero" ? "shadow-md" : !bare ? "shadow-xs" : "",
        (tier === "tiny" || tier === "compact") && "justify-center",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Header row: the uppercase label (2-line clamp except at `tiny`, which
 *  truncates to one) and an optional trailing slot — the verified seal,
 *  block actions, whatever the card's header needs on the right. */
export function KpiLabel({
  tier, title, trailing,
}: {
  tier: Tier;
  title: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <p
        className={cn(
          "min-w-0 text-xs font-medium uppercase leading-snug tracking-[.04em] text-muted-foreground",
          tier === "tiny" ? "truncate" : "line-clamp-2",
        )}
        title={typeof title === "string" ? title : undefined}
      >
        {title}
      </p>
      {trailing && <div className="flex shrink-0 items-center gap-1 -mt-px">{trailing}</div>}
    </div>
  );
}

/**
 * The number itself — tiered size with a step-down for long strings so
 * nothing ever clips, count-up animated via `format` on every frame.
 * `display` is the STATIC final string (only used to size the value);
 * the animation always calls `format`, never re-derives `display` itself.
 */
export function KpiValue({
  value, format, display, tier, prefix, suffix, title, scale = 1,
}: {
  value: number;
  /** Frame-by-frame formatter, called on every count-up tick. */
  format: (n: number) => string;
  /** The final formatted string, used only to decide the step-down size. */
  display: string;
  tier: Tier;
  prefix?: string;
  suffix?: string;
  title?: string;
  /** Multiplier on the tier's base size — the Executive bento grid's
   *  anchor tile reads noticeably bigger than its neighbours (the v3
   *  prototype's own `.anchor .t-val` override) without needing a whole
   *  extra Tier value, which would also change KpiLabel's line-clamp and
   *  KpiCardFrame's padding rules that every other card still wants at
   *  "mid". Defaults to 1 — every existing caller is unaffected. */
  scale?: number;
}) {
  const basePx = VALUE_PX[tier] * scale;
  const valuePx = display.length > 11 ? Math.round(basePx * 0.7) : display.length > 9 ? Math.round(basePx * 0.85) : basePx;
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      {prefix && <span className="text-xs font-medium uppercase tracking-[.06em] text-faint">{prefix}</span>}
      <AnimatedNumber
        value={value}
        format={format}
        title={title}
        style={{ fontSize: valuePx, lineHeight: 1.05 }}
        className="truncate font-semibold tabular-nums tracking-[-.02em] text-foreground"
      />
      {suffix && <span className="text-xs font-medium uppercase tracking-[.06em] text-faint">{suffix}</span>}
    </div>
  );
}

/**
 * The delta line: arrow + magnitude, coloured by whether the direction is
 * favorable, then a muted caption. `dir:"flat"` (no comparison available)
 * renders a muted "—" instead of forcing a colour call on nothing.
 */
export function KpiDelta({
  dir, good, text, caption,
}: {
  dir: "up" | "down" | "flat";
  /** Whether this direction counts as favorable. Ignored (renders muted)
   *  when dir is "flat". */
  good: boolean;
  /** Magnitude text, e.g. "3.2%" or "0.3 pt" — omit for the flat case. */
  text?: string;
  /** Trailing muted caption, e.g. "vs 7 days ago" or "vs 7 days ago · from $1.2M". */
  caption: string;
}) {
  const cls = dir === "flat" ? "text-muted-foreground" : good ? "text-success" : "text-destructive";
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "—";
  return (
    <p className={cn("flex flex-wrap items-center gap-1.5 text-[13px] font-medium leading-tight", cls)}>
      <span className="tabular-nums">{arrow}{text ? ` ${text}` : ""}</span>
      <span className="font-normal text-muted-foreground">{caption}</span>
    </p>
  );
}

/**
 * The run receipt: a small verified seal (omitted when there's no hash to
 * back it — never a checkmark over nothing) followed by mono provenance
 * text the caller composes (hash, run time, row count).
 */
export function KpiReceipt({ hash, children }: { hash?: string | null; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-faint" title={hash ?? undefined}>
      {hash && (
        <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-success text-success">
          <Check className="h-2 w-2" strokeWidth={3} />
        </span>
      )}
      <span className="truncate tabular-nums">{children}</span>
    </div>
  );
}
