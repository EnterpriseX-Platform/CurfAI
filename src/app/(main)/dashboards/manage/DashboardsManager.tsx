"use client";
import { useT } from "@/lib/i18n/LocaleContext";

/**
 * Full-page dashboards manager. Lists existing dashboards, lets admins
 * create + edit + delete, and surfaces the kiosk-token panel on edit.
 *
 * Fetches three things on mount:
 *   - /api/dashboards      → list
 *   - /api/reports         → reports the user can pick from
 *   - /api/admin/roles     → role catalog (admin-only) for the visibility picker
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import {
  Plus, Trash2, Pencil, X as CloseIcon, Lock, Users as UsersIcon, User as UserIcon,
  Monitor, MoveUp, MoveDown, Sun, Moon, ExternalLink, Key,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/lib/toast";
import { refreshNavCounts } from "@/lib/navCounts";
import { KioskTokenPanel } from "./KioskTokenPanel";
import { UpgradeLock, isFeatureAvailable } from "@/components/common/UpgradeLock";
import { InlineTagManager } from "@/components/common/InlineTagManager";

type VisibilityWire =
  | { mode: "tenant" }
  | { mode: "roles"; roles: string[] }
  | { mode: "owner_only"; ownerUserId?: string; isOwner?: boolean };

type DashboardListItem = {
  id: string;
  name: string;
  slug: string;
  reportIds: string[];
  reportCount: number;
  rotationSeconds: number;
  theme: "light" | "dark";
  layout: "carousel" | "grid_2x2" | "grid_2x1" | "table_only" | "table_chart" | "chart_only" | "custom";
  visibility?: VisibilityWire;
  kioskTokenCount: number;
  createdAt: string;
};

type KioskToken = {
  id: string;
  label: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

type EditingDashboard = {
  id: string;
  name: string;
  slug: string;
  reportIds: string[];
  rotationSeconds: number;
  theme: "light" | "dark";
  layout: "carousel" | "grid_2x2" | "grid_2x1" | "table_only" | "table_chart" | "chart_only" | "custom";
  visibility?: VisibilityWire;
  topKpis?: any[]; // Keep any for UI config
  kioskTokens: KioskToken[];
};

type ReportOption = { id: string; name: string; category: string | null };
type RoleOption = { slug: string; label: string };
type DataSourceOption = { id: string; name: string; kind: string };

export function DashboardsManager({ isAdmin, currentTier }: { isAdmin: boolean; currentTier: string }) {
  const { t } = useT();
  const { push } = useToast();
  const [items, setItems] = useState<DashboardListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<EditingDashboard | null>(null);
  const [creating, setCreating] = useState(false);
  const [reports, setReports] = useState<ReportOption[]>([]);
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>([]);
  const [dataSources, setDataSources] = useState<DataSourceOption[]>([]);
  const formRef = useRef<HTMLDivElement | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  async function refresh() {
    setBusy(true);
    const r = await fetch("/api/dashboards").then((r) => r.json());
    setItems(r.items ?? []);
    setBusy(false);
    // Keep the sidebar's "Dashboards" badge in sync after a same-page
    // create/delete — it otherwise only fetches once on mount.
    refreshNavCounts();
  }

  useEffect(() => { refresh(); }, []);

  // Reports for the picker. The /api/reports endpoint already filters by tenant.
  useEffect(() => {
    fetch("/api/reports")
      .then((r) => r.ok ? r.json() : { items: [] })
      .then((j) => setReports((j.items ?? []).map((r: any) => ({
        id: r.id, name: r.name, category: r.category ?? null,
      }))))
      .catch(() => { /* leave empty */ });

    fetch("/api/data-sources")
      .then((r) => r.ok ? r.json() : { items: [] })
      .then((j) => setDataSources((j.items ?? []).map((ds: any) => ({
        id: ds.id, name: ds.name, kind: ds.kind,
      }))))
      .catch(() => { /* leave empty */ });
  }, []);

  // Roles catalog (admin-only — non-admins see no edit UI anyway).
  useEffect(() => {
    if (!isAdmin) return;
    fetch("/api/admin/roles")
      .then((r) => r.ok ? r.json() : { items: [] })
      .then((j) => setRoleOptions((j.items ?? []).map((r: any) => ({ slug: r.slug, label: r.label ?? r.slug }))))
      .catch(() => { /* ok */ });
  }, [isAdmin]);

  async function startEdit(id: string) {
    const r = await fetch(`/api/dashboards/${id}`);
    if (!r.ok) {
      push({ variant: "destructive", title: t("dashboardsMgr.loadFailed"), description: await r.text() });
      return;
    }
    const json = await r.json();
    setEditing(json);
    setCreating(false);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  function startCreate() {
    setEditing(null);
    setCreating(true);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  // Deep-link support for the /dashboards hub's card menu (?edit=<id>) and
  // header "New dashboard" button (?new=1) — reuses this form instead of
  // forking a second create/edit UI on the hub page.
  const searchParams = useSearchParams();
  const router = useRouter();
  useEffect(() => {
    if (!isAdmin) return;
    const editId = searchParams.get("edit");
    if (editId) {
      startEdit(editId);
      router.replace("/dashboards/manage");
    } else if (searchParams.get("new") === "1") {
      startCreate();
      router.replace("/dashboards/manage");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, isAdmin]);

  async function removeDashboard(id: string, name: string) {
    setConfirmDelete({ id, name });
  }

  async function confirmRemoveDashboard() {
    if (!confirmDelete) return;
    const { id } = confirmDelete;
    setConfirmDelete(null);
    const r = await fetch(`/api/dashboards/${id}`, { method: "DELETE" });
    if (!r.ok) push({ variant: "destructive", title: t("dashboardsMgr.deleteFailed"), description: await r.text() });
    if (editing?.id === id) setEditing(null);
    refresh();
  }

  return (
    <div className="grid gap-6">
      {/* ── Delete confirmation dialog ── */}
      <Dialog open={!!confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-4 w-4" />
              {t("dashboardsMgr.deleteTitle")}
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm text-muted-foreground">
              {t("dashboardsMgr.deleteConfirm").replace("{name}", confirmDelete?.name ?? "")}
              <br />
              <span className="mt-1 block text-xs text-destructive/80">{t("dashboardsMgr.deleteWarning")}</span>
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>{t("action.cancel")}</Button>
            <Button variant="destructive" onClick={confirmRemoveDashboard}>{t("action.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-foreground">{t("dashboardsMgr.existing")}</h2>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <Button size="sm" onClick={startCreate}>
                <Plus className="mr-1.5 h-4 w-4" /> {t("dashboardsMgr.newDashboard")}
              </Button>
            )}
          </div>
        </div>
        <div className="overflow-x-auto rounded-lg border bg-card shadow-xs">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">{t("common.name")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("dashboardsMgr.col.reports")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("dashboardsMgr.col.rotation")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("dashboardsMgr.col.theme")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("dashboardsMgr.col.layout")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("dashboardsMgr.col.tokens")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("dashboardsMgr.col.visibility")}</th>
                <th className="w-32" />
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className={`border-t ${editing?.id === it.id ? "bg-primary/5" : ""}`}>
                  <td className="px-4 py-2.5 font-medium">
                    <Link href={`/dashboards/${it.slug}`} className="hover:underline" target="_blank" rel="noopener noreferrer">
                      {it.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{it.reportCount}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{it.rotationSeconds}s</td>
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs">
                      {it.theme === "dark" ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
                      {it.theme === "dark" ? t("dashboardsMgr.theme.dark") : t("dashboardsMgr.theme.light")}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-medium text-xs text-muted-foreground">
                    {it.layout === "grid_2x2" ? t("dashboardsMgr.layout.grid2x2") : it.layout === "grid_2x1" ? t("dashboardsMgr.layout.grid2x1") : it.layout === "table_only" ? t("dashboardsMgr.layout.tableOnly") : it.layout === "table_chart" ? t("dashboardsMgr.layout.tableChart") : it.layout === "chart_only" ? t("dashboardsMgr.layout.chartOnly") : it.layout === "custom" ? t("dashboardsMgr.layout.custom") : t("dashboardsMgr.layout.carousel")}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {it.kioskTokenCount > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs">
                        <Key className="h-3.5 w-3.5" /> {it.kioskTokenCount}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <VisibilityChip visibility={it.visibility} />
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center justify-end gap-0.5">
                      <Link href={`/dashboards/${it.slug}`} title={t("dashboardsMgr.openViewer")} target="_blank" rel="noopener noreferrer">
                        <Button size="icon" variant="ghost"><Monitor className="h-4 w-4" /></Button>
                      </Link>
                      {isAdmin && (
                        <>
                          <Button size="icon" variant="ghost" onClick={() => startEdit(it.id)} title={t("action.edit")}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button size="icon" variant="ghost" onClick={() => removeDashboard(it.id, it.name)} title={t("action.delete")}>
                            <Trash2 className="h-4 w-4 text-destructive/80" />
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr><td colSpan={8} className="p-12 text-center text-muted-foreground">
                  {busy ? t("dashboardsMgr.loading") : t("dashboardsMgr.emptyList")}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {isAdmin && (creating || editing) && (
        <section ref={formRef}>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-foreground">
              {editing ? t("dashboardsMgr.editTitle").replace("{name}", editing.name) : t("dashboardsMgr.newDashboard")}
            </h2>
            <Button size="sm" variant="ghost" onClick={() => { setEditing(null); setCreating(false); }}>
              <CloseIcon className="mr-1.5 h-4 w-4" /> {t("action.cancel")}
            </Button>
          </div>
          <DashboardForm
            editing={editing}
            availableReports={reports}
            roleOptions={roleOptions}
            onRoleOptionsChange={setRoleOptions}
            dataSources={dataSources}
            onSaved={() => { setEditing(null); setCreating(false); refresh(); }}
          />
          {editing && (
            <div className="mt-6">
              <h3 className="mb-3 text-sm font-medium text-foreground">{t("dashboardsMgr.kioskTokens")}</h3>
              {/* Kiosk tokens are a Business feature. Below Business we
                  replace the live panel with an UpgradeLock card so the
                  affordance still appears (so reps can pitch it) but the
                  mint button is gone. */}
              {isFeatureAvailable(currentTier, "dashboard.kiosk_token") ? (
                <KioskTokenPanel
                  dashboardId={editing.id}
                  initialTokens={editing.kioskTokens}
                />
              ) : (
                <UpgradeLock
                  feature="dashboard.kiosk_token"
                  currentTier={currentTier}
                  description={t("dashboardsMgr.kioskUpgrade.desc")}
                />
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * Create + edit form. Reports picker uses an "available / selected" two-list
 * pattern: click in the available list to add to the end of selected; click
 * the X in selected to remove; up/down arrows reorder.
 */
function DashboardForm({
  editing, availableReports, roleOptions, onRoleOptionsChange, dataSources, onSaved,
}: {
  editing: EditingDashboard | null;
  availableReports: ReportOption[];
  roleOptions: RoleOption[];
  onRoleOptionsChange: (next: RoleOption[]) => void;
  dataSources: DataSourceOption[];
  onSaved: () => void;
}) {
  const { t } = useT();
  const { push } = useToast();
  const [name, setName] = useState(editing?.name ?? "");
  const [reportIds, setReportIds] = useState<string[]>(editing?.reportIds ?? []);
  const [rotationSeconds, setRotationSeconds] = useState<number>(editing?.rotationSeconds ?? 30);
  const [theme, setTheme] = useState<"light" | "dark">(editing?.theme ?? "light");
  const [layout, setLayout] = useState<"carousel" | "grid_2x2" | "grid_2x1" | "table_only" | "table_chart" | "chart_only" | "custom">(editing?.layout ?? "chart_only");
  const [chartSubLayout, setChartSubLayout] = useState<"carousel" | "grid_2x1" | "grid_2x2">("carousel");
  const [visibility, setVisibility] = useState<VisibilityWire>(editing?.visibility ?? { mode: "tenant" });
  const [topKpis, setTopKpis] = useState<any[]>(editing?.topKpis ?? []);
  const [recommendingKpis, setRecommendingKpis] = useState(false);
  const [selectedDsId, setSelectedDsId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setName(editing?.name ?? "");
    setReportIds(editing?.reportIds ?? []);
    setRotationSeconds(editing?.rotationSeconds ?? 30);
    setTheme(editing?.theme ?? "light");
    // carousel/grid_2x1/grid_2x2 are all sub-layouts of the "Chart Only"
    // template card — collapse them back into that card + the matching
    // sub-layout pick, or the edit form reopens with neither template
    // card highlighted and the sub-layout picker hidden.
    const rawLayout = editing?.layout ?? "table_only";
    if (rawLayout === "carousel" || rawLayout === "grid_2x1" || rawLayout === "grid_2x2") {
      setLayout("chart_only");
      setChartSubLayout(rawLayout);
    } else {
      setLayout(rawLayout);
    }
    setVisibility(editing?.visibility ?? { mode: "tenant" });
    setTopKpis(editing?.topKpis ?? []);
  }, [editing]);

  const reportById = new Map(availableReports.map((r) => [r.id, r]));
  const available = availableReports.filter((r) => !reportIds.includes(r.id));

  function addReport(id: string) {
    if (reportIds.includes(id) || reportIds.length >= 12) return;
    setReportIds([...reportIds, id]);
  }
  function removeReport(id: string) {
    setReportIds(reportIds.filter((x) => x !== id));
  }
  function move(id: string, dir: -1 | 1) {
    const i = reportIds.indexOf(id);
    if (i === -1) return;
    const j = i + dir;
    if (j < 0 || j >= reportIds.length) return;
    const next = reportIds.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setReportIds(next);
  }

  async function handleRecommendKpis() {
    if (!selectedDsId) {
      push({ variant: "destructive", title: t("dashboardsMgr.selectDsFirst") });
      return;
    }
    setRecommendingKpis(true);
    try {
      const r = await fetch("/api/dashboards/recommend-kpis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataSourceId: selectedDsId }),
      });
      if (!r.ok) {
        let msg = await r.text();
        try { msg = JSON.parse(msg).error ?? msg; } catch { /* text */ }
        throw new Error(msg);
      }
      const { kpis } = await r.json();
      setTopKpis(kpis);
      push({ variant: "success", title: t("dashboardsMgr.kpisRecommended") });
    } catch (e: any) {
      push({ variant: "destructive", title: t("dashboardsMgr.recommendFailed"), description: e.message });
    } finally {
      setRecommendingKpis(false);
    }
  }

  async function submit() {
    if (!name.trim() || reportIds.length === 0) {
      push({ variant: "destructive", title: t("dashboardsMgr.nameAndReportRequired") });
      return;
    }
    setSubmitting(true);
    try {
      const visibilityWire = visibility.mode === "roles"
        ? { mode: "roles" as const, roles: visibility.roles }
        : { mode: visibility.mode };
      const resolvedLayout = layout === "chart_only" ? chartSubLayout : layout;
      const resolvedTopKpis = (layout === "table_chart" || layout === "chart_only" || layout === "custom") ? topKpis : [];
      const payload = {
        name: name.trim(),
        reportIds,
        rotationSeconds,
        theme,
        layout: resolvedLayout,
        topKpis: resolvedTopKpis,
        visibility: visibilityWire,
      };
      const url = editing ? `/api/dashboards/${editing.id}` : "/api/dashboards";
      const method = editing ? "PATCH" : "POST";
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        let msg = await r.text();
        try { msg = JSON.parse(msg).error ?? msg; } catch { /* keep text */ }
        push({ variant: "destructive", title: editing ? t("dashboardsMgr.saveFailed") : t("dashboardsMgr.createFailed"), description: msg });
        return;
      }
      push({ variant: "success", title: editing ? t("dashboardsMgr.dashboardSaved") : t("dashboardsMgr.dashboardCreated") });
      onSaved();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid gap-3 rounded-lg border bg-card p-5 shadow-xs">
      <div className="grid grid-cols-[1fr_140px_120px] gap-3">
        <F label={t("dashboardsMgr.f.name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("dashboardsMgr.f.namePlaceholder")} />
        </F>
        <F label={t("dashboardsMgr.f.rotation")}>
          <Input
            type="number" min={5} max={3600}
            value={rotationSeconds}
            onChange={(e) => setRotationSeconds(Math.max(5, Math.min(3600, Number(e.target.value) || 30)))}
          />
        </F>
        <F label={t("dashboardsMgr.f.theme")}>
          <Select value={theme} onValueChange={(v) => setTheme(v as "light" | "dark")}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="light">{t("dashboardsMgr.f.themeLight")}</SelectItem>
              <SelectItem value="dark">{t("dashboardsMgr.f.themeDark")}</SelectItem>
            </SelectContent>
          </Select>
        </F>
      <F label={t("dashboardsMgr.f.template")}>
        {/* Table Only is deliberately not offered here — an interactive
            Dashboard is meant to be read at a glance (charts/KPIs), not
            scrolled like a raw data table; DashboardViewer already strips
            table blocks from interactive dashboards regardless of layout.
            "On Screen" wall displays keep all three templates, including
            Table Only, in OnScreenManager.tsx — that surface is unaffected. */}
        <div className="grid grid-cols-3 gap-3">
          {/* Table + Chart */}
          <label className={`cursor-pointer rounded-lg border-2 p-3 hover:bg-accent/50 transition-colors ${layout === "table_chart" ? "border-primary bg-primary/5" : "border-transparent bg-muted/30"}`}>
            <input type="radio" className="sr-only" checked={layout === "table_chart"} onChange={() => setLayout("table_chart")} />
            <div className="flex flex-col items-center gap-2">
              <svg width="48" height="32" viewBox="0 0 48 32" className="text-muted-foreground/50">
                <rect width="48" height="32" rx="4" fill="currentColor" fillOpacity="0.2" />
                <circle cx="14" cy="16" r="8" fill="currentColor" />
                <rect x="28" y="6" width="16" height="4" rx="1" fill="currentColor" />
                <rect x="28" y="12" width="16" height="4" rx="1" fill="currentColor" fillOpacity="0.5" />
                <rect x="28" y="18" width="16" height="4" rx="1" fill="currentColor" fillOpacity="0.5" />
                <rect x="28" y="24" width="16" height="4" rx="1" fill="currentColor" fillOpacity="0.5" />
              </svg>
              <span className="text-xs font-medium text-center">{t("dashboardsMgr.tpl.tableChart")}</span>
              <span className="text-[10px] text-muted-foreground text-center leading-tight">{t("dashboardsMgr.tpl.tableChart.desc")}</span>
            </div>
          </label>
          {/* Chart Only */}
          <label className={`cursor-pointer rounded-lg border-2 p-3 hover:bg-accent/50 transition-colors ${layout === "chart_only" ? "border-primary bg-primary/5" : "border-transparent bg-muted/30"}`}>
            <input type="radio" className="sr-only" checked={layout === "chart_only"} onChange={() => setLayout("chart_only")} />
            <div className="flex flex-col items-center gap-2">
              <svg width="48" height="32" viewBox="0 0 48 32" className="text-muted-foreground/50">
                <rect width="48" height="32" rx="4" fill="currentColor" fillOpacity="0.2" />
                <rect x="8" y="18" width="8" height="10" rx="1" fill="currentColor" />
                <rect x="20" y="8" width="8" height="20" rx="1" fill="currentColor" />
                <rect x="32" y="14" width="8" height="14" rx="1" fill="currentColor" />
              </svg>
              <span className="text-xs font-medium">{t("dashboardsMgr.tpl.chartOnly")}</span>
              <span className="text-[10px] text-muted-foreground text-center leading-tight">{t("dashboardsMgr.tpl.chartOnly.desc")}</span>
            </div>
          </label>
          {/* Custom — free-form drag/resize, edited live on the dashboard
              page itself (see DashboardViewer.tsx's "Edit Layout" toggle),
              so there's no sub-layout picker here. */}
          <label className={`cursor-pointer rounded-lg border-2 p-3 hover:bg-accent/50 transition-colors ${layout === "custom" ? "border-primary bg-primary/5" : "border-transparent bg-muted/30"}`}>
            <input type="radio" className="sr-only" checked={layout === "custom"} onChange={() => setLayout("custom")} />
            <div className="flex flex-col items-center gap-2">
              <svg width="48" height="32" viewBox="0 0 48 32" className="text-muted-foreground/50">
                <rect width="48" height="32" rx="4" fill="currentColor" fillOpacity="0.2" />
                <rect x="5" y="5" width="15" height="10" rx="1" fill="currentColor" />
                <rect x="24" y="4" width="19" height="7" rx="1" fill="currentColor" fillOpacity="0.7" />
                <rect x="6" y="19" width="10" height="9" rx="1" fill="currentColor" fillOpacity="0.5" />
                <rect x="22" y="15" width="21" height="13" rx="1" fill="currentColor" fillOpacity="0.85" />
              </svg>
              <span className="text-xs font-medium text-center">{t("dashboardsMgr.tpl.custom")}</span>
              <span className="text-[10px] text-muted-foreground text-center leading-tight">{t("dashboardsMgr.tpl.custom.desc")}</span>
            </div>
          </label>
        </div>

        {/* Chart Only — sub-layout picker */}
        {layout === "chart_only" && (
          <div className="mt-3 rounded-md border border-border bg-muted/30 p-3">
            <p className="mb-2 text-xs font-medium text-foreground">{t("dashboardsMgr.chartMode")}</p>
            <div className="grid grid-cols-3 gap-2">
              <label className={`cursor-pointer rounded-md border-2 p-2 text-center transition-colors ${chartSubLayout === "carousel" ? "border-primary bg-primary/10" : "border-transparent bg-muted/30 hover:bg-accent/50"}`}>
                <input type="radio" className="sr-only" checked={chartSubLayout === "carousel"} onChange={() => setChartSubLayout("carousel")} />
                <svg width="36" height="24" viewBox="0 0 36 24" className="mx-auto mb-1 text-muted-foreground/60">
                  <rect width="36" height="24" rx="3" fill="currentColor" fillOpacity="0.15" />
                  <rect x="3" y="3" width="30" height="18" rx="2" fill="currentColor" />
                </svg>
                <span className="text-[10px] font-medium">{t("dashboardsMgr.chartMode.carousel")}</span>
              </label>
              <label className={`cursor-pointer rounded-md border-2 p-2 text-center transition-colors ${chartSubLayout === "grid_2x1" ? "border-primary bg-primary/10" : "border-transparent bg-muted/30 hover:bg-accent/50"}`}>
                <input type="radio" className="sr-only" checked={chartSubLayout === "grid_2x1"} onChange={() => setChartSubLayout("grid_2x1")} />
                <svg width="36" height="24" viewBox="0 0 36 24" className="mx-auto mb-1 text-muted-foreground/60">
                  <rect width="36" height="24" rx="3" fill="currentColor" fillOpacity="0.15" />
                  <rect x="3" y="3" width="13" height="18" rx="1" fill="currentColor" />
                  <rect x="20" y="3" width="13" height="18" rx="1" fill="currentColor" />
                </svg>
                <span className="text-[10px] font-medium">{t("dashboardsMgr.chartMode.grid1x2")}</span>
              </label>
              <label className={`cursor-pointer rounded-md border-2 p-2 text-center transition-colors ${chartSubLayout === "grid_2x2" ? "border-primary bg-primary/10" : "border-transparent bg-muted/30 hover:bg-accent/50"}`}>
                <input type="radio" className="sr-only" checked={chartSubLayout === "grid_2x2"} onChange={() => setChartSubLayout("grid_2x2")} />
                <svg width="36" height="24" viewBox="0 0 36 24" className="mx-auto mb-1 text-muted-foreground/60">
                  <rect width="36" height="24" rx="3" fill="currentColor" fillOpacity="0.15" />
                  <rect x="3" y="3" width="13" height="8" rx="1" fill="currentColor" />
                  <rect x="20" y="3" width="13" height="8" rx="1" fill="currentColor" />
                  <rect x="3" y="13" width="13" height="8" rx="1" fill="currentColor" />
                  <rect x="20" y="13" width="13" height="8" rx="1" fill="currentColor" />
                </svg>
                <span className="text-[10px] font-medium">{t("dashboardsMgr.chartMode.grid2x2")}</span>
              </label>
            </div>
          </div>
        )}
      </F>
      </div>

      {/* Top KPIs — only shown for Table+Chart and Chart Only */}
      {(layout === "table_chart" || layout === "chart_only" || layout === "custom") && (
        <F label={t("dashboardsMgr.topKpis.label")}>
          <div className="rounded-md border bg-background p-4 grid gap-3">
            <p className="text-xs text-muted-foreground">{t("dashboardsMgr.topKpis.desc")}</p>
            <div className="flex items-end gap-2">
              <div className="flex-1 grid gap-1">
                <Label className="text-xs">{t("dashboardsMgr.sourceData")}</Label>
                <Select value={selectedDsId} onValueChange={setSelectedDsId}>
                  <SelectTrigger><SelectValue placeholder={t("dashboardsMgr.sourceData.placeholder")} /></SelectTrigger>
                  <SelectContent>
                    {dataSources.map(ds => (
                      <SelectItem key={ds.id} value={ds.id}>{ds.name} ({ds.kind})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="button" variant="secondary" onClick={handleRecommendKpis} disabled={recommendingKpis || !selectedDsId}>
                {recommendingKpis ? t("dashboardsMgr.analyzing") : t("dashboardsMgr.recommendKpis")}
              </Button>
              {topKpis.length > 0 && (
                <Button type="button" variant="ghost" onClick={() => setTopKpis([])} className="text-destructive/70 hover:text-destructive">
                  {t("action.clear")}
                </Button>
              )}
            </div>
            {topKpis.length > 0 && (
              <div className="grid gap-2 border-t pt-3">
                <Label className="text-xs text-muted-foreground">{t("dashboardsMgr.generatedKpis")}</Label>
                <div className="grid grid-cols-3 gap-2">
                  {topKpis.map((kpi, idx) => (
                    <div key={idx} className="rounded border bg-muted/40 p-2 text-xs">
                      <div className="font-semibold">{kpi.label}</div>
                      {kpi.description && (
                        <div className="text-muted-foreground mt-1 truncate" title={kpi.query?.sql}>
                          {kpi.description}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </F>
      )}

      {/* Selected reports — ordered, with up/down + remove. */}
      <F label={t("dashboardsMgr.reportsOrder").replace("{n}", String(reportIds.length))}>
        <div className="overflow-hidden rounded-md border bg-background">
          {reportIds.length === 0 && (
            <div className="p-4 text-center text-xs text-muted-foreground italic">
              {t("dashboardsMgr.noReportsAdded")}
            </div>
          )}
          {reportIds.map((id, i) => {
            const r = reportById.get(id);
            return (
              <div key={id} className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 last:border-b-0">
                <span className="w-6 text-center text-xs text-muted-foreground">{i + 1}.</span>
                <span className="flex-1 text-sm">{r?.name ?? <span className="italic text-muted-foreground">{t("dashboardsMgr.missingReport").replace("{id}", id.slice(0, 8))}</span>}</span>
                {r?.category && (
                  <span className="rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">{r.category}</span>
                )}
                <Button size="icon" variant="ghost" onClick={() => move(id, -1)} disabled={i === 0} title={t("dashboardsMgr.moveUp")}>
                  <MoveUp className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => move(id, 1)} disabled={i === reportIds.length - 1} title={t("dashboardsMgr.moveDown")}>
                  <MoveDown className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => removeReport(id)} title={t("action.remove")}>
                  <CloseIcon className="h-3.5 w-3.5 text-destructive/80" />
                </Button>
              </div>
            );
          })}
        </div>
      </F>

      {/* Available reports. */}
      <F label={t("dashboardsMgr.availableReports")}>
        <div className="max-h-48 overflow-y-auto rounded-md border bg-background">
          {available.length === 0 && (
            <div className="p-4 text-center text-xs text-muted-foreground italic">
              {availableReports.length === 0 ? t("dashboardsMgr.noReportsYet") : t("dashboardsMgr.allReportsAdded")}
            </div>
          )}
          {available.map((r) => (
            <button
              key={r.id}
              type="button"
              className="flex w-full items-center gap-2 border-b border-border/60 px-3 py-1.5 text-left hover:bg-muted/40 last:border-b-0"
              onClick={() => addReport(r.id)}
              disabled={reportIds.length >= 12}
            >
              <Plus className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="flex-1 text-sm">{r.name}</span>
              {r.category && (
                <span className="rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">{r.category}</span>
              )}
            </button>
          ))}
        </div>
      </F>

      <VisibilityPicker value={visibility} onChange={setVisibility} roleOptions={roleOptions} onRoleOptionsChange={onRoleOptionsChange} />

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={submit} disabled={submitting || !name.trim() || reportIds.length === 0}>
          <Plus className="mr-1.5 h-4 w-4" />
          {submitting ? t("dashboardsMgr.saving") : editing ? t("dashboardsMgr.saveChanges") : t("dashboardsMgr.createDashboard")}
        </Button>
        {editing && (
          <Link href={`/dashboards/${editing.slug}`} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
            <span className="inline-flex items-center gap-1"><ExternalLink className="h-3 w-3" /> {t("dashboardsMgr.openViewer")}</span>
          </Link>
        )}
      </div>
    </div>
  );
}

function VisibilityChip({ visibility }: { visibility?: VisibilityWire }) {
  const { t } = useT();
  if (!visibility) return null;
  if (visibility.mode === "tenant") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground" title={t("dashboardsMgr.vis.everyoneTitle")}>
        <UsersIcon className="h-3.5 w-3.5" /> {t("dashboardsMgr.vis.tenant")}
      </span>
    );
  }
  if (visibility.mode === "roles") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs text-warning  " title={t("dashboardsMgr.vis.rolesOnlyTitle")}>
        <Lock className="h-3.5 w-3.5" />
        {visibility.roles.length === 0 ? t("dashboardsMgr.vis.roles") : visibility.roles.join(", ")}
      </span>
    );
  }
  const mine = (visibility as any).isOwner;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/5 px-2 py-0.5 text-xs text-primary" title={mine ? t("dashboardsMgr.vis.onlyYouTitle") : t("dashboardsMgr.vis.privateTitle")}>
      <UserIcon className="h-3.5 w-3.5" /> {mine ? t("dashboardsMgr.vis.justMe") : t("dashboardsMgr.vis.private")}
    </span>
  );
}

function VisibilityPicker({
  value, onChange, roleOptions, onRoleOptionsChange,
}: {
  value: VisibilityWire;
  onChange: (v: VisibilityWire) => void;
  roleOptions: RoleOption[];
  onRoleOptionsChange: (next: RoleOption[]) => void;
}) {
  const { t } = useT();
  const mode = value.mode;
  const selectedRoles = value.mode === "roles" ? value.roles : [];

  function toggleRole(slug: string) {
    if (mode !== "roles") return;
    const set = new Set(selectedRoles);
    if (set.has(slug)) set.delete(slug); else set.add(slug);
    onChange({ mode: "roles", roles: Array.from(set) });
  }

  return (
    <div className="grid gap-2 rounded-md border border-dashed border-border/80 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("dashboardsMgr.vis.heading")}</p>
      <div className="grid gap-1.5 text-sm">
        <label className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-muted/40">
          <input type="radio" className="mt-1" checked={mode === "tenant"} onChange={() => onChange({ mode: "tenant" })} />
          <span className="flex-1">
            <span className="flex items-center gap-1.5 font-medium"><UsersIcon className="h-3.5 w-3.5" /> {t("dashboardsMgr.vis.tenantLabel")}</span>
            <span className="text-xs text-muted-foreground">{t("dashboardsMgr.vis.tenantDesc")}</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-muted/40">
          <input type="radio" className="mt-1" checked={mode === "roles"} onChange={() => onChange({ mode: "roles", roles: selectedRoles })} />
          <span className="flex-1">
            <span className="flex items-center gap-1.5 font-medium"><Lock className="h-3.5 w-3.5" /> {t("dashboardsMgr.vis.rolesLabel")}</span>
            <span className="text-xs text-muted-foreground">{t("dashboardsMgr.vis.rolesDesc")}</span>
            {mode === "roles" && (
              <span className="mt-2 block">
                <InlineTagManager
                  options={roleOptions}
                  selected={selectedRoles}
                  onToggle={toggleRole}
                  onOptionsChange={onRoleOptionsChange}
                />
              </span>
            )}
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-muted/40">
          <input type="radio" className="mt-1" checked={mode === "owner_only"} onChange={() => onChange({ mode: "owner_only" })} />
          <span className="flex-1">
            <span className="flex items-center gap-1.5 font-medium"><UserIcon className="h-3.5 w-3.5" /> {t("dashboardsMgr.vis.justMe")}</span>
            <span className="text-xs text-muted-foreground">{t("dashboardsMgr.vis.justMeDesc")}</span>
          </span>
        </label>
      </div>
    </div>
  );
}

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
