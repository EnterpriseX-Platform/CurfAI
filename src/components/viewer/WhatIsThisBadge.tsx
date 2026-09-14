"use client";
import { useEffect, useState } from "react";
import { ShieldCheck, MousePointerClick, SlidersHorizontal, Sparkles, X } from "lucide-react";

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
    title: "Every number, provable",
    body: "Hover any KPI, chart, or table to see the SHA-256 fingerprint of the underlying query and result. Time-travel snapshots let you replay any past run byte-for-byte.",
  },
  {
    icon: MousePointerClick,
    title: "Click anything to drill",
    body: "Charts and maps with a CLICK TO DRILL chip open a slide-out panel showing the underlying rows behind the aggregate. CSV export included.",
  },
  {
    icon: SlidersHorizontal,
    title: "Filter narrows everything",
    body: "Use the date range, channel, and search filters at the top. Every block re-flows in lockstep — and the URL updates so you can share the filtered view.",
  },
  {
    icon: Sparkles,
    title: "Generate from a prompt",
    body: "New report? Click the Generate button on the catalog page. Describe what you want in plain English, click a starter card to skip typing, and get a working dashboard in ~25 seconds.",
  },
] as const;


export function WhatIsThisBadge() {
  // Three-state local model:
  //   "loading"   - first paint, before we've checked localStorage
  //   "dismissed" - user clicked "Got it" previously, never show again
  //   "available" - show the floating pill (and overlay if `open` is true)
  const [state, setState] = useState<"loading" | "dismissed" | "available">("loading");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      const dismissed = window.localStorage.getItem(STORAGE_KEY) === "1";
      setState(dismissed ? "dismissed" : "available");
    } catch {
      // Browser blocking storage (Safari private mode, etc.) — show the pill anyway.
      setState("available");
    }
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
        className="fixed bottom-4 right-4 z-40 flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary px-3.5 py-2 text-xs font-medium text-primary-foreground shadow-lg transition-all hover:scale-[1.02] hover:shadow-xl"
        aria-expanded={open}
        aria-controls="curf-explainer-panel"
        title="What can I do here?"
      >
        <Sparkles className="h-3.5 w-3.5" />
        <span>What is this?</span>
      </button>

      {/* Expanded explainer panel. */}
      {open && (
        <>
          {/* Soft backdrop — clicking outside closes the panel without dismissing forever. */}
          <button
            type="button"
            aria-label="Close explainer"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default bg-black/10 backdrop-blur-[1px]"
          />
          <div
            id="curf-explainer-panel"
            role="dialog"
            aria-labelledby="curf-explainer-title"
            className="fixed bottom-20 right-4 z-50 w-[min(420px,calc(100vw-2rem))] rounded-xl border border-border bg-card p-4 shadow-2xl"
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                  <Sparkles className="h-3 w-3" />
                  <span>Welcome to Curf</span>
                </div>
                <h3 id="curf-explainer-title" className="mt-0.5 text-sm font-semibold text-foreground">
                  Four things to try on this page
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <ol className="space-y-2.5">
              {TIPS.map((tip, i) => {
                const Icon = tip.icon;
                return (
                  <li key={tip.title} className="flex items-start gap-2.5">
                    <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground`}>
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-[12px] font-medium text-foreground">
                        <span className="text-muted-foreground/70">{i + 1}.</span> {tip.title}
                      </div>
                      <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                        {tip.body}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>

            <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
              <span className="text-[10px] text-muted-foreground/80">
                You can find this any time in the bottom-right.
              </span>
              <button
                type="button"
                onClick={dismissForever}
                className="rounded-md bg-foreground px-3 py-1.5 text-[11px] font-medium text-background transition-opacity hover:opacity-90"
              >
                Got it, hide
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
