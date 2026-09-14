"use client";
/**
 * WhyDrawer + useWhy hook + WhyContext provider.
 *
 * The "Why?" everywhere UX. A single drawer at the layout level subscribes
 * to a context; any block can open the drawer by calling `openWhy({...})`.
 * Mirrors the existing DrillThrough context pattern so the wiring story
 * stays consistent across blocks.
 *
 * Why a single shared drawer (vs per-block drawers): the Why action is
 * mutually exclusive — viewing one explanation at a time is the right UX,
 * and a single drawer keeps focus management trivial.
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Sparkles, X, Loader2 } from "lucide-react";
import { useTheme } from "@/components/providers/ThemeProvider";

export type WhyRequest = {
  reportId: string;
  blockId: string;
  anchor: { field: string; value: string };
  metric: string;
  /** Optional pretty label for the value being explained. */
  label?: string;
};

type WhyContextValue = {
  open: (req: WhyRequest) => void;
};

const WhyCtx = createContext<WhyContextValue | null>(null);

export function useWhy(): WhyContextValue["open"] | null {
  const ctx = useContext(WhyCtx);
  return ctx?.open ?? null;
}

/**
 * WhyProvider — wraps the report tree and manages the drawer state.
 * Place once near ReportDocument. Every block that wants to fire "Why?"
 * calls useWhy() and the drawer takes over.
 */
export function WhyProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<WhyRequest | null>(null);
  const open = useCallback((req: WhyRequest) => setActive(req), []);
  return (
    <WhyCtx.Provider value={{ open }}>
      {children}
      <WhyDrawer request={active} onClose={() => setActive(null)} />
    </WhyCtx.Provider>
  );
}

function WhyDrawer({ request, onClose }: { request: WhyRequest | null; onClose: () => void }) {
  const open = !!request;
  return (
    <DrawerImpl open={open} onClose={onClose} request={request} />
  );
}

/**
 * Implementation panel. Pulled out so the loading/error/data states stay
 * close together and the outer Provider stays readable.
 */
function DrawerImpl({ open, onClose, request }: { open: boolean; onClose: () => void; request: WhyRequest | null }) {
  const theme = useTheme();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<WhyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // SSR-safe portal mount — see CommentDrawer for the same pattern.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Re-fetch when the request changes. Cancel any in-flight call on unmount.
  // Each request-property is destructured into its own local so the deps
  // array doesn't carry member-access expressions and the linter can see
  // them — and so we don't have to depend on the request object itself,
  // which would re-fire the fetch on any new object identity even when
  // the meaningful inputs are unchanged.
  const reqReportId = request?.reportId;
  const reqBlockId = request?.blockId;
  const reqAnchorField = request?.anchor.field;
  const reqAnchorValue = request?.anchor.value;
  const reqMetric = request?.metric;
  useEffect(() => {
    if (!reqReportId || !reqBlockId || !reqAnchorField || !reqAnchorValue || !reqMetric) {
      setData(null); setError(null); return;
    }
    let aborted = false;
    setLoading(true); setError(null); setData(null);
    fetch(`/api/reports/${reqReportId}/why`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        blockId: reqBlockId,
        anchor: { field: reqAnchorField, value: reqAnchorValue },
        metric: reqMetric,
      }),
    })
      .then(async (r) => {
        if (aborted) return;
        if (r.status === 402) throw new Error("Why? requires the Growth plan.");
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `Server returned ${r.status}`);
        const j = await r.json();
        setData(j);
      })
      .catch((e: any) => { if (!aborted) setError(e?.message ?? "Network error"); })
      .finally(() => { if (!aborted) setLoading(false); });
    return () => { aborted = true; };
  }, [reqReportId, reqBlockId, reqAnchorField, reqAnchorValue, reqMetric]);

  if (!open || !request || !mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} aria-hidden />
      {/* Panel */}
      <div className="relative flex h-full w-full max-w-md flex-col overflow-hidden bg-background shadow-2xl">
        <header className="flex items-start justify-between gap-2 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
              <Sparkles className="h-3 w-3" /> Why?
            </p>
            <h2 className="mt-1 truncate text-base font-semibold">
              {request.anchor.field} = <span style={{ color: theme.semantic.info }}>{request.anchor.value}</span>
            </h2>
            {request.label && <p className="mt-0.5 text-xs text-muted-foreground">{request.label}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
            </div>
          )}
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {data && <WhyContent data={data} metric={request.metric} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

type WhyResponse = {
  analysis: {
    anchor: { field: string; value: string };
    metric: string;
    total: number;
    grandTotal: number;
    shareOfWhole: number | null;
    breakdowns: Array<{ dimension: string; segment: string; value: number; sharePct: number }>;
    dimensionsAnalyzed: string[];
  };
  narrative: string | null;
  /**
   * Why the narrative is missing, when it is. Present so the drawer can say
   * what actually went wrong instead of guessing — see the route.
   */
  llmError?: { message: string; notConfigured: boolean; canSwitchModel: boolean } | null;
};

function WhyContent({ data, metric }: { data: WhyResponse; metric: string }) {
  const { analysis, narrative, llmError } = data;
  // Group breakdowns by dimension so the panel stays scannable.
  const byDim = new Map<string, typeof analysis.breakdowns>();
  for (const b of analysis.breakdowns) {
    const arr = byDim.get(b.dimension) ?? [];
    arr.push(b);
    byDim.set(b.dimension, arr);
  }

  return (
    <>
      {/* Headline value + share */}
      <section className="rounded-lg border border-border bg-muted/40 px-4 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{metric}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{compact(analysis.total)}</p>
        {analysis.shareOfWhole != null && (
          <p className="mt-1 text-xs text-muted-foreground">
            {(analysis.shareOfWhole * 100).toFixed(1)}% of overall ({compact(analysis.grandTotal)})
          </p>
        )}
      </section>

      {/* Narrative — AI-generated, falls back gracefully when unavailable */}
      {narrative ? (
        <section className="rounded-lg border border-primary/30 bg-primary-soft px-4 py-3 text-sm leading-relaxed text-primary-ink   ">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
            <Sparkles className="h-3 w-3" /> AI explanation
          </div>
          <p>{narrative}</p>
        </section>
      ) : (
        <p className="text-xs italic text-muted-foreground">
          {/* This used to hardcode "set up an LLM provider", which told a
              workspace with a working key that its key was missing whenever
              the real cause was something else — a model that spent its whole
              budget thinking, a rate limit, an expired key. The route now
              returns the same humanized diagnosis Ask Curf shows. */}
          {llmError?.message
            ?? "AI narrative unavailable — see breakdowns below."}
        </p>
      )}

      {/* Breakdowns — what's the value composed of? */}
      <section>
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Breakdowns
        </h3>
        {byDim.size === 0 ? (
          <p className="text-xs text-muted-foreground">No additional dimensions to break down on.</p>
        ) : (
          <div className="space-y-3">
            {Array.from(byDim.entries()).map(([dim, items]) => (
              <div key={dim} className="rounded-md border border-border bg-background">
                <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{dim}</span>
                  <span className="text-[10px] text-muted-foreground/80">{items.length} segments</span>
                </div>
                <div className="divide-y divide-border">
                  {items.slice(0, 5).map((b, i) => (
                    <div key={i} className="relative px-3 py-2">
                      {/* Bar background = sharePct */}
                      <div
                        aria-hidden
                        className="absolute inset-y-1 left-0 rounded-r bg-primary/10"
                        style={{ width: `${Math.min(100, Math.max(2, b.sharePct * 100)).toFixed(1)}%` }}
                      />
                      <div className="relative flex items-baseline justify-between gap-2 text-xs">
                        <span className="truncate font-medium">{b.segment}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {compact(b.value)} <span className="text-muted-foreground/70">· {(b.sharePct * 100).toFixed(0)}%</span>
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="text-[10px] text-muted-foreground/70">
        Computed from {analysis.dimensionsAnalyzed.length} dimensions: {analysis.dimensionsAnalyzed.join(", ") || "—"}
      </p>
    </>
  );
}

function compact(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return v.toLocaleString();
}

