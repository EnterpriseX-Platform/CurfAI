"use client";

/**
 * Talks-back button.
 *
 * Sits alongside the proof shield and show-your-work icons. Opens a chat
 * panel grounded in this block's data. Questions are answered by POSTing
 * to /api/reports/:id/ask with { blockId, question }. "Continue in Ask"
 * carries the report and the last question into the one Ask chat
 * (/ask?report=…), where the answer can take in the whole report and more.
 */
import * as React from "react";
import * as Popover from "@radix-ui/react-popover";
import Link from "next/link";
import { Sparkles, Send, Loader2, ArrowUpRight } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { AiNotice } from "@/components/common/AiNotice";

type Message = { role: "user" | "assistant"; text: string; citations?: Array<{ label: string; value: string }> };

export function AskButton({
  reportId,
  blockId,
  blockType,
  params,
  suggestions = [],
}: {
  reportId: string;
  blockId: string;
  blockType: "kpi" | "table" | "chart";
  params?: Record<string, unknown>;
  suggestions?: string[];
}) {
  const { t, locale } = useT();
  const [open, setOpen] = React.useState(false);
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || loading) return;
    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch(`/api/reports/${reportId}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The reader's language, so the answer matches the interface (Issue 02).
        body: JSON.stringify({ blockId, question: q, params: params ?? {}, locale }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.status);
      setMessages((m) => [...m, { role: "assistant", text: json.answer.text, citations: json.answer.citations }]);
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", text: t("askBlock.failed").replace("{error}", String(e?.message ?? e)) }]);
    } finally {
      setLoading(false);
    }
  }

  const defaultSuggestions = suggestions.length > 0 ? suggestions : defaultPromptsFor(blockType).map((k) => t(k));
  const lastQuestion = [...messages].reverse().find((m) => m.role === "user")?.text;
  const continueHref = `/ask?report=${encodeURIComponent(reportId)}${lastQuestion ? `&q=${encodeURIComponent(lastQuestion)}` : ""}`;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={t("askBlock.open")}
          title={t("askBlock.openHint")}
          className="no-print inline-flex h-5 w-5 items-center justify-center rounded-md text-primary/80 opacity-0 transition-all hover:bg-primary/10 hover:text-primary hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Sparkles className="h-3.5 w-3.5" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 flex w-[28rem] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-border p-0 text-foreground shadow-xl outline-none"
          style={{ backgroundColor: "hsl(var(--popover, 0 0% 100%))" }}
        >
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <div className="flex-1 text-sm font-medium">{t("askBlock.title")}</div>
            <div className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary-ink">
              {t("askBlock.grounded")}
            </div>
          </div>

          <div ref={scrollRef} className="max-h-[50vh] min-h-[14rem] flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {messages.length === 0 && !loading && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {t("askBlock.intro")}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {defaultSuggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => ask(s)}
                      className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-foreground/80 hover:bg-muted hover:text-foreground"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={m.role === "user"
                  ? "ml-6 rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary-ink"
                  : "mr-6 rounded-lg bg-muted px-3 py-2 text-sm text-foreground"}
              >
                <p className="whitespace-pre-wrap">{m.text}</p>
                {m.citations && m.citations.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {m.citations.map((c, j) => (
                      <span key={j} className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        <span className="font-medium text-foreground/80">{c.label}</span>: {c.value}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {loading && (
              <div className="mr-6 inline-flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> {t("askBlock.thinking")}
              </div>
            )}
          </div>

          <form
            className="flex items-center gap-2 border-t border-border px-3 py-2"
            onSubmit={(e) => { e.preventDefault(); ask(input); }}
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t("askBlock.placeholder")}
              aria-label={t("askBlock.placeholder")}
              className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            />
            <button
              type="submit"
              disabled={!input.trim() || loading}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary text-white transition-colors hover:bg-primary disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={t("askBlock.send")}
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </form>

          <div className="flex items-start gap-3 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
            <div className="min-w-0 flex-1">
              {t("askBlock.footer")}
              <AiNotice short className="mt-0.5 text-[10px]" />
            </div>
            <Link href={continueHref} className="inline-flex shrink-0 items-center gap-1 pt-0.5 text-[11px] font-medium text-primary-ink hover:underline">
              {t("askBlock.continue")} <ArrowUpRight className="h-3 w-3" />
            </Link>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Starter questions per block kind, as dictionary keys. */
function defaultPromptsFor(kind: "kpi" | "table" | "chart"): string[] {
  if (kind === "kpi") return ["askBlock.seed.kpiSummary", "askBlock.seed.kpiGood"];
  if (kind === "chart") return ["askBlock.seed.chartTrend", "askBlock.seed.chartWhy", "askBlock.seed.chartHigh"];
  return ["askBlock.seed.tableTop", "askBlock.seed.tableTotal", "askBlock.seed.tableAverage"];
}
