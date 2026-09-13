"use client";

/**
 * Talks-back button.
 *
 * Sits alongside the proof shield and show-your-work icons. Opens a chat
 * panel grounded in this block's data. Questions are answered by POSTing
 * to /api/reports/:id/ask with { blockId, question }.
 */
import * as React from "react";
import * as Popover from "@radix-ui/react-popover";
import { Sparkles, Send, Loader2 } from "lucide-react";

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
        body: JSON.stringify({ blockId, question: q, params: params ?? {} }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      setMessages((m) => [...m, { role: "assistant", text: json.answer.text, citations: json.answer.citations }]);
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", text: `Something went wrong: ${e.message ?? e}` }]);
    } finally {
      setLoading(false);
    }
  }

  const defaultSuggestions = suggestions.length > 0 ? suggestions : defaultPromptsFor(blockType);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Ask about this block"
          title="Ask — grounded Q&A on this block"
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
            <div className="flex-1 text-sm font-medium">Ask this block</div>
            <div className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary-ink">
              Grounded
            </div>
          </div>

          <div ref={scrollRef} className="max-h-[50vh] min-h-[14rem] flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {messages.length === 0 && !loading && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Answers are grounded in this block&apos;s rows. Try one of these, or type your own.
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
                <Loader2 className="h-3 w-3 animate-spin" /> Thinking…
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
              placeholder="Ask about this block…"
              className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            />
            <button
              type="submit"
              disabled={!input.trim() || loading}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary text-white transition-colors hover:bg-primary disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Send"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </form>

          <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
            Answers come from the rows behind this block only — no external data.
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function defaultPromptsFor(t: "kpi" | "table" | "chart"): string[] {
  if (t === "kpi") return ["Summarize this number", "Is this good?"];
  if (t === "chart") return ["What's the trend?", "Why did it move?", "What's the highest point?"];
  return ["Top 3 rows", "Total", "Average"];
}
