"use client";
/**
 * MaterializedViewsPanel — collapsible section under /tables that shows
 * the tenant's MVs + lets editors create / refresh / pause / delete.
 *
 * Mounted alongside the Backups panel so both Phase 3 production-grade
 * pieces live in one place. Lazy-loads the MV list on first expand.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/LocaleContext";
import {
  Layers, Plus, Loader2, Play, Pause, Trash2, Check, X, AlertTriangle, Clock,
  RotateCcw, Database, Sparkles,
} from "lucide-react";

type MV = {
  id: string;
  name: string;
  sql: string;
  dataSourceId: string;
  cron: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastRowCount: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  createdAt: string;
};

type Connection = { id: string; name: string; kind: string };

export function MaterializedViewsPanel({ connections }: { connections: Connection[] }) {
  const { t } = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<MV[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Create-form state
  const [name, setName] = useState("");
  const [sql, setSql] = useState("");
  const [dataSourceId, setDataSourceId] = useState(connections[0]?.id ?? "");
  const [cron, setCron] = useState("0 6 * * *");
  const [runNow, setRunNow] = useState(true);
  const [prefillBanner, setPrefillBanner] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch("/api/lake/materialized-views", { cache: "no-store", credentials: "include" });
      if (!r.ok) return;
      const j = await r.json();
      setItems(j.items ?? []);
    } catch { /* silent */ }
  }

  useEffect(() => { if (open && items === null) void load(); }, [open, items]);

  // Handoff from the SlowQueryBanner: /tables?suggestMv=<reportId> opens
  // the section, opens the create form, and pre-fills name/SQL/dataSource
  // from the report's first SQL query. Self-clears the URL param after
  // pickup so a refresh doesn't re-trigger.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const here = new URL(window.location.href);
    const reportId = here.searchParams.get("suggestMv");
    if (!reportId) return;

    setOpen(true);
    setCreating(true);
    void (async () => {
      try {
        const r = await fetch(`/api/reports/${reportId}/mv-prefill`, { credentials: "include" });
        if (!r.ok) return;
        const j = await r.json();
        if (j.suggestedName) setName(j.suggestedName);
        if (j.suggestedSql) setSql(j.suggestedSql);
        if (j.dataSourceId) setDataSourceId(j.dataSourceId);
        if (j.suggestedCron) setCron(j.suggestedCron);
        setPrefillBanner(t("materializedViews.prefillBanner").replace("{name}", j.sourceReportName ?? "report"));
      } catch { /* silent — admin can fill in manually */ }
    })();

    here.searchParams.delete("suggestMv");
    window.history.replaceState(null, "", here.pathname + (here.search ? here.search : "") + here.hash);
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy("create"); setError(null); setSuccess(null);
    try {
      const r = await fetch("/api/lake/materialized-views", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          sql: sql.trim(),
          dataSourceId,
          cron: cron.trim() || undefined,
          runNow,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);
      setSuccess(
        runNow && j.firstRun
          ? t("materializedViews.createdWithRunMsg")
              .replace("{name}", name)
              .replace("{status}", j.firstRun.status)
              .replace("{rows}", String(j.firstRun.rowCount))
              .replace("{ms}", String(j.firstRun.durationMs))
          : t("materializedViews.createdNoCronMsg").replace("{name}", name)
      );
      setItems(null); void load();
      setName(""); setSql(""); setCron("0 6 * * *"); setRunNow(true); setCreating(false);
      router.refresh();
    } catch (e: any) {
      setError(e?.message ?? t("materializedViews.createFailedFallback"));
    } finally { setBusy(null); }
  }

  async function refresh(id: string) {
    setBusy(`refresh-${id}`); setError(null); setSuccess(null);
    try {
      const r = await fetch(`/api/lake/materialized-views/${id}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "refresh" }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);
      setSuccess(t("materializedViews.refreshedMsg").replace("{rows}", String(j.result.rowCount)).replace("{ms}", String(j.result.durationMs)));
      setItems(null); void load();
      router.refresh();
    } catch (e: any) {
      setError(e?.message ?? t("materializedViews.refreshFailedFallback"));
    } finally { setBusy(null); }
  }

  async function toggle(id: string) {
    setBusy(`toggle-${id}`);
    try {
      const r = await fetch(`/api/lake/materialized-views/${id}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "toggle" }),
      });
      if (r.ok) { setItems(null); void load(); }
    } finally { setBusy(null); }
  }

  async function remove(id: string) {
    if (!confirm(t("materializedViews.deleteConfirm"))) return;
    setBusy(`del-${id}`);
    try {
      const r = await fetch(`/api/lake/materialized-views/${id}`, { method: "DELETE", credentials: "include" });
      if (r.ok) { setItems((xs) => (xs ?? []).filter((m) => m.id !== id)); router.refresh(); }
    } finally { setBusy(null); }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-5 shadow-xs">
      <header className="flex items-center justify-between">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-2 text-left">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Layers className="h-3.5 w-3.5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">{t("materializedViews.heading")}</h2>
            <p className="text-[11px] text-muted-foreground">
              {t("materializedViews.subtitle")}
            </p>
          </div>
        </button>
        <span className="text-muted-foreground">{open ? "▲" : "▼"}</span>
      </header>

      {open && (
        <div className="mt-4 space-y-3">
          {!creating && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
            >
              <Plus className="h-3 w-3" /> {t("materializedViews.newButton")}
            </button>
          )}

          {creating && (
            <form onSubmit={create} className="grid gap-2 rounded-md border border-dashed border-border bg-muted/20 p-3">
              {prefillBanner && (
                <div className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning  ">
                  <Sparkles className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>{prefillBanner}</span>
                </div>
              )}
              <div className="grid gap-2 md:grid-cols-2">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("common.name")}</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="daily_revenue_summary"
                    required maxLength={60}
                    pattern="^[a-zA-Z][a-zA-Z0-9_ ]*$"
                    className="mt-1 h-8 w-full rounded border border-border bg-background px-2 font-mono text-xs"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("materializedViews.sourceConnectionLabel")}</span>
                  <select
                    value={dataSourceId}
                    onChange={(e) => setDataSourceId(e.target.value)}
                    required
                    className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-xs"
                  >
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>{c.name} ({c.kind})</option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("materializedViews.sqlLabel")}</span>
                <textarea
                  value={sql}
                  onChange={(e) => setSql(e.target.value)}
                  required
                  rows={4}
                  placeholder={'SELECT "stage", SUM(CAST("value" AS REAL)) AS total\nFROM "sales_pipeline"\nGROUP BY "stage"'}
                  className="mt-1 w-full rounded border border-border bg-background p-2 font-mono text-xs"
                />
              </label>
              <div className="grid gap-2 md:grid-cols-3">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("materializedViews.cronLabel")}</span>
                  <input
                    value={cron}
                    onChange={(e) => setCron(e.target.value)}
                    placeholder={t("materializedViews.cronPlaceholder")}
                    className="mt-1 h-8 w-full rounded border border-border bg-background px-2 font-mono text-xs"
                  />
                </label>
                <label className="mt-5 flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={runNow}
                    onChange={(e) => setRunNow(e.target.checked)}
                    className="accent-primary"
                  />
                  {t("materializedViews.runImmediately")}
                </label>
                <div className="mt-5 flex items-center gap-1">
                  <button
                    type="submit"
                    disabled={busy === "create" || !name.trim() || !sql.trim() || !dataSourceId}
                    className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {busy === "create" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    {t("action.create")}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setCreating(false); setName(""); setSql(""); }}
                    className="h-8 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-muted"
                  >
                    {t("action.cancel")}
                  </button>
                </div>
              </div>
            </form>
          )}

          {success && (
            <div className="flex items-start gap-1.5 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-xs text-success ">
              <Check className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{success}</span>
              <button type="button" onClick={() => setSuccess(null)} className="ml-auto rounded p-0.5 hover:bg-success/20"><X className="h-3 w-3" /></button>
            </div>
          )}
          {error && (
            <div className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {items === null && <p className="text-xs text-muted-foreground">{t("materializedViews.loading")}</p>}
          {items !== null && items.length === 0 && !creating && (
            <p className="rounded-md border border-dashed border-border bg-muted/10 px-3 py-3 text-center text-[11px] text-muted-foreground">
              {t("materializedViews.emptyState")}
            </p>
          )}
          {items !== null && items.length > 0 && (
            <ul className="divide-y divide-border rounded-md border border-border bg-background">
              {items.map((mv) => (
                <li key={mv.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs">
                      <Database className="h-3 w-3 text-muted-foreground" />
                      <code className="font-mono font-medium">{mv.name}</code>
                      <span className={
                        "rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider " +
                        (mv.lastStatus === "ok" ? "bg-success/10 text-success" :
                         mv.lastStatus === "failed" ? "bg-destructive/10 text-destructive" :
                         "bg-muted text-muted-foreground")
                      }>
                        {mv.lastStatus ?? t("materializedViews.neverRun")}
                      </span>
                      {!mv.enabled && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">{t("materializedViews.pausedBadge")}</span>}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {mv.lastRunAt
                        ? `${new Date(mv.lastRunAt).toLocaleString()} · ${t("materializedViews.lastRunSummary").replace("{rows}", mv.lastRowCount?.toLocaleString() ?? "—").replace("{ms}", String(mv.lastDurationMs ?? 0))}`
                        : t("materializedViews.cronDisplay").replace("{cron}", mv.cron ?? t("materializedViews.manualOnlyDisplay"))}
                    </div>
                    {mv.lastError && (
                      <p className="mt-1 truncate font-mono text-[10px] text-destructive" title={mv.lastError}>
                        {mv.lastError.slice(0, 100)}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => refresh(mv.id)}
                      disabled={!!busy}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] hover:bg-muted disabled:opacity-50"
                    >
                      {busy === `refresh-${mv.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                      {t("action.refresh")}
                    </button>
                    <button
                      type="button"
                      onClick={() => toggle(mv.id)}
                      disabled={!!busy}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                      title={mv.enabled ? t("action.pause") : t("action.resume")}
                    >
                      {mv.enabled ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(mv.id)}
                      disabled={!!busy}
                      className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                      title={t("action.delete")}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
