"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, Sparkles, X } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";

/**
 * Lightweight onboarding tour for first-time viewers.
 *
 * Complements <WhatIsThisBadge /> (which is a passive 4-card overlay): this
 * one ACTIVELY points at the four things on the page — proof badge,
 * CLICK TO DRILL chip, filter bar, and the bottom-right "What is this?"
 * pill — with a CSS pulse animation and a tooltip pinned next to each.
 *
 * Auto-runs once per browser. Different localStorage key from the badge so
 * the two features don't shadow each other.
 *
 * Why hand-rolled instead of a coach-mark library:
 *   - We need ~4 steps, no library buys back its kB cost
 *   - We control the visual style end-to-end, no theme override fights
 *   - Easy to evolve (add a step, change copy) without learning an API
 */

const STORAGE_KEY = "curf-tour-v1";

export type Step = {
  /** CSS selector for the element this step points at. First match wins. */
  selector: string;
  /** Where to place the tooltip relative to the target. */
  placement: "top" | "bottom" | "left" | "right";
  title: string;
  body: string;
};

const STEPS: Step[] = [
  {
    // The proof badge is the small chat-bubble / shield icon in the top-right
    // of every block. Components render it with `data-proof-badge` so we can
    // target it without coupling to internal class names.
    selector: "[data-proof-badge]",
    placement: "left",
    title: "Hover for cryptographic proof",
    body: "Every cell carries a SHA-256 fingerprint of its query and result. Hover to inspect — or click to unfold the full SQL and bound parameters.",
  },
  {
    // The "CLICK TO DRILL" chip sits next to drill-enabled chart/map titles.
    // We tag it with data-drill-chip in ChartBlock and MapBlock.
    selector: "[data-drill-chip]",
    placement: "bottom",
    title: "Click any chart to drill",
    body: "Bars, points, and countries with this chip open a slide-out panel showing the underlying rows behind the aggregate. Date filters ride along automatically.",
  },
  {
    // The shared filter bar is in the viewer shell, anchored at the top.
    selector: "[data-filter-bar]",
    placement: "bottom",
    title: "Filters narrow everything",
    body: "Pick a date range or channel and every block re-flows in lockstep. The URL updates so you can share the filtered view in one click.",
  },
  {
    // The What is this? pill from A3.
    selector: "[data-explainer-pill]",
    placement: "top",
    title: "Want a refresher?",
    body: "This pill is always here in the bottom-right. Click it any time to revisit the four core interactions.",
  },
];

const PULSE_CLASS = "curf-tour-pulse";

export function OnboardingTour({
  steps = STEPS, storageKey = STORAGE_KEY,
}: {
  /** D6 — a second caller (AppTour) reuses this whole engine with its own
   *  step list; ReportViewerShell's own call passes neither and gets the
   *  original four steps unchanged. */
  steps?: Step[];
  /** Separate localStorage key per caller so an app's tour dismissal
   *  doesn't also silently dismiss the report viewer's, or vice versa. */
  storageKey?: string;
}) {
  const { t } = useT();
  const [active, setActive] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  // Bounding rect of the current step's target. We re-measure on every step
  // change AND on resize/scroll so the tooltip never drifts off the element.
  const [rect, setRect] = useState<DOMRect | null>(null);
  const targetRef = useRef<HTMLElement | null>(null);

  // ----- Lifecycle: decide whether to auto-start -----
  useEffect(() => {
    let cancelled = false;
    try {
      if (window.localStorage.getItem(storageKey) === "1") return;
    } catch {
      /* storage blocked, run anyway */
    }
    // Wait a beat so the report has time to render and our [data-*] anchors
    // exist in the DOM. 800ms is comfortably longer than the typical Recharts
    // / map mount, but not so long the user has already started clicking.
    const timer = setTimeout(() => { if (!cancelled) setActive(true); }, 800);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [storageKey]);

  // ----- Re-measure target on step change, scroll, resize -----
  useLayoutEffect(() => {
    if (!active) return;
    const step = steps[stepIdx];
    if (!step) return;

    // Find the target. Selector might not match if the report is unusual
    // (e.g., no drill chip configured, or the explainer pill was already
    // dismissed by the user, removing the data-explainer-pill anchor) — in
    // that case auto-skip to the next step. When we run out of steps via
    // auto-skip we still set the dismissal flag (`true`), because re-firing
    // a partial tour on every page load is worse than skipping the missing
    // step once.
    const el = document.querySelector<HTMLElement>(step.selector);
    if (!el) {
      const next = stepIdx + 1;
      if (next < steps.length) setStepIdx(next);
      else finishTour(true);
      return;
    }

    // Clean previous pulse, then mark this one.
    document.querySelectorAll("." + PULSE_CLASS).forEach((n) => n.classList.remove(PULSE_CLASS));
    el.classList.add(PULSE_CLASS);
    targetRef.current = el;

    // Scroll into view (gently — center alignment with smooth behavior).
    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });

    // The tooltip needs to track the target while smooth-scroll is in flight.
    // A single RAF after scrollIntoView samples the rect mid-animation and
    // leaves the tooltip stranded. Instead we run a polling RAF loop for a
    // bounded duration (~700ms is comfortably longer than the typical
    // browser smooth-scroll), comparing rects between frames; once two
    // consecutive frames return identical positions we know the scroll has
    // settled and we can stop. We also keep listening to passive scroll +
    // resize events afterward so the tooltip tracks user-driven scroll.
    let raf = 0;
    let stopAt = performance.now() + 700;
    let lastTop = NaN;
    const settle = () => {
      const r = el.getBoundingClientRect();
      setRect(r);
      const stable = Math.abs(r.top - lastTop) < 0.5;
      lastTop = r.top;
      if (!stable && performance.now() < stopAt) {
        raf = requestAnimationFrame(settle);
      }
    };
    raf = requestAnimationFrame(settle);

    // Re-measure on user-driven viewport changes after the scroll settles.
    const onChange = () => setRect(el.getBoundingClientRect());
    window.addEventListener("resize", onChange);
    window.addEventListener("scroll", onChange, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onChange);
      window.removeEventListener("scroll", onChange, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, stepIdx]);

  // ----- Finalize -----
  function finishTour(rememberDismissal: boolean) {
    document.querySelectorAll("." + PULSE_CLASS).forEach((n) => n.classList.remove(PULSE_CLASS));
    setActive(false);
    if (rememberDismissal) {
      try { window.localStorage.setItem(storageKey, "1"); } catch { /* ignore */ }
    }
  }

  function next() {
    const idx = stepIdx + 1;
    if (idx >= steps.length) finishTour(true);
    else setStepIdx(idx);
  }
  function skip() { finishTour(true); }

  if (!active) return null;
  const step = steps[stepIdx];

  // Position the tooltip relative to the target. Falls back to centered
  // if we don't have a rect yet (first frame after step change).
  // On narrow viewports (e.g. mobile, ~380px) we shrink the tooltip width
  // so it never overflows; on desktop it stays at 320px for readability.
  const tooltipStyle: React.CSSProperties = (() => {
    if (!rect) return { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
    const padding = 12;
    const tipWidth = Math.min(320, window.innerWidth - 16);
    const tipHeight = 130; // rough estimate, tooltip auto-grows; only used for above/left
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    switch (step.placement) {
      case "top":
        return { left: clamp(cx - tipWidth / 2, 8, window.innerWidth - tipWidth - 8), top: Math.max(8, rect.top - tipHeight - padding), width: tipWidth };
      case "bottom":
        return { left: clamp(cx - tipWidth / 2, 8, window.innerWidth - tipWidth - 8), top: rect.bottom + padding, width: tipWidth };
      case "left":
        return { left: Math.max(8, rect.left - tipWidth - padding), top: clamp(cy - tipHeight / 2, 8, window.innerHeight - tipHeight - 8), width: tipWidth };
      case "right":
      default:
        return { left: rect.right + padding, top: clamp(cy - tipHeight / 2, 8, window.innerHeight - tipHeight - 8), width: tipWidth };
    }
  })();

  return (
    <>
      {/* Inject the pulse keyframes once. Scoped via the unique class.
          The !important on opacity is deliberate: the proof badge (and a
          handful of other "subtle" UI affordances) are styled with
          opacity-0 until hover/focus, which would make them invisible
          inside the highlighted ring. We force opacity:1 only while the
          tour is targeting them, then clean the class up between steps.
          Phase 10: the ring uses --app-accent (falling back to the old
          hardcoded indigo) so AppTour matches the tenant's own brand
          colour on the neutral chrome — ReportViewerShell's tour, which
          renders outside any --app-accent scope, keeps the indigo
          fallback exactly as before. */}
      <style jsx global>{`
        @keyframes curf-tour-pulse-anim {
          0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--app-accent, #6366f1) 55%, transparent); }
          70%  { box-shadow: 0 0 0 14px transparent; }
          100% { box-shadow: 0 0 0 0 transparent; }
        }
        .${PULSE_CLASS} {
          position: relative;
          border-radius: 8px;
          animation: curf-tour-pulse-anim 1.6s cubic-bezier(0.4, 0, 0.6, 1) infinite;
          outline: 2px solid color-mix(in srgb, var(--app-accent, #6366f1) 45%, transparent);
          outline-offset: 3px;
          opacity: 1 !important;
        }
      `}</style>

      {/* Tooltip pinned to the target. */}
      <div
        role="dialog"
        aria-live="polite"
        className="fixed z-50 rounded-xl border border-border bg-card p-4 shadow-2xl"
        style={tooltipStyle}
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
            <Sparkles className="h-3 w-3" />
            <span>{t("tour.progress").replace("{n}", String(stepIdx + 1)).replace("{m}", String(steps.length))}</span>
          </div>
          <button
            type="button"
            onClick={skip}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={t("tour.skip")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <h3 className="text-sm font-semibold text-foreground">{step.title}</h3>
        <p className="mt-1 text-[12px] leading-snug text-muted-foreground">{step.body}</p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={skip}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            {t("tour.skip")}
          </button>
          <button
            type="button"
            onClick={next}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground hover:opacity-90"
          >
            {stepIdx + 1 === steps.length ? t("tour.done") : t("tour.next")}
            {stepIdx + 1 < steps.length && <ArrowRight className="h-3 w-3" />}
          </button>
        </div>
      </div>
    </>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
