"use client";
import { useT } from "@/lib/i18n/LocaleContext";

import { useEffect, useState } from "react";
import { Building2, ShieldCheck, ShieldOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/lib/toast";

type TenantRole = { tenantId: string; tenantName: string; role: string };
type Member = { userId: string; email: string; name: string | null; isPlatformAdmin: boolean; tenantRoles: TenantRole[] };
type Tenant = { id: string; name: string; slug: string };
type OrgData = {
  organization: { id: string; name: string; nameEn: string | null; accountType: string };
  tenants: Tenant[];
  members: Member[];
};

const ROLE_OPTIONS = ["admin", "developer", "executive", "viewer"] as const;

/**
 * Platform Admin's org-wide view — shown on /admin/users only when the
 * viewer holds OrgMembership(platform_admin) for the active tenant's org
 * AND the org tier unlocks it (see requireOrgPlatformAdmin() server-side;
 * this component trusts the page already gated it, but every write still
 * re-checks server-side via /api/admin/organization).
 */
export function OrganizationPanel() {
  const { t } = useT();
  const { push } = useToast();
  const [data, setData] = useState<OrgData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/organization")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setData(j))
      .finally(() => setLoading(false));
  }, []);

  async function patch(body: unknown, key: string) {
    setBusyKey(key);
    try {
      const res = await fetch("/api/admin/organization", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let msg = await res.text();
        try { msg = JSON.parse(msg).error ?? msg; } catch { /* keep text */ }
        push({ variant: "destructive", title: t("admin.organizationPanel.actionFailed"), description: msg });
        return false;
      }
      return true;
    } finally {
      setBusyKey(null);
    }
  }

  async function refresh() {
    const res = await fetch("/api/admin/organization");
    if (res.ok) setData(await res.json());
  }

  async function togglePlatformAdmin(m: Member) {
    const action = m.isPlatformAdmin ? "revoke_platform_admin" : "grant_platform_admin";
    const ok = await patch({ action, userId: m.userId }, `pa:${m.userId}`);
    if (ok) {
      push({ variant: "success", title: m.isPlatformAdmin ? t("admin.organizationPanel.revoked") : t("admin.organizationPanel.granted") });
      await refresh();
    }
  }

  async function setRole(userId: string, tenantId: string, role: string) {
    const ok = await patch({ action: "set_role", userId, tenantId, role }, `role:${userId}:${tenantId}`);
    if (ok) await refresh();
  }

  if (loading) {
    return <div className="flex items-center gap-2 rounded-lg border bg-card p-5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t("admin.organizationPanel.loading")}</div>;
  }
  if (!data) return null;

  return (
    <section className="rounded-lg border bg-card p-5 shadow-xs">
      <div className="mb-4 flex items-center gap-2">
        <Building2 className="h-4 w-4 text-primary" />
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("admin.organizationPanel.heading")}
        </p>
      </div>
      <p className="mb-4 text-sm text-foreground">
        {data.organization.name}
        {data.organization.nameEn ? ` (${data.organization.nameEn})` : ""}
        <span className="ml-2 text-xs text-muted-foreground">
          {t("admin.organizationPanel.workspaceCount").replace("{n}", String(data.tenants.length))}
        </span>
      </p>

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">{t("admin.usersManager.colUser")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("admin.organizationPanel.colPlatformAdmin")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("admin.organizationPanel.colWorkspaceRoles")}</th>
            </tr>
          </thead>
          <tbody>
            {data.members.map((m) => (
              <tr key={m.userId} className="border-t align-top">
                <td className="px-4 py-3">
                  <div className="font-medium">{m.name ?? m.email}</div>
                  <div className="text-xs text-muted-foreground">{m.email}</div>
                </td>
                <td className="px-4 py-3">
                  <Button
                    size="sm"
                    variant={m.isPlatformAdmin ? "outline" : "default"}
                    disabled={busyKey === `pa:${m.userId}`}
                    onClick={() => togglePlatformAdmin(m)}
                  >
                    {busyKey === `pa:${m.userId}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> :
                      m.isPlatformAdmin
                        ? <><ShieldOff className="mr-1.5 h-3.5 w-3.5" /> {t("admin.organizationPanel.revoke")}</>
                        : <><ShieldCheck className="mr-1.5 h-3.5 w-3.5" /> {t("admin.organizationPanel.grant")}</>}
                  </Button>
                </td>
                <td className="px-4 py-3">
                  <div className="grid gap-1.5">
                    {m.tenantRoles.map((tr) => (
                      <div key={tr.tenantId} className="flex items-center gap-2">
                        <span className="w-32 shrink-0 truncate text-xs text-muted-foreground" title={tr.tenantName}>{tr.tenantName}</span>
                        <Select
                          value={tr.role}
                          onValueChange={(v) => setRole(m.userId, tr.tenantId, v)}
                        >
                          <SelectTrigger className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {ROLE_OPTIONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
