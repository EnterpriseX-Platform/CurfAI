"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Sparkles, Loader2, Wand2, Database, Layers, ChevronDown,
  TrendingUp, Users, BarChart3, Globe, Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/lib/toast";

/**
 * "Generate from prompt" — natural-language report builder.
 *
 * The modal shows the user what data Curf can see (so they understand the
 * AI isn't guessing), gives them a few rich example starting points, and
 * runs a 3-step progress UI while Claude is working: introspecting →
 * designing queries → laying out blocks.
 */

const EXAMPLES = [
  {
    icon: TrendingUp,
    title: "Marketing performance",
    description: "By channel, with monthly heatmap and top campaigns",
    prompt: "Build a marketing performance dashboard: KPIs for total spend, leads, and average ROI; a combo chart of spend (bars) and leads (line) by channel; a calendar heatmap of daily campaign launches; and a list of top campaigns by ROI.",
  },
  {
    icon: BarChart3,
    title: "Sales pipeline",
    description: "Conversion rates by stage with rep leaderboard",
    prompt: "Sales pipeline dashboard: KPIs for total revenue and active deals; a funnel chart of opportunities by stage; a treemap of revenue by product category; and a leaderboard of top reps this quarter.",
  },
  {
    icon: Users,
    title: "Customer growth",
    description: "Signups over 90 days with cohort heatmap",
    prompt: "Customer growth dashboard: KPIs for total customers, new this month, and churn; a calendar heatmap of daily signups over the last 90 days; an area chart of cumulative customers over time; and a regional breakdown bar chart.",
  },
  {
    icon: Globe,
    title: "Geographic breakdown",
    description: "World choropleth + regional KPIs",
    prompt: "Geographic dashboard: KPIs for revenue by region; a world map (choropleth) of revenue by country; a bar chart of top 10 countries; and a pivot table of revenue by region × product category.",
  },
];

type Inventory = {
  totalConnections: number;
  totalTables: number;
  connections: Array<{
    id: string;
    name: string;
    kind: string;
    tables: string[];
    fields?: Array<{ name: string; type: string }>;
    schemaProbed?: boolean;
  }>;
};

const PROGRESS_STAGES = [
  "Inspecting your data sources…",
  "Designing the queries…",
  "Laying out the blocks…",
  "Validating and saving…",
];

export function GenerateReportButton() {
  const router = useRouter();
  const { push } = useToast();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  // Manual focus on the prompt textarea when the modal opens. Radix Dialog's
  // own focus trap was claiming focus and parking it on a non-interactive
  // ancestor, so the bare `autoFocus` attribute on the textarea was a no-op.
  // We requestAnimationFrame past Radix's mount, then call .focus() ourselves.
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      promptRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [open]);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState(0);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [dataSourceId, setDataSourceId] = useState<string | "">("");

  // Default the picker to the first connection that has actual schema available
  // (SQLite tables, or REST with a probed schema). Falls back to the first
  // connection so the picker is never blank when one exists.
  useEffect(() => {
    if (!inventory || dataSourceId) return;
    const usable = inventory.connections.find(
      (c) => (c.kind === "sqlite" && c.tables.length > 0) || (c.kind === "rest" && c.schemaProbed),
    );
    setDataSourceId((usable ?? inventory.connections[0])?.id ?? "");
  }, [inventory, dataSourceId]);

  // Pull the inventory once when the modal opens. Caches across reopens
  // because state persists until the dialog unmounts.
  useEffect(() => {
    if (!open || inventory) return;
    fetch("/api/reports/generate/inventory")
      .then((r) => r.json())
      .then((j) => setInventory(j))
      .catch(() => { /* swallow — show "?" if inventory probe fails */ });
  }, [open, inventory]);

  // Cycle through progress messages while we wait for Claude. Just a
  // perceived-progress UX trick — doesn't reflect actual server stage.
  useEffect(() => {
    if (!busy) { setStage(0); return; }
    let s = 0;
    setStage(0);
    const t = setInterval(() => {
      s = Math.min(s + 1, PROGRESS_STAGES.length - 1);
      setStage(s);
    }, 3500);
    return () => clearInterval(t);
  }, [busy]);

  async function generate() {
    if (!prompt.trim()) {
      setError("Tell me what you want to see.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/reports/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim(),
          dataSourceId: dataSourceId || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Generation failed");
        if (json.raw) console.warn("[generate] raw response", json.raw);
        return;
      }
      push({
        variant: "success",
        title: "Report generated",
        description: json.name ? "Opening " + json.name : "Opening your new report",
      });
      setOpen(false);
      setPrompt("");
      start(() => router.push("/reports/" + json.id));
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setError(null); } }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="default" className="gap-1.5">
          <Sparkles className="h-4 w-4" /> Generate
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-2xl overflow-hidden p-0">
        {/* Deliberately custom layout (NOT using DialogBody / DialogFooter
            from the new design-system primitive). The Generate flow is the
            AI flagship surface and gets a hero-treatment header + a multi-
            step progress strip + a contextual footer note that the standard
            primitive isn't shaped for. The shared primitives (overlay blur,
            mount animations, close button) still apply via DialogContent. */}
        {/* Hero header — gradient strip with the AI affordance front-and-centre */}
        <div className="relative overflow-hidden border-b border-border bg-gradient-to-br from-primary/10 via-primary/5 to-transparent px-6 py-5">
          <div className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-primary/10 blur-3xl" />
          <div className="absolute right-12 top-4 h-20 w-20 rounded-full bg-primary/5 blur-2xl" />
          <DialogHeader className="relative">
            <div className="mb-2 inline-flex w-fit items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
              <Sparkles className="h-3 w-3" /> AI-powered
            </div>
            <DialogTitle className="text-xl font-semibold tracking-tight">
              Generate a report from a prompt
            </DialogTitle>
            <DialogDescription className="text-sm">
              Describe what you want to see in plain English. Curf inspects your data, designs the
              queries, and lays out the dashboard for you.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="grid gap-4 px-6 py-5">
          {/* Inventory chip — what Claude can actually see */}
          <DataInventoryStrip inventory={inventory} expanded={inventoryOpen} onToggle={() => setInventoryOpen((v) => !v)} />

          {/* Connection picker — only shows when there are 2+ connections */}
          {inventory && inventory.connections.length > 1 && (
            <div className="grid gap-1.5">
              <label htmlFor="generate-source" className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Source
              </label>
              <select
                id="generate-source"
                value={dataSourceId}
                onChange={(e) => setDataSourceId(e.target.value)}
                disabled={busy}
                className="h-9 rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                {inventory.connections.map((c) => {
                  // Excel imports are stored as SQLite under the hood, so they
                  // surface a `tables` array just like a native sqlite source.
                  const fileBacked = c.kind === "sqlite" || c.kind === "excel";
                  const usable = (fileBacked && c.tables.length > 0) ||
                                 (c.kind === "rest" && c.schemaProbed);
                  const detail = fileBacked
                    ? `${c.tables.length} table${c.tables.length === 1 ? "" : "s"}`
                    : c.schemaProbed ? `${c.fields?.length ?? 0} fields` : "no schema yet";
                  return (
                    <option key={c.id} value={c.id} disabled={!usable}>
                      {c.name} [{c.kind}] — {detail}{usable ? "" : " (probe first)"}
                    </option>
                  );
                })}
              </select>
            </div>
          )}

          {/* Prompt textarea */}
          <div className="grid gap-1.5">
            <label htmlFor="generate-prompt" className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              What would you like to see?
            </label>
            <textarea
              id="generate-prompt"
              ref={promptRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g., 'Q1 marketing performance with KPIs, a combo chart by channel, monthly spend heatmap, and a list of top campaigns by ROI'"
              disabled={busy}
              rows={5}
              className="w-full resize-none rounded-md border border-border bg-background px-3 py-2.5 text-sm leading-relaxed placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>

          {/* Example starting points — cards instead of pills */}
          <div className="grid gap-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Or start from a template idea
            </label>
            <div className="grid grid-cols-2 gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.title}
                  type="button"
                  disabled={busy}
                  onClick={() => setPrompt(ex.prompt)}
                  className="group flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-primary/5 disabled:opacity-50"
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary group-hover:bg-primary/15">
                    <ex.icon className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[12px] font-medium text-foreground">{ex.title}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{ex.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Progress + error states */}
          {busy && (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-primary">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {PROGRESS_STAGES[stage]}
              </div>
              <div className="space-y-1">
                {PROGRESS_STAGES.map((s, i) => (
                  <div key={s} className="flex items-center gap-1.5 text-[11px]">
                    <span className={
                      i < stage ? "text-success" :
                      i === stage ? "text-primary" : "text-muted-foreground/50"
                    }>
                      {i < stage ? <Check className="h-3 w-3" /> :
                       i === stage ? <Loader2 className="h-3 w-3 animate-spin" /> :
                       "○"}
                    </span>
                    <span className={i <= stage ? "text-foreground" : "text-muted-foreground/60"}>
                      {s}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        {/* Footer with actions */}
        <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/20 px-6 py-3">
          <p className="text-[11px] text-muted-foreground">
            Curf validates the AI response against the report schema before saving. You can refine in the designer.
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={generate} disabled={busy || pending || !prompt.trim()}>
              {busy ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Generating&hellip;</>
                    : <><Sparkles className="mr-1.5 h-4 w-4" /> Generate report</>}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Data inventory strip — collapsible "Curf can see N tables across M connections"
// ---------------------------------------------------------------------------

function DataInventoryStrip({
  inventory, expanded, onToggle,
}: {
  inventory: Inventory | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!inventory) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <Database className="h-3.5 w-3.5" />
        Discovering your data sources…
      </div>
    );
  }
  if (inventory.totalTables === 0 && inventory.totalConnections === 0) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
        <Database className="h-3.5 w-3.5" />
        No connected data sources yet. Add one under Data → Connections, then come back.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-success/30 bg-success/5">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <div className="flex items-center gap-2 text-xs">
          <Database className="h-3.5 w-3.5 text-success" />
          <span className="font-medium text-success">
            Curf can see {inventory.totalTables} table{inventory.totalTables === 1 ? "" : "s"} across{" "}
            {inventory.totalConnections} connection{inventory.totalConnections === 1 ? "" : "s"}
          </span>
        </div>
        <ChevronDown className={"h-3.5 w-3.5 text-success transition-transform " + (expanded ? "rotate-180" : "")} />
      </button>
      {expanded && (
        <div className="border-t border-success/20 px-3 py-2.5">
          {inventory.connections.map((c) => (
            <ConnectionEntry key={c.id} c={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectionEntry({
  c,
}: {
  c: Inventory["connections"][number];
}) {
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [localFields, setLocalFields] = useState(c.fields ?? []);
  const [localProbed, setLocalProbed] = useState(c.schemaProbed ?? false);
  const [showProbeForm, setShowProbeForm] = useState(false);
  const [probePath, setProbePath] = useState("");
  const [probeJsonPath, setProbeJsonPath] = useState("");

  async function runProbe() {
    setProbing(true);
    setProbeError(null);
    try {
      const r = await fetch("/api/data-sources/" + c.id + "/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: probePath.trim() || "/",
          jsonPath: probeJsonPath.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        setProbeError(j.error ?? "Probe failed");
        return;
      }
      setLocalFields(j.schema.fields ?? []);
      setLocalProbed(true);
      setShowProbeForm(false);
    } finally { setProbing(false); }
  }

  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold text-success">
        <Layers className="h-3 w-3" /> {c.name}
        <span className="rounded-full border border-success/40 bg-success/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-success">
          {c.kind}
        </span>
        {c.kind === "rest" && (
          <button
            type="button"
            onClick={() => setShowProbeForm((v) => !v)}
            disabled={probing}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-success/40 bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success hover:bg-success/20 disabled:opacity-50"
          >
            {probing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            {localProbed ? "Re-probe" : "Probe schema"}
          </button>
        )}
      </div>

      {/* Inline probe form for REST */}
      {c.kind === "rest" && showProbeForm && (
        <div className="ml-5 mt-1 grid gap-1.5 rounded-md border border-success/30 bg-background/60 p-2">
          <label className="grid gap-0.5 text-[10px] text-muted-foreground">
            Sample path
            <input
              type="text" value={probePath}
              onChange={(e) => setProbePath(e.target.value)}
              placeholder="/v3.1/all?fields=name,population,region,cca3"
              disabled={probing}
              className="h-6 rounded border border-border bg-background px-2 font-mono text-[11px]"
            />
          </label>
          <label className="grid gap-0.5 text-[10px] text-muted-foreground">
            jsonPath (optional, e.g. $.data.items)
            <input
              type="text" value={probeJsonPath}
              onChange={(e) => setProbeJsonPath(e.target.value)}
              placeholder="(leave blank to auto-detect)"
              disabled={probing}
              className="h-6 rounded border border-border bg-background px-2 font-mono text-[11px]"
            />
          </label>
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={runProbe}
              disabled={probing}
              className="inline-flex items-center gap-1 rounded-md border border-success/40 bg-success/10 px-2 py-1 text-[10px] font-medium text-success hover:bg-success/20 disabled:opacity-50"
            >
              {probing ? <><Loader2 className="h-3 w-3 animate-spin" /> Probing&hellip;</> : "Run probe"}
            </button>
          </div>
        </div>
      )}

      {/* SQLite tables */}
      {c.kind === "sqlite" && c.tables.length > 0 && (
        <div className="flex flex-wrap gap-1 pl-5">
          {c.tables.map((t) => (
            <code key={t} className="rounded bg-background/80 px-1.5 py-0.5 font-mono text-[10px] text-success">
              {t}
            </code>
          ))}
        </div>
      )}

      {/* REST: discovered fields */}
      {c.kind === "rest" && localProbed && localFields.length > 0 && (
        <div className="flex flex-wrap gap-1 pl-5">
          {localFields.map((f) => (
            <code key={f.name} className="rounded bg-background/80 px-1.5 py-0.5 font-mono text-[10px] text-success" title={f.type}>
              {f.name}
              <span className="ml-1 text-success/70">({f.type})</span>
            </code>
          ))}
        </div>
      )}

      {/* REST: not probed yet */}
      {c.kind === "rest" && !localProbed && !probeError && (
        <div className="pl-5 text-[10px] italic text-muted-foreground">
          Schema not yet discovered. Click <strong>Probe schema</strong> to inspect the API.
        </div>
      )}

      {/* REST: probe error */}
      {probeError && (
        <div className="ml-5 mt-1 rounded border border-destructive/30 bg-destructive/5 px-2 py-1 text-[10px] text-destructive">
          {probeError}
        </div>
      )}
    </div>
  );
}
