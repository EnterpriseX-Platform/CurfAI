"use client";
/**
 * SuggestChartButton — opens a modal that calls /api/reports/[id]/suggest
 * and lets the author preview + insert AI-generated chart suggestions.
 *
 * The actual model call lives server-side (so the Anthropic key never
 * ships to the client). This component only renders the result list and
 * inserts the chosen suggestion into the designer's report state via the
 * existing addBlock store action.
 */
import { useState } from "react";
import { Sparkles, Loader2, Plus, BarChart3, Activity, PieChart } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription,
  DialogIcon, DialogBody, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import { useDesignerStore } from "@/lib/reporting/store";
import { useToast } from "@/lib/toast";

type Suggestion = {
  title: string;
  rationale: string;
  queryId: string;
  chartType: "bar" | "line" | "area" | "pie" | "donut" | "combo" | "treemap" | "funnel" | "scatter";
  xField: string;
  yFields: string[];
};

export function SuggestChartButton({ reportId }: { reportId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useDesignerStore((s) => s.report);
  const addBlock: any = useDesignerStore((s) => (s as any).addBlockAt ?? (s as any).addBlock);
  const { push } = useToast();

  async function fetchSuggestions() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/reports/${reportId}/suggest`, { method: "POST", credentials: "include" });
      if (r.status === 402) {
        const j = await r.json().catch(() => ({}));
        setError(j?.error ?? "AI chart suggestions require the Team plan.");
        setSuggestions([]);
        return;
      }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j?.error ?? `Server returned ${r.status}`);
        setSuggestions([]);
        return;
      }
      const j = await r.json();
      setSuggestions(j.suggestions ?? []);
    } catch (e: any) {
      setError(e?.message ?? "Network error");
      setSuggestions([]);
    } finally { setLoading(false); }
  }

  function applySuggestion(s: Suggestion) {
    // Find the bottom-most y in the current page and insert below.
    const page = report.pages[0];
    const maxY = page.blocks.reduce((m, b) => Math.max(m, b.y + b.h), 0);
    const newBlock: any = {
      id: crypto.randomUUID(),
      type: "chart",
      x: 0, y: maxY, w: 12, h: 6,
      config: {
        queryId: s.queryId,
        chartType: s.chartType,
        title: s.title,
        subtitle: s.rationale,
        xField: s.xField,
        yFields: s.yFields,
        valueFormat: "compact",
        showLegend: true,
      },
    };
    // Use the store's add action — the shape may be addBlock(type, position?)
    // or addBlockAt(block, page). We support both via the polymorphic ref.
    const store: any = useDesignerStore.getState();
    if (typeof store.appendBlock === "function") {
      store.appendBlock(newBlock);
    } else if (typeof store.addBlock === "function" && store.addBlock.length === 0) {
      // Some stores expose addBlock that takes the whole block.
      store.addBlock(newBlock);
    } else {
      // Fallback: directly mutate via setReport.
      const next = { ...report, pages: report.pages.map((p, i) => i === 0 ? { ...p, blocks: [...p.blocks, newBlock] } : p) };
      (store.setReport ?? store.replaceReport ?? store.loadReport)?.(next);
    }
    push({ variant: "success", title: "Chart added", description: s.title });
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) fetchSuggestions(); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title="AI chart suggestions">
          <Sparkles className="mr-1.5 h-4 w-4" /> Suggest
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogIcon variant="primary"><Sparkles className="h-4 w-4" /></DialogIcon>
          <div>
            <DialogTitle>AI chart suggestions</DialogTitle>
            <DialogDescription>
              Curf looked at your data and existing charts, and proposed
              these additions. Click <span className="font-medium">Add</span>{" "}
              to insert one at the bottom of the page.
            </DialogDescription>
          </div>
        </DialogHeader>

        <DialogBody>
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
          {suggestions && suggestions.length === 0 && !loading && !error && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No new chart suggestions right now. Try adding more data or
              removing existing charts to give Curf more room.
            </p>
          )}
          {suggestions && suggestions.length > 0 && (
            <div className="space-y-2">
              {suggestions.map((s, i) => (
                <SuggestionCard key={i} s={s} onApply={() => applySuggestion(s)} />
              ))}
            </div>
          )}
        </DialogBody>

        <DialogFooter className="justify-between">
          <Button
            size="sm"
            variant="ghost"
            onClick={fetchSuggestions}
            disabled={loading}
            title="Generate fresh suggestions — useful after adding/removing data sources"
          >
            <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Regenerate
          </Button>
          <DialogClose asChild>
            <Button size="sm" variant="ghost">Done</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SuggestionCard({ s, onApply }: { s: Suggestion; onApply: () => void }) {
  const Icon =
    s.chartType === "line" || s.chartType === "area" ? Activity :
    s.chartType === "pie" || s.chartType === "donut" || s.chartType === "funnel" ? PieChart :
    BarChart3;
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-background p-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{s.title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{s.rationale}</p>
        <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">
          {s.chartType} · {s.queryId} · x={s.xField} · y=[{s.yFields.join(", ")}]
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={onApply} className="shrink-0">
        <Plus className="mr-1.5 h-3.5 w-3.5" /> Add
      </Button>
    </div>
  );
}
