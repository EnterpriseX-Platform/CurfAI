"use client";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Calendar, Clock, Play, Plus, Trash2, X, Loader2, FileSpreadsheet,
  FileText, FileCode,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/lib/toast";

type ScheduleItem = {
  id: string;
  name: string;
  reportId: string;
  reportName: string;
  cron: string;
  format: "pdf" | "xlsx" | "docx" | "csv";
  recipients: string[];
  enabled: boolean;
  lastRunAt?: string | null;
  lastStatus?: string | null;
};

const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: "Every weekday at 07:00",       expr: "0 7 * * 1-5" },
  { label: "Every Monday at 07:00",        expr: "0 7 * * 1" },
  { label: "Every day at 07:00",           expr: "0 7 * * *" },
  { label: "Every Monday at 17:00",        expr: "0 17 * * 1" },
  { label: "First of the month at 06:00",  expr: "0 6 1 * *" },
  { label: "Every hour",                   expr: "0 * * * *" },
];

export function ScheduleDrawer({
  reportId, reportName, open, onClose,
}: {
  reportId: string;
  reportName: string;
  open: boolean;
  onClose: () => void;
}) {
  const { push } = useToast();
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);

  const [name, setName] = useState("Weekly delivery");
  const [cron, setCron] = useState("0 7 * * 1");
  const [format, setFormat] = useState<"pdf" | "xlsx" | "docx" | "csv">("pdf");
  const [recipients, setRecipients] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/schedules?reportId=" + encodeURIComponent(reportId)).then((r) => r.json());
      setItems(r.items ?? []);
    } finally { setLoading(false); }
  }, [reportId]);

  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function create() {
    if (!name || !cron) {
      push({ variant: "destructive", title: "Missing fields", description: "Name and cron are required." });
      return;
    }
    setCreating(true);
    try {
      const r = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reportId, name, cron, format,
          recipients: recipients.split(",").map((x) => x.trim()).filter(Boolean),
          enabled: true,
        }),
      });
      if (!r.ok) {
        push({ variant: "destructive", title: "Create failed", description: await r.text() });
        return;
      }
      push({ variant: "success", title: "Schedule created" });
      setName("Weekly delivery"); setCron("0 7 * * 1"); setRecipients(""); setFormat("pdf");
      refresh();
    } finally { setCreating(false); }
  }

  async function toggle(id: string, enabled: boolean) {
    await fetch("/api/schedules/" + id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    refresh();
  }

  async function remove(id: string) {
    if (!confirm("Delete this schedule?")) return;
    const r = await fetch("/api/schedules/" + id, { method: "DELETE" });
    if (!r.ok) {
      push({ variant: "destructive", title: "Delete failed", description: await r.text() });
      return;
    }
    refresh();
  }

  async function runNow(id: string) {
    setRunningId(id);
    try {
      const r = await fetch("/api/schedules/" + id + "/run", { method: "POST" });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: "Run failed" }));
        push({ variant: "destructive", title: "Run failed", description: err.error });
        return;
      }
      const blob = await r.blob();
      const cd = r.headers.get("content-disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(cd);
      const fname = match?.[1] ?? "report";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = fname; a.click();
      URL.revokeObjectURL(url);
      push({ variant: "success", title: "Ran and downloaded" });
      refresh();
    } finally { setRunningId(null); }
  }

  // Portal so the drawer escapes any ancestor that establishes a containing
  // block via transform/filter/backdrop-filter (the toolbar uses backdrop-blur).
  if (!open || typeof document === "undefined") return null;
  return createPortal((
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <aside className="absolute right-0 top-0 flex h-full w-[480px] max-w-[95vw] flex-col border-l border-border bg-background shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold leading-tight">Schedules</h2>
              <p className="text-[11px] text-muted-foreground">for <span className="font-medium text-foreground">{reportName}</span></p>
            </div>
          </div>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto">
          <section className="border-b border-border px-5 py-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Active schedules
              </h3>
              {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
            </div>
            {items.length === 0 ? (
              <div className="rounded-md border border-dashed border-border bg-muted/20 p-6 text-center">
                <Calendar className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">No schedules yet for this report.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {items.map((s) => (
                  <div key={s.id} className="rounded-md border border-border bg-card p-3 text-xs shadow-xs">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{s.name}</span>
                          <FormatBadge format={s.format} />
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                          <code className="font-mono text-[11px]">{s.cron}</code>
                          <span className="text-[11px]">
                            {s.lastRunAt ? (
                              <span className={s.lastStatus === "ok" ? "text-success" : "text-destructive"}>
                                last: {new Date(s.lastRunAt).toLocaleString()} - {s.lastStatus}
                              </span>
                            ) : <span className="italic">never run</span>}
                          </span>
                        </div>
                        {s.recipients.length > 0 && (
                          <div className="mt-1 truncate text-[11px] text-muted-foreground">
                            to: {s.recipients.join(", ")}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <label className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-1 text-[11px] hover:bg-accent" title="Enabled">
                          <input
                            type="checkbox"
                            checked={s.enabled}
                            onChange={(e) => toggle(s.id, e.target.checked)}
                            className="h-3 w-3 accent-[hsl(var(--primary))]"
                          />
                          {s.enabled ? "on" : "off"}
                        </label>
                        <Button
                          size="icon" variant="ghost"
                          className="h-7 w-7"
                          onClick={() => runNow(s.id)}
                          disabled={runningId === s.id}
                          title="Run now and download"
                        >
                          {runningId === s.id
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <Play className="h-3.5 w-3.5" />}
                        </Button>
                        <Button
                          size="icon" variant="ghost"
                          className="h-7 w-7"
                          onClick={() => remove(s.id)}
                          title="Delete schedule"
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive/80" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="px-5 py-4">
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              New schedule
            </h3>
            <div className="grid gap-3">
              <div className="grid gap-1">
                <Label className="text-xs">Name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Weekly Monday digest"
                  className="h-8 text-xs"
                />
              </div>
              <div className="grid gap-1">
                <Label className="text-xs">Frequency</Label>
                <Select value={CRON_PRESETS.find((p) => p.expr === cron)?.expr ?? "custom"} onValueChange={(v) => v !== "custom" && setCron(v)}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CRON_PRESETS.map((p) => (
                      <SelectItem key={p.expr} value={p.expr}>{p.label}</SelectItem>
                    ))}
                    <SelectItem value="custom">Custom cron...</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  placeholder="0 7 * * 1"
                  className="h-7 font-mono text-[11px]"
                />
                <p className="text-[10px] text-muted-foreground">
                  Five fields: minute hour day-of-month month day-of-week. The cron sweep runs every minute via /api/cron/tick.
                </p>
              </div>
              <div className="grid grid-cols-[1fr_120px] gap-3">
                <div className="grid gap-1">
                  <Label className="text-xs">Recipients <span className="font-normal text-muted-foreground">(comma-separated)</span></Label>
                  <Input
                    value={recipients}
                    onChange={(e) => setRecipients(e.target.value)}
                    placeholder="alex@acme.co, bea@acme.co"
                    className="h-8 text-xs"
                  />
                </div>
                <div className="grid gap-1">
                  <Label className="text-xs">Format</Label>
                  <Select value={format} onValueChange={(v) => setFormat(v as any)}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pdf">PDF</SelectItem>
                      <SelectItem value="xlsx">Excel</SelectItem>
                      <SelectItem value="docx">Word</SelectItem>
                      <SelectItem value="csv">CSV</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button size="sm" onClick={create} disabled={creating || !name || !cron}>
                {creating ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Saving...</> : <><Plus className="mr-1.5 h-4 w-4" /> Create schedule</>}
              </Button>
            </div>
          </section>
        </div>
      </aside>
    </div>
  ), document.body);
}

function FormatBadge({ format }: { format: "pdf" | "xlsx" | "docx" | "csv" }) {
  const Icon = format === "xlsx" ? FileSpreadsheet : format === "csv" ? FileCode : FileText;
  return (
    <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
      <Icon className="h-3 w-3" />
      {format}
    </span>
  );
}
