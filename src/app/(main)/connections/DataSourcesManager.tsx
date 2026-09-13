"use client";
import { useT } from "@/lib/i18n/LocaleContext";

/**
 * Full-page Connections manager. Mirrors the modal drawer's Connections tab
 * but rendered as a standalone page reachable from the sidebar.
 * Non-admin users see the list but not the mutation buttons.
 */
import { useEffect, useRef, useState } from "react";
import { Trash2, Database, Globe, RefreshCw, Pencil, X as CloseIcon, FileSpreadsheet, Lock, Users as UsersIcon, User as UserIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/lib/toast";
import { ConnectionForm } from "@/components/connections/ConnectionForm";
import type {
  DataSourceListItem, EditingConnection, RoleOption, VisibilityWire,
} from "@/components/connections/types";

export function DataSourcesManager({ isAdmin, currentTier }: { isAdmin: boolean; currentTier: string }) {
  const { t } = useT();
  const { push } = useToast();
  const [items, setItems] = useState<DataSourceListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<EditingConnection | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement | null>(null);
  // One hidden file input shared by every Excel row; the row id is captured
  // when the user clicks the icon, then the change handler routes to the
  // right API.
  const refreshInputRef = useRef<HTMLInputElement | null>(null);
  const refreshTargetIdRef = useRef<string | null>(null);

  async function refresh() {
    setBusy(true);
    const r = await fetch(`/api/data-sources?t=${Date.now()}`).then((r) => r.json());
    setItems(r.items ?? []);
    setBusy(false);
  }
  useEffect(() => { refresh(); }, []);

  // Role catalog for the visibility picker. Only admins can read /api/admin/roles,
  // which is fine — only admins can create/edit connections anyway.
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>([]);
  useEffect(() => {
    if (!isAdmin) return;
    fetch("/api/admin/roles")
      .then((r) => r.ok ? r.json() : { items: [] })
      .then((j) => setRoleOptions((j.items ?? []).map((r: any) => ({ slug: r.slug, label: r.label ?? r.slug }))))
      .catch(() => { /* leave empty — user picks tenant or owner_only */ });
  }, [isAdmin]);

  async function startEdit(id: string) {
    const r = await fetch(`/api/data-sources/${id}`);
    if (!r.ok) {
      push({ variant: "destructive", title: t("connections.loadFailedTitle"), description: await r.text() });
      return;
    }
    setEditing(await r.json());
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  async function removeConnection(id: string) {
    const r = await fetch(`/api/data-sources/${id}`, { method: "DELETE" });
    if (!r.ok) push({ variant: "destructive", title: t("connections.deleteFailedTitle"), description: await r.text() });
    if (editing?.id === id) setEditing(null);
    setDeletingId(null);
    refresh();
  }

  function startExcelRefresh(id: string) {
    refreshTargetIdRef.current = id;
    if (refreshInputRef.current) {
      refreshInputRef.current.value = "";
      refreshInputRef.current.click();
    }
  }

  async function onExcelRefreshFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const id = refreshTargetIdRef.current;
    if (!file || !id) return;
    setRefreshingId(id);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`/api/data-sources/${id}/excel/refresh`, { method: "POST", body: fd });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) {
        push({
          variant: "destructive",
          title: t("connections.refreshFailedTitle"),
          description: json?.connectionBroken
            ? `${json?.error ?? t("connections.parseFailedFallback")} ${t("connections.refreshBrokenSuffix")}`
            : (json?.error ?? r.statusText),
        });
        return;
      }
      push({
        variant: "success",
        title: t("connections.excelRefreshedTitle"),
        description: t("connections.excelRefreshedDesc").replace("{n}", String(json.schema.tables.length)).replace("{plural}", json.schema.tables.length === 1 ? "" : "s").replace("{name}", json.name),
      });
      refresh();
    } finally {
      setRefreshingId(null);
      refreshTargetIdRef.current = null;
    }
  }

  return (
    <div className="grid gap-6">
      {/* Shared hidden file input used by every Excel row's refresh button. */}
      <input
        ref={refreshInputRef}
        type="file"
        accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={onExcelRefreshFile}
      />
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-foreground">{t("connections.existingHeading")}</h2>
          <Button size="sm" variant="ghost" onClick={refresh} disabled={busy}>
            <RefreshCw className={`mr-1.5 h-4 w-4 ${busy ? "animate-spin" : ""}`} /> {t("action.refresh")}
          </Button>
        </div>
        <div className="overflow-x-auto rounded-lg border bg-card shadow-xs">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">{t("common.name")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("connections.kindHeader")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("connections.endpointHeader")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("connections.visibilityHeader")}</th>
                <th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className={`border-t ${editing?.id === it.id ? "bg-primary/5" : ""}`}>
                  <td className="px-4 py-2.5 font-medium">{it.name}</td>
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs">
                      {it.kind === "rest" ? <Globe className="h-3.5 w-3.5" />
                        : it.kind === "excel" ? <FileSpreadsheet className="h-3.5 w-3.5" />
                        : it.kind === "postgres" ? <Database className="h-3.5 w-3.5 text-primary" />
                        : it.kind === "mysql" ? <Database className="h-3.5 w-3.5 text-warning" />
                        : it.kind === "snowflake" ? <Database className="h-3.5 w-3.5 text-primary" />
                        : it.kind === "bigquery" ? <Database className="h-3.5 w-3.5 text-success" />
                        : <Database className="h-3.5 w-3.5" />}
                      {it.presetKind === "hubspot" ? "HubSpot CRM" : it.presetKind === "zendesk" ? "Zendesk" : it.kind}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                    {it.kind === "rest" || it.kind === "postgres" || it.kind === "mysql" || it.kind === "snowflake" || it.kind === "bigquery"
                      ? (it.baseUrl ?? "—")
                      : it.kind === "excel"
                        ? (it.originalFilename
                            ? <span className="font-sans">{it.originalFilename} <span className="text-muted-foreground/70">— {t("connections.sheetsRowsSummary").replace("{sheets}", String(it.tableCount ?? 0)).replace("{sheetsPlural}", it.tableCount === 1 ? "" : "s").replace("{rows}", (it.rowCount ?? 0).toLocaleString()).replace("{rowsPlural}", it.rowCount === 1 ? "" : "s")}</span></span>
                            : t("connections.uploadedFilePlaceholder"))
                        : t("connections.localFilePlaceholder")}
                  </td>
                  <td className="px-4 py-2.5">
                    <VisibilityChip visibility={it.visibility} />
                  </td>
                  <td className="px-2 py-2">
                    {isAdmin && (
                      <div className="flex items-center justify-end gap-0.5">
                        {it.kind === "excel" && (
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => startExcelRefresh(it.id)}
                            disabled={refreshingId === it.id}
                            title={t("connections.excelRefreshTitle")}
                          >
                            <RefreshCw className={`h-4 w-4 ${refreshingId === it.id ? "animate-spin" : ""}`} />
                          </Button>
                        )}
                        {it.kind !== "excel" && (
                          <Button size="icon" variant="ghost" onClick={() => startEdit(it.id)} title={t("action.edit")}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                        )}
                        {deletingId === it.id ? (
                          <div className="flex gap-1">
                            <Button size="sm" variant="destructive" onClick={() => removeConnection(it.id)}>
                              {t("action.confirm")}
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setDeletingId(null)}>
                              {t("action.cancel")}
                            </Button>
                          </div>
                        ) : (
                          <Button size="icon" variant="ghost" onClick={() => setDeletingId(it.id)} title={t("action.delete")}>
                            <Trash2 className="h-4 w-4 text-destructive/80" />
                          </Button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr><td colSpan={5} className="p-12 text-center text-muted-foreground">{t("connections.empty")}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {isAdmin && (
        <section ref={formRef}>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-foreground">
              {editing ? t("connections.editHeading").replace("{name}", editing.name) : t("connections.addHeading")}
            </h2>
            {editing && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                <CloseIcon className="mr-1.5 h-4 w-4" /> {t("action.cancel")}
              </Button>
            )}
          </div>
          <ConnectionForm
            editing={editing}
            roleOptions={roleOptions}
            onRoleOptionsChange={setRoleOptions}
            currentTier={currentTier}
            onSaved={() => { setEditing(null); refresh(); }}
          />
        </section>
      )}
    </div>
  );
}

/**
 * Compact visibility chip for the listing row. Mirrors the picker labels.
 */
function VisibilityChip({ visibility }: { visibility?: VisibilityWire }) {
  const { t } = useT();
  if (!visibility) return null;
  if (visibility.mode === "tenant") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground" title={t("connections.visEveryoneTitle")}>
        <UsersIcon className="h-3.5 w-3.5" /> {t("connections.visTenantLabel")}
      </span>
    );
  }
  if (visibility.mode === "roles") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs text-warning  " title={t("connections.visRolesTitle")}>
        <Lock className="h-3.5 w-3.5" />
        {visibility.roles.length === 0 ? t("connections.visRolesFallback") : visibility.roles.join(", ")}
      </span>
    );
  }
  // owner_only
  const mine = (visibility as any).isOwner;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/5 px-2 py-0.5 text-xs text-primary" title={mine ? t("connections.visOwnerMineTitle") : t("connections.visOwnerOtherTitle")}>
      <UserIcon className="h-3.5 w-3.5" /> {mine ? t("tableManage.vis.justMe") : t("connections.visPrivateLabel")}
    </span>
  );
}
