"use client";
/**
 * StoryViewer — interactive deck experience.
 *
 * Each block in the report becomes one slide. We flatten pages → blocks
 * (skipping non-data blocks like dividers and pageBreaks) so the deck has
 * a clean linear order. Each slide gets:
 *
 *   - the block, rendered at large scale (one block per viewport)
 *   - the report title in the corner for context
 *   - a progress bar across the top, divided into N equal segments
 *   - auto-advance via setTimeout (default 6s); paused on hover or pause
 *   - keyboard nav: ← → space / esc to exit
 *
 * The render path is the SAME `BlockRegistry[].Component` the viewer uses.
 * That guarantees Story Mode never drifts visually from the canonical
 * report — themes, conditional formatting, gauges, annotations, forecast
 * bands all carry over because the underlying renderer is shared.
 *
 * We deliberately drop pageBreak / divider blocks from the flattened
 * sequence — they're paginate-affordances, not story beats.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Pause, Play, X, Sparkles } from "lucide-react";
import type { Report, Block } from "@/lib/reporting/schema";
import { BlockRegistry } from "@/components/blocks";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { CurrencyProvider } from "@/components/providers/CurrencyProvider";
import { WhyProvider } from "@/components/blocks/WhyDrawer";
import { useT } from "@/lib/i18n/LocaleContext";

const SLIDE_MS = 6000; // each slide visible for 6s by default
const SKIP_TYPES = new Set(["divider", "pageBreak"]);

type Props = {
  report: Report;
  reportDbId: string;
  dataset: Record<string, any[]>;
  provenance: Record<string, any>;
  params: Record<string, unknown>;
  /** Tenant's default currency — falls back to "USD" via CurrencyProvider when unset. */
  tenantCurrency?: string | null;
};

export function StoryViewer({ report, reportDbId, dataset, provenance, params, tenantCurrency }: Props) {
  const router = useRouter();
  const { t } = useT();

  // Flatten pages → block sequence, dropping cosmetic block types.
  const slides = useMemo(() => {
    const out: Array<Block & { __pageIdx: number }> = [];
    report.pages.forEach((p, pi) => {
      for (const b of p.blocks) {
        if (SKIP_TYPES.has(b.type)) continue;
        out.push({ ...(b as Block), __pageIdx: pi });
      }
    });
    return out;
  }, [report]);

  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1 within current slide
  const lastTickRef = useRef<number>(performance.now());
  const rafRef = useRef<number | null>(null);

  const goNext = useCallback(() => {
    setIdx((i) => Math.min(slides.length - 1, i + 1));
    setProgress(0);
    lastTickRef.current = performance.now();
  }, [slides.length]);

  const goPrev = useCallback(() => {
    setIdx((i) => Math.max(0, i - 1));
    setProgress(0);
    lastTickRef.current = performance.now();
  }, []);

  // Auto-advance via rAF so the progress bar can animate smoothly without
  // setting React state every frame (we batch state updates to ~10/sec).
  useEffect(() => {
    if (paused || slides.length === 0) return;
    let nextStateUpdate = performance.now() + 100;
    const tick = (now: number) => {
      const elapsed = now - lastTickRef.current;
      const frac = Math.min(1, elapsed / SLIDE_MS);
      if (now >= nextStateUpdate) {
        setProgress(frac);
        nextStateUpdate = now + 100;
      }
      if (frac >= 1) {
        if (idx < slides.length - 1) {
          setIdx((i) => i + 1);
          setProgress(0);
          lastTickRef.current = now;
        } else {
          setPaused(true); // halt at the end rather than loop
          setProgress(1);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [idx, paused, slides.length]);

  // Keyboard nav
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); goNext(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); goPrev(); }
      else if (e.key === "Escape") { router.push(`/reports/${reportDbId}`); }
      else if (e.key === "p" || e.key === "P") { setPaused((v) => !v); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goNext, goPrev, router, reportDbId]);

  if (slides.length === 0) {
    return (
      <div className="grid min-h-screen place-items-center bg-foreground text-faint">
        <div className="text-center">
          <p className="text-lg">{t("storyViewer.emptyTitle")}</p>
          <a href={`/reports/${reportDbId}`} className="mt-4 inline-block text-sm underline">{t("reportHistory.backToReport")}</a>
        </div>
      </div>
    );
  }

  const current = slides[idx];
  const Entry = BlockRegistry[current.type];
  const C = Entry?.Component;

  return (
    <ThemeProvider reportTheme={(report as any).theme} reportChartStyle={(report as any).chartStyle}>
    <CurrencyProvider reportCurrency={(report as any).currency} tenantCurrency={tenantCurrency}>
    <WhyProvider>
      <div
        className="relative min-h-screen bg-foreground text-background"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        {/* Progress segments */}
        <div className="pointer-events-none absolute inset-x-6 top-3 z-20 flex gap-1">
          {slides.map((_, i) => {
            const filled = i < idx ? 1 : i === idx ? progress : 0;
            return (
              <div key={i} className="h-1 flex-1 overflow-hidden rounded-full bg-card/15">
                <div
                  className="h-full rounded-full bg-card"
                  style={{ width: `${filled * 100}%`, transition: i === idx ? "none" : "width 200ms" }}
                />
              </div>
            );
          })}
        </div>

        {/* Header — report name + slide counter + controls */}
        <div className="relative z-10 flex items-center justify-between px-6 pt-7">
          <div className="flex items-center gap-2 text-xs text-white/60">
            <Sparkles className="h-3.5 w-3.5" />
            <span className="font-medium uppercase tracking-wider">{t("storyViewer.storyMode")}</span>
            <span className="text-white/40">·</span>
            <span className="font-medium text-white/80">{report.name}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPaused((v) => !v)}
              title={paused ? t("storyViewer.resume") : t("storyViewer.pause")}
              className="rounded-md p-1.5 text-white/70 hover:bg-card/10 hover:text-white"
            >
              {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            </button>
            <a
              href={`/reports/${reportDbId}`}
              title={t("storyViewer.exit")}
              className="rounded-md p-1.5 text-white/70 hover:bg-card/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </a>
          </div>
        </div>

        {/* Slide stage */}
        <main className="mx-auto flex min-h-[calc(100vh-100px)] max-w-6xl items-center justify-center px-6 py-8">
          <div className="w-full">
            <div className="rounded-2xl bg-card p-6 shadow-2xl shadow-black/30 ring-1 ring-white/10 ">
              {/* Fixed pixel height — Recharts' ResponsiveContainer
                  measures its parent and renders nothing on a min-h
                  container (which has unbounded growth potential). 520px
                  reads well at 1080p+ and gives every block (chart, table,
                  gauge, KPI) the same vertical canvas. */}
              <div className="h-[520px]" data-story-slide>
                {C ? (
                  <C
                    block={current as any}
                    report={report}
                    dataset={dataset as any}
                    provenance={provenance as any}
                    params={params}
                    reportDbId={reportDbId}
                  />
                ) : (
                  <p className="p-8 text-center text-sm text-faint">
                    {t("storyViewer.unknownBlockType").replace("{type}", current.type)}
                  </p>
                )}
              </div>
            </div>
            <p className="mt-3 text-center text-[11px] text-white/40">
              {t("storyViewer.slideCounter").replace("{n}", String(idx + 1)).replace("{total}", String(slides.length))}
            </p>
          </div>
        </main>

        {/* Edge-anchored chevron buttons */}
        <button
          type="button"
          onClick={goPrev}
          disabled={idx === 0}
          title={t("storyViewer.previous")}
          className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full p-3 text-white/40 transition-colors hover:bg-card/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-20"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
        <button
          type="button"
          onClick={goNext}
          disabled={idx === slides.length - 1}
          title={t("storyViewer.next")}
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-3 text-white/40 transition-colors hover:bg-card/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-20"
        >
          <ChevronRight className="h-6 w-6" />
        </button>
      </div>
    </WhyProvider>
    </CurrencyProvider>
    </ThemeProvider>
  );
}
