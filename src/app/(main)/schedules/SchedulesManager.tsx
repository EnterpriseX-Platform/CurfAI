"use client";
import { useT } from "@/lib/i18n/LocaleContext";

import { useEffect, useState } from "react";
import { Plus, Trash2, Play, Loader2 } from "lucide-react";
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

export function SchedulesManager({ reports }: { reports: Array<{ id: string; name: string }> }) {
  const { t } = useT();
  const { push } = useToast();
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // New schedule form state
  const [reportId, setReportId] = useState(reports[0]?.id ?? "");
  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 7 * * 1");
  const [format, setFormat] = useState<"pdf" | "xlsx" | "docx" | "csv">("pdf");
  const [recipients, setRecipients] = useState("");

  async function refresh() {
    const r = await fetch("/api/schedules").then((r) => r.json());
    setItems(r.items ?? []);
  }
  useEffect(() => { refresh(); }, []);

  async function create() {
    if (!reportId || !name || !cron) return;
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
      if (!r.ok) { push({ variant: "destructive", title: t("schedules.createFailed"), description: await r.text() }); return; }
      push({ variant: "success", title: t("schedules.created") });
      setName(""); setRecipients(""); setCron("0 7 * * 1");
      refresh();
    } finally { setCreating(false); }
  }

  async function runNow(id: string) {
    setRunningId(id);
    try {
      const r = await fetch(`/api/schedules/${id}/run`, { method: "POST" });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: t("schedules.runFailed") }));
        push({ variant: "destructive", title: t("schedules.runFailed"), description: err.error });
        return;
      }
      // Trigger file download
      const blob = await r.blob();
      const cd = r.headers.get("content-disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(cd);
      const fname = match?.[1] ?? "report";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = fname; a.click();
      URL.revokeObjectURL(url);
      push({ variant: "success", title: t("schedules.ranAndDownloaded") });
      refresh();
    } finally { setRunningId(null); }
  }

  async function remove(id: string) {
    if (!confirm(t("schedules.confirmDelete"))) return;
    const r = await fetch(`/api/schedules/${id}`, { method: "DELETE" });
    if (!r.ok) { push({ variant: "destructive", title: t("schedules.deleteFailed"), description: await r.text() }); return; }
    refresh();
  }

  async function toggle(id: string, enabled: boolean) {
    await fetch(`/api/schedules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    refresh();
  }

  return (
    <div className="grid gap-6">
      <section>
        <h2 className="mb-3 text-sm font-medium">{t("schedules.activeHeading")}</h2>
        <div className="overflow-x-auto rounded-lg border bg-card shadow-xs">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">{t("common.name")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("watchers.reportLabel")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("watchers.cronLabel")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("metrics.col.format")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("schedules.colLastRun")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("schedules.colEnabled")}</th>
                <th className="w-32" />
              </tr>
            </thead>
            <tbody>
              {items.map((sched) => (
                <tr key={sched.id} className="border-t">
                  <td className="px-4 py-2.5 font-medium">{sched.name}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{sched.reportName}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{sched.cron}</td>
                  <td className="px-4 py-2.5 uppercase text-xs text-muted-foreground">{sched.format}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {sched.lastRunAt
                      ? <span className={sched.lastStatus === "ok" ? "text-success" : "text-destructive"}>
                          {new Date(sched.lastRunAt).toLocaleString()} · {sched.lastStatus}
                        </span>
                      : <span className="italic">{t("common.never")}</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <input
                      type="checkbox"
                      checked={sched.enabled}
                      onChange={(e) => toggle(sched.id, e.target.checked)}
                      className="h-4 w-4 accent-[hsl(var(--primary))]"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center justify-end gap-0.5">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => runNow(sched.id)}
                        disabled={runningId === sched.id}
                        title={t("schedules.runNowTooltip")}
                      >
                        {runningId === sched.id
                          ? <Loader2 className="h-4 w-4 animate-spin" />
                          : <Play className="h-4 w-4" />}
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => remove(sched.id)} title={t("action.delete")}>
                        <Trash2 className="h-4 w-4 text-destructive/80" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr><td colSpan={7} className="p-12 text-center text-muted-foreground">{t("schedules.empty")}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium">{t("schedules.newHeading")}</h2>
        <div className="grid gap-3 rounded-lg border bg-card p-5 shadow-xs">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1">
              <Label>{t("common.name")}</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("schedules.namePlaceholder")} />
            </div>
            <div className="grid gap-1">
              <Label>{t("watchers.reportLabel")}</Label>
              <Select value={reportId} onValueChange={setReportId}>
                <SelectTrigger><SelectValue placeholder={t("schedules.reportPlaceholder")} /></SelectTrigger>
                <SelectContent>
                  {reports.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-[1fr_140px] gap-3">
            <div className="grid gap-1">
              <Label>{t("schedules.cronExpressionLabel")} <span className="font-normal text-muted-foreground">{t("schedules.cronExpressionHint")}</span></Label>
              <Input className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 7 * * 1" />
            </div>
            <div className="grid gap-1">
              <Label>{t("metrics.col.format")}</Label>
              <Select value={format} onValueChange={(v) => setFormat(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pdf">PDF</SelectItem>
                  <SelectItem value="xlsx">Excel</SelectItem>
                  <SelectItem value="docx">Word</SelectItem>
                  <SelectItem value="csv">CSV</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1">
            <Label>{t("schedules.recipientsLabel")} <span className="font-normal text-muted-foreground">{t("schedules.recipientsHint")}</span></Label>
            <Input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="a@acme.co, b@acme.co" />
          </div>
          <div>
            <Button size="sm" onClick={create} disabled={creating || !reportId || !name || !cron}>
              <Plus className="mr-1.5 h-4 w-4" /> {creating ? t("dashboardsMgr.saving") : t("schedules.createButton")}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
