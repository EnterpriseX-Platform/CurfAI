"use client";
import { useT } from "@/lib/i18n/LocaleContext";

/**
 * Full-page On Screen display manager. Mirrors DashboardsManager.tsx's
 * structure (list + create/edit form + kiosk-token panel), minus the
 * AI-recommended-KPI-strip feature and the Interactive toggle — every
 * OnScreenDisplay is non-interactive by construction, so there's nothing to
 * toggle.
 *
 * Fetches on mount:
 *   - /api/on-screen        → list
 *   - /api/reports          → reports the user can pick from
 *   - /api/admin/roles      → role catalog for the visibility picker
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Plus, Trash2, Pencil, X as CloseIcon, Lock, Users as UsersIcon, User as UserIcon,
  Monitor, MoveUp, MoveDown, Sun, Moon, ExternalLink, Key,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/lib/toast";
import { refreshNavCounts } from "@/lib/navCounts";
import { KioskTokenPanel } from "@/app/(main)/dashboards/manage/KioskTokenPanel";
import { UpgradeLock, isFeatureAvailable } from "@/components/common/UpgradeLock";
import { InlineTagManager } from "@/components/common/InlineTagManager";

type VisibilityWire =
  | { mode: "tenant" }
  | { mode: "roles"; roles: string[] }
  | { mode: "owner_only"; ownerUserId?: string; isOwner?: boolean };

type OnScreenListItem = {
  id: string;
  name: string;
  slug: string;
  reportIds: string[];
  reportCount: number;
  rotationSeconds: number;
  theme: "light" | "dark";
  layout: "carousel" | "table_only" | "table_chart" | "chart_only";
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

type EditingOnScreen = {
  id: string;
  name: string;
  slug: string;
  reportIds: string[];
  rotationSeconds: number;
  theme: "light" | "dark";
  layout: "carousel" | "table_only" | "table_chart" | "chart_only";
  visibility?: VisibilityWire;
  kioskTokens: KioskToken[];
};

type ReportOption = { id: string; name: string; category: string | null };
type RoleOption = { slug: string; label: string };

export function OnScreenManager({ isAdmin, currentTier }: { isAdmin: boolean; currentTier: string }) {
  const { t } = useT();
  const { push } = useToast();
  const [items, setItems] = useState<OnScreenListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<EditingOnScreen | null>(null);
  const [creating, setCreating] = useState(false);
  const [reports, setReports] = useState<ReportOption[]>([]);
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>([]);
  const formRef = useRef<HTMLDivElement | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  async function refresh() {
    setBusy(true);
    const r = await fetch("/api/on-screen").then((r) => r.json());
    setItems(r.items ?? []);
    setBusy(false);
    refreshNavCounts();
  }

  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    fetch("/api/reports")
      .then((r) => r.ok ? r.json() : { items: [] })
      .then((j) => setReports((j.items ?? []).map((r: any) => ({
        id: r.id, name: r.name, category: r.category ?? null,
      }))))
      .catch(() => { /* leave empty */ });
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    fetch("/api/admin/roles")
      .then((r) => r.ok ? r.json() : { items: [] })
      .then((j) => setRoleOptions((j.items ?? []).map((r: any) => ({ slug: r.slug, label: r.label ?? r.slug }))))
      .catch(() => { /* ok */ });
  }, [isAdmin]);

  async function startEdit(id: string) {
    const r = await fetch(`/api/on-screen/${id}`);
    if (!r.ok) {
      push({ variant: "destructive", title: t("onScreenMgr.loadFailed"), description: await r.text() });
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

  async function removeOnScreen(id: string, name: string) {
    setConfirmDelete({ id, name });
  }

  async function confirmRemoveOnScreen() {
    if (!confirmDelete) return;
    const { id } = confirmDelete;
    setConfirmDelete(null);
    const r = await fetch(`/api/on-screen/${id}`, { method: "DELETE" });
    if (!r.ok) push({ variant: "destructive", title: t("onScreenMgr.deleteFailed"), description: await r.text() });
    if (editing?.id === id) setEditing(null);
    refresh();
  }

  return (
    <div className="grid gap-6">
      <Dialog open={!!confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-4 w-4" />
              {t("onScreenMgr.deleteTitle")}
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm text-muted-foreground">
              {t("onScreenMgr.deleteConfirm").replace("{name}", confirmDelete?.name ?? "")}
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>{t("action.cancel")}</Button>
            <Button variant="destructive" onClick={confirmRemoveOnScreen}>{t("action.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-foreground">{t("onScreenMgr.existing")}</h2>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <Button size="sm" onClick={startCreate}>
                <Plus className="mr-1.5 h-4 w-4" /> {t("onScreenMgr.newDisplay")}
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
                    <Link href={`/on-screen/${it.slug}`} className="hover:underline" target="_blank" rel="noopener noreferrer">
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
                    {it.layout === "table_only" ? t("dashboardsMgr.layout.tableOnly") : it.layout === "table_chart" ? t("dashboardsMgr.layout.tableChart") : it.layout === "chart_only" ? t("dashboardsMgr.layout.chartOnly") : t("dashboardsMgr.layout.carousel")}
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
                      <Link href={`/on-screen/${it.slug}`} title={t("dashboardsMgr.openViewer")} target="_blank" rel="noopener noreferrer">
                        <Button size="icon" variant="ghost"><Monitor className="h-4 w-4" /></Button>
                      </Link>
                      {isAdmin && (
                        <>
                          <Button size="icon" variant="ghost" onClick={() => startEdit(it.id)} title={t("action.edit")}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button size="icon" variant="ghost" onClick={() => removeOnScreen(it.id, it.name)} title={t("action.delete")}>
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
                  {busy ? t("dashboardsMgr.loading") : t("onScreenMgr.emptyList")}
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
              {editing ? t("onScreenMgr.editTitle").replace("{name}", editing.name) : t("onScreenMgr.newDisplay")}
            </h2>
            <Button size="sm" variant="ghost" onClick={() => { setEditing(null); setCreating(false); }}>
              <CloseIcon className="mr-1.5 h-4 w-4" /> {t("action.cancel")}
            </Button>
          </div>
          <OnScreenForm
            editing={editing}
            availableReports={reports}
            roleOptions={roleOptions}
            onRoleOptionsChange={setRoleOptions}
            onSaved={() => { setEditing(null); setCreating(false); refresh(); }}
          />
          {editing && (
            <div className="mt-6">
              <h3 className="mb-3 text-sm font-medium text-foreground">{t("dashboardsMgr.kioskTokens")}</h3>
              {isFeatureAvailable(currentTier, "dashboard.kiosk_token") ? (
                <KioskTokenPanel
                  dashboardId={editing.id}
                  initialTokens={editing.kioskTokens}
                  apiBase="/api/on-screen"
                />
              ) : (
                <UpgradeLock
                  feature="dashboard.kiosk_token"
                  currentTier={currentTier}
                  description={t("onScreenMgr.kioskUpgrade.desc")}
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
 * Create + edit form. Same "available / selected" reports-picker pattern as
 * DashboardForm — see that component's docstring.
 */
function OnScreenForm({
  editing, availableReports, roleOptions, onRoleOptionsChange, onSaved,
}: {
  editing: EditingOnScreen | null;
  availableReports: ReportOption[];
  roleOptions: RoleOption[];
  onRoleOptionsChange: (next: RoleOption[]) => void;
  onSaved: () => void;
}) {
  const { t } = useT();
  const { push } = useToast();
  const [name, setName] = useState(editing?.name ?? "");
  const [reportIds, setReportIds] = useState<string[]>(editing?.reportIds ?? []);
  const [rotationSeconds, setRotationSeconds] = useState<number>(editing?.rotationSeconds ?? 30);
  const [theme, setTheme] = useState<"light" | "dark">(editing?.theme ?? "light");
  const [layout, setLayout] = useState<"carousel" | "table_only" | "table_chart" | "chart_only">(editing?.layout ?? "table_only");
  const [visibility, setVisibility] = useState<VisibilityWire>(editing?.visibility ?? { mode: "tenant" });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setName(editing?.name ?? "");
    setReportIds(editing?.reportIds ?? []);
    setRotationSeconds(editing?.rotationSeconds ?? 30);
    setTheme(editing?.theme ?? "light");
    setLayout(editing?.layout ?? "table_only");
    setVisibility(editing?.visibility ?? { mode: "tenant" });
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
      const payload = {
        name: name.trim(),
        reportIds,
        rotationSeconds,
        theme,
        layout,
        visibility: visibilityWire,
      };
      const url = editing ? `/api/on-screen/${editing.id}` : "/api/on-screen";
      const method = editing ? "PATCH" : "POST";
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        let msg = await r.text();
        try { msg = JSON.parse(msg).error ?? msg; } catch { /* keep text */ }
        push({ variant: "destructive", title: editing ? t("onScreenMgr.saveFailed") : t("onScreenMgr.createFailed"), description: msg });
        return;
      }
      push({ variant: "success", title: editing ? t("onScreenMgr.saved") : t("onScreenMgr.created") });
      onSaved();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid gap-3 rounded-lg border bg-card p-5 shadow-xs">
      <div className="grid grid-cols-[1fr_140px_120px] gap-3">
        <F label={t("dashboardsMgr.f.name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("onScreenMgr.f.namePlaceholder")} />
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
        <div className="grid grid-cols-3 gap-3">
          <label className={`cursor-pointer rounded-lg border-2 p-3 hover:bg-accent/50 transition-colors ${layout === "table_only" ? "border-primary bg-primary/5" : "border-transparent bg-muted/30"}`}>
            <input type="radio" className="sr-only" checked={layout === "table_only"} onChange={() => setLayout("table_only")} />
            <div className="flex flex-col items-center gap-2">
              <svg width="48" height="32" viewBox="0 0 48 32" className="text-muted-foreground/50">
                <rect width="48" height="32" rx="4" fill="currentColor" fillOpacity="0.2" />
                <rect x="4" y="4" width="40" height="4" rx="1" fill="currentColor" />
                <rect x="4" y="10" width="40" height="4" rx="1" fill="currentColor" fillOpacity="0.5" />
                <rect x="4" y="16" width="40" height="4" rx="1" fill="currentColor" fillOpacity="0.5" />
                <rect x="4" y="22" width="40" height="4" rx="1" fill="currentColor" fillOpacity="0.5" />
              </svg>
              <span className="text-xs font-medium">{t("dashboardsMgr.tpl.tableOnly")}</span>
              <span className="text-[10px] text-muted-foreground text-center leading-tight">{t("dashboardsMgr.tpl.tableOnly.desc")}</span>
            </div>
          </label>
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
        </div>
      </F>
      </div>

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
          {submitting ? t("onScreenMgr.saving") : editing ? t("onScreenMgr.saveChanges") : t("onScreenMgr.createDisplay")}
        </Button>
        {editing && (
          <Link href={`/on-screen/${editing.slug}`} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
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
            <span className="text-xs text-muted-foreground">{t("onScreenMgr.vis.tenantDesc")}</span>
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
            <span className="text-xs text-muted-foreground">{t("onScreenMgr.vis.justMeDesc")}</span>
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
