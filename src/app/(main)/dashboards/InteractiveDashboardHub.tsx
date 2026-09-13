"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { LayoutGrid, MoreHorizontal, ExternalLink, Pencil, Trash2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter,
} from "@/components/ui/dialog";
import { ScoreRing } from "@/components/common/ScoreRing";
import { useToast } from "@/lib/toast";
import { refreshNavCounts } from "@/lib/navCounts";
import { useT } from "@/lib/i18n/LocaleContext";

type HubDashboard = {
  id: string;
  name: string;
  slug: string;
  reportCount: number;
  updatedAt: string;
  isMine: boolean;
  healthScore: number;
};

/**
 * Grid overview for /dashboards (the hub landing page). Fetches the same
 * /api/dashboards list DashboardsManager uses — this is a second view over
 * the same rows, not a separate entity, so create/edit deep-link into
 * /dashboards/manage (?new=1 / ?edit=<id>) instead of forking a second
 * create/edit form.
 */
export function InteractiveDashboardHub({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useT();
  const { push } = useToast();
  const [items, setItems] = useState<HubDashboard[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  async function refresh() {
    const r = await fetch("/api/dashboards", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null);
    setItems(r?.items ?? []);
  }

  useEffect(() => { refresh(); }, []);

  async function confirmRemove() {
    if (!confirmDelete) return;
    const { id } = confirmDelete;
    setConfirmDelete(null);
    const r = await fetch(`/api/dashboards/${id}`, { method: "DELETE" });
    if (!r.ok) push({ variant: "destructive", title: t("dashboardsMgr.deleteFailed"), description: await r.text() });
    refreshNavCounts();
    refresh();
  }

  const kpis = useMemo(() => {
    const rows = items ?? [];
    const total = rows.length;
    const mine = rows.filter((r) => r.isMine).length;
    const needsReview = rows.filter((r) => r.healthScore < 60).length;
    const updatedToday = rows.filter((r) => Date.now() - new Date(r.updatedAt).getTime() < 24 * 3600_000).length;
    const avgHealth = total > 0 ? Math.round(rows.reduce((s, r) => s + r.healthScore, 0) / total) : 0;
    return { total, mine, needsReview, updatedToday, avgHealth };
  }, [items]);

  return (
    <div className="grid gap-6">
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
            <Button variant="destructive" onClick={confirmRemove}>{t("action.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:flex lg:items-stretch lg:gap-6">
          <Kpi label={t("dashboardsHub.kpi.total")} value={kpis.total} />
          <Kpi label={t("dashboardsHub.kpi.mine")} value={kpis.mine} tone="text-primary" />
          <Kpi label={t("dashboardsHub.kpi.needsReview")} value={kpis.needsReview} tone={kpis.needsReview > 0 ? "text-destructive" : undefined} />
          <Kpi label={t("dashboardsHub.kpi.updatedToday")} value={kpis.updatedToday} tone="text-success" />
          <Kpi label={t("dashboardsHub.kpi.avgHealth")} value={`${kpis.avgHealth}%`} />
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboards/manage" className="text-sm font-medium text-muted-foreground hover:text-foreground hover:underline">
            {t("dashboardsHub.manageAll")}
          </Link>
          {isAdmin && (
            <Link href="/dashboards/manage?new=1">
              <Button size="sm"><Plus className="mr-1.5 h-4 w-4" /> {t("dashboardsMgr.newDashboard")}</Button>
            </Link>
          )}
        </div>
      </div>

      {items === null ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-xl border border-border bg-muted/40" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
          <LayoutGrid className="h-8 w-8 text-muted-foreground/60" />
          <p className="font-medium">{t("dashboardsHub.empty.title")}</p>
          <p className="text-sm text-muted-foreground">{t("dashboardsHub.empty.subtitle")}</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((d) => (
            <DashboardCard
              key={d.id}
              dashboard={d}
              isAdmin={isAdmin}
              onDelete={() => setConfirmDelete({ id: d.id, name: d.name })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="min-w-[84px]">
      <div className={`text-2xl font-semibold tabular-nums ${tone ?? "text-foreground"}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function DashboardCard({ dashboard, isAdmin, onDelete }: { dashboard: HubDashboard; isAdmin: boolean; onDelete: () => void }) {
  const { t } = useT();
  const subtitle = t("dashboardsHub.card.reports").replace("{n}", String(dashboard.reportCount)).replace("{plural}", dashboard.reportCount === 1 ? "" : "s");

  return (
    <div className="group flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-xs transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
      <div className="flex items-start justify-between gap-2">
        <Link href={`/dashboards/${dashboard.slug}`} className="min-w-0 flex-1">
          <h3 className="truncate font-semibold tracking-tight hover:underline">{dashboard.name}</h3>
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link href={`/dashboards/${dashboard.slug}`} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="mr-2 h-4 w-4" /> {t("action.open")}
              </Link>
            </DropdownMenuItem>
            {isAdmin && (
              <>
                <DropdownMenuItem asChild>
                  <Link href={`/dashboards/manage?edit=${dashboard.id}`}>
                    <Pencil className="mr-2 h-4 w-4" /> {t("action.edit")}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
                  <Trash2 className="mr-2 h-4 w-4" /> {t("action.delete")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex items-center gap-3">
        <div title={t("dashboardsHub.card.healthTooltip")}>
          <ScoreRing value={dashboard.healthScore} />
        </div>
        <div className="min-w-0 text-xs text-muted-foreground">
          <div className="truncate">{subtitle}</div>
          <div className="truncate">{t("dashboardsHub.card.updated").replace("{time}", timeAgo(dashboard.updatedAt, t))}</div>
        </div>
      </div>
    </div>
  );
}

// Same pattern as NotebookListClient.tsx's timeAgo() — see time.justNow /
// time.minutesAgo / time.hoursAgo / time.daysAgo in dict.ts.
function timeAgo(iso: string, t: (key: string) => string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return t("time.justNow");
  const min = Math.floor(ms / 60_000);
  if (min < 60) return t("time.minutesAgo").replace("{n}", String(min));
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("time.hoursAgo").replace("{n}", String(hr));
  const days = Math.floor(hr / 24);
  if (days < 30) return t("time.daysAgo").replace("{n}", String(days));
  return new Date(iso).toLocaleDateString();
}
