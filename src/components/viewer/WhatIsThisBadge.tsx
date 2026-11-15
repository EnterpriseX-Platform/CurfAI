"use client";
import { useEffect, useState } from "react";
import { ShieldCheck, MousePointerClick, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { TOUR_DONE_EVENT, TOUR_STORAGE_KEY } from "./OnboardingTour";

/**
 * Floating bottom-right "What is this?" badge for the report viewer.
 *
 * Designed for self-serve prospects who land on a demo URL with no
 * walkthrough. It teaches the four core interactions in one sit-down:
 *   1. Trust  -- hover any number for proof
 *   2. Drill  -- click a chart bar / country / table cell
 *   3. Filter -- narrow everything in lockstep at the top
 *   4. AI     -- type a prompt, get a working dashboard
 *
 * Once the user clicks "Got it" we set a localStorage flag so the badge
 * never reappears in this browser. SSR-safe: localStorage is only touched
 * after mount, and we render an empty placeholder during the first paint
 * so hydration doesn't trip on a client/server mismatch.
 */
const STORAGE_KEY = "curf-explainer-dismissed-v1";

const TIPS = [
  {
    icon: ShieldCheck,
    key: "proof",
  },
  {
    icon: MousePointerClick,
    key: "drill",
  },
  {
    icon: SlidersHorizontal,
    key: "filter",
  },
  {
    icon: Sparkles,
    key: "generate",
  },
] as const;


export function WhatIsThisBadge() {
  const { t } = useT();
  // Three-state local model:
  //   "loading"   - first paint, before we've checked localStorage
  //   "dismissed" - user clicked "Got it" previously, never show again
  //   "available" - show the floating pill (and overlay if `open` is true)
  const [state, setState] = useState<"loading" | "dismissed" | "available">("loading");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let dismissed = false;
    let tourPending = false;
    try {
      dismissed = window.localStorage.getItem(STORAGE_KEY) === "1";
      // The viewer's tour invite sits in the same corner; wait until the
      // visitor has taken or dismissed it, so one helper floats at a time.
      tourPending = window.localStorage.getItem(TOUR_STORAGE_KEY) !== "1";
    } catch {
      // Browser blocking storage (Safari private mode, etc.) — show the pill anyway.
    }
    if (dismissed) { setState("dismissed"); return; }
    if (!tourPending) { setState("available"); return; }
    const onTourDone = () => setState("available");
    window.addEventListener(TOUR_DONE_EVENT, onTourDone);
    return () => window.removeEventListener(TOUR_DONE_EVENT, onTourDone);
  }, []);

  function dismissForever() {
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // ignore
    }
    setOpen(false);
    setState("dismissed");
  }

  if (state !== "available") return null;

  return (
    <>
      {/* Floating pill — always visible (when not dismissed). */}
      <button
        type="button"
        data-explainer-pill
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))] right-4 z-40 flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-2 text-xs font-medium text-primary-foreground shadow-md transition-colors hover:bg-primary-ink md:bottom-4"
        aria-expanded={open}
        aria-controls="curf-explainer-panel"
        title={t("explainer.pillTitle")}
      >
        <Sparkles className="h-3.5 w-3.5" />
        <span>{t("explainer.pill")}</span>
      </button>

      {/* Expanded explainer panel. */}
      {open && (
        <>
          {/* Soft backdrop — clicking outside closes the panel without dismissing forever. */}
          <button
            type="button"
            aria-label={t("explainer.close")}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default bg-black/10 backdrop-blur-[1px]"
          />
          <div
            id="curf-explainer-panel"
            role="dialog"
            aria-labelledby="curf-explainer-title"
            className="fixed bottom-36 right-4 z-50 md:bottom-20 w-[min(420px,calc(100vw-2rem))] rounded-xl border border-border bg-card p-4 shadow-2xl"
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-primary">
                  <Sparkles className="h-3 w-3" />
                  <span>{t("explainer.welcome")}</span>
                </div>
                <h3 id="curf-explainer-title" className="mt-0.5 text-sm font-semibold text-foreground">
                  {t("explainer.heading")}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label={t("explainer.close")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <ol className="space-y-2.5">
              {TIPS.map((tip, i) => {
                const Icon = tip.icon;
                return (
                  <li key={tip.key} className="flex items-start gap-2.5">
                    <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground`}>
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-foreground">
                        <span className="text-muted-foreground/70">{i + 1}.</span> {t(`explainer.${tip.key}.title`)}
                      </div>
                      <div className="mt-0.5 text-2xs leading-snug text-muted-foreground">
                        {t(`explainer.${tip.key}.body`)}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>

            <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
              <span className="text-2xs text-muted-foreground/80">
                {t("explainer.findAgain")}
              </span>
              <button
                type="button"
                onClick={dismissForever}
                className="rounded-md bg-foreground px-3 py-1.5 text-2xs font-medium text-background transition-opacity hover:opacity-90"
              >
                {t("explainer.hide")}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
