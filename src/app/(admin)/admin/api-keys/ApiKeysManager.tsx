"use client";
import { useT } from "@/lib/i18n/LocaleContext";

import { useState } from "react";
import { KeyRound, Copy, Trash2, Loader2, Check, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/lib/toast";

type Key = {
  id: string;
  name: string;
  prefix: string;
  role: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  requestCount?: number;
  scopedReportIds?: string[] | null;
};
type ReportOpt = { id: string; name: string };

export function ApiKeysManager({ initial, reports }: { initial: Key[]; reports: ReportOpt[] }) {
  const { t } = useT();
  const { push } = useToast();
  const [keys, setKeys] = useState<Key[]>(initial);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"viewer" | "executive" | "developer" | "admin">("viewer");
  const [expiresInDays, setExpiresInDays] = useState<number | "">("");
  const [scopedReportIds, setScopedReportIds] = useState<string[]>([]);
  const [showScopePicker, setShowScopePicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastMinted, setLastMinted] = useState<{ token: string; prefix: string } | null>(null);

  function toggleScopedReport(id: string) {
    setScopedReportIds((xs) => xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]);
  }

  async function mint(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setLastMinted(null);
    try {
      const r = await fetch("/api/admin/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          role,
          expiresInDays: typeof expiresInDays === "number" ? expiresInDays : undefined,
          scopedReportIds: showScopePicker && scopedReportIds.length > 0 ? scopedReportIds : undefined,
        }),
      });
      if (!r.ok) {
        let msg = await r.text();
        try { msg = JSON.parse(msg).error ?? msg; } catch { /* keep text */ }
        push({ variant: "destructive", title: t("admin.apikeys.mintFailedTitle"), description: msg });
        return;
      }
      const body = await r.json();
      setKeys((xs) => [{
        ...body, lastUsedAt: null, revokedAt: null, requestCount: 0,
        scopedReportIds: showScopePicker && scopedReportIds.length > 0 ? scopedReportIds : null,
      }, ...xs]);
      setLastMinted({ token: body.token, prefix: body.prefix });
      setName("");
      setScopedReportIds([]);
      setShowScopePicker(false);
      push({ variant: "success", title: t("admin.apikeys.mintedToast").replace("{name}", body.name) });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(k: Key) {
    if (!confirm(t("admin.apikeys.confirmRevoke").replace("{name}", k.name))) return;
    const r = await fetch(`/api/admin/api-keys?id=${encodeURIComponent(k.id)}`, { method: "DELETE" });
    if (r.ok) {
      setKeys((xs) => xs.map((x) => (x.id === k.id ? { ...x, revokedAt: new Date().toISOString() } : x)));
    }
  }

  function copyToken() {
    if (!lastMinted) return;
    navigator.clipboard.writeText(lastMinted.token).then(() => {
      push({ variant: "success", title: t("admin.apikeys.tokenCopiedToast") });
    });
  }

  function mcpConnectCommand(token: string): string {
    const origin = typeof window !== "undefined" ? window.location.origin : "https://your-workspace.example";
    return `claude mcp add --transport http curf ${origin}/api/mcp --header "Authorization: Bearer ${token}"`;
  }

  function copyMcpCommand() {
    if (!lastMinted) return;
    navigator.clipboard.writeText(mcpConnectCommand(lastMinted.token)).then(() => {
      push({ variant: "success", title: t("admin.apikeys.mcpCommandCopiedToast") });
    });
  }

  return (
    <div className="grid gap-6">
      <section className="rounded-lg border bg-card p-5 shadow-xs">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("admin.apikeys.mintTitle")}
        </p>
        <form onSubmit={mint} className="grid gap-3 sm:grid-cols-[1fr_140px_140px_auto]">
          <div className="grid gap-1.5">
            <Label htmlFor="name">{t("admin.apikeys.labelField")}</Label>
            <Input id="name" placeholder={t("admin.apikeys.namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="grid gap-1.5">
            <Label>{t("admin.apikeys.roleLabel")}</Label>
            <Select value={role} onValueChange={(v) => setRole(v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="viewer">viewer</SelectItem>
                <SelectItem value="executive">executive</SelectItem>
                <SelectItem value="developer">developer</SelectItem>
                <SelectItem value="admin">admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="expires">{t("admin.apikeys.expiresLabel")}</Label>
            <Input
              id="expires" type="number" min={1} max={3650} placeholder={t("common.never")}
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value ? Number(e.target.value) : "")}
            />
          </div>
          <div className="flex items-end">
            <Button type="submit" size="sm" disabled={busy || !name.trim()}>
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <KeyRound className="mr-1.5 h-4 w-4" />}
              {t("admin.apikeys.mintButton")}
            </Button>
          </div>
        </form>

        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowScopePicker((v) => !v)}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium text-primary hover:underline"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            {showScopePicker ? t("admin.apikeys.fullTenantAccess") : t("admin.apikeys.restrictToReports")}
            {scopedReportIds.length > 0 && showScopePicker ? ` ${t("admin.apikeys.selectedSuffix").replace("{n}", String(scopedReportIds.length))}` : ""}
          </button>
          {showScopePicker && (
            <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-border bg-muted/20 p-2">
              {reports.length === 0 ? (
                <p className="p-2 text-[11px] text-muted-foreground">{t("admin.apikeys.noReports")}</p>
              ) : (
                reports.map((r) => (
                  <label key={r.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/60">
                    <input
                      type="checkbox"
                      checked={scopedReportIds.includes(r.id)}
                      onChange={() => toggleScopedReport(r.id)}
                    />
                    {r.name}
                  </label>
                ))
              )}
              <p className="mt-1 px-2 text-[10px] text-muted-foreground">
                {scopedReportIds.length === 0
                  ? t("admin.apikeys.hintNoneChecked")
                  : t("admin.apikeys.hintSomeChecked")
                      .replace("{n}", String(scopedReportIds.length))
                      .replace("{plural}", scopedReportIds.length === 1 ? "" : "s")}
              </p>
            </div>
          )}
        </div>

        {lastMinted && (
          <div className="mt-3 rounded-md border border-success/40 bg-success/5 p-3 text-xs">
            <div className="mb-1 font-medium text-success-foreground">
              {t("admin.apikeys.copyTokenNow")}
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded bg-background px-2 py-1 font-mono text-[11px]">{lastMinted.token}</code>
              <Button size="sm" variant="outline" onClick={copyToken}>
                <Copy className="mr-1.5 h-3.5 w-3.5" /> {t("admin.apikeys.copyButton")}
              </Button>
            </div>

            <div className="mt-3 border-t border-success/20 pt-3">
              <div className="mb-1 font-medium text-foreground">
                {t("admin.apikeys.mcpConnectTitle")}
              </div>
              <p className="mb-1.5 text-[11px] text-muted-foreground">{t("admin.apikeys.mcpConnectHint")}</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 overflow-x-auto whitespace-pre rounded bg-background px-2 py-1 font-mono text-[11px]">{mcpConnectCommand(lastMinted.token)}</code>
                <Button size="sm" variant="outline" onClick={copyMcpCommand}>
                  <Copy className="mr-1.5 h-3.5 w-3.5" /> {t("admin.apikeys.copyButton")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </section>

      <section>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("admin.apikeys.existingKeysTitle").replace("{n}", String(keys.length))}
        </p>
        <div className="overflow-x-auto rounded-lg border bg-card shadow-xs">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">{t("admin.apikeys.labelField")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("admin.apikeys.colPrefix")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("admin.apikeys.roleLabel")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("admin.apikeys.colScope")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("admin.apikeys.colCalls")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("admin.apikeys.colLastUsed")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("admin.apikeys.colStatus")}</th>
                <th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const revoked = !!k.revokedAt;
                const expired = !!(k.expiresAt && new Date(k.expiresAt) < new Date());
                return (
                  <tr key={k.id} className={`border-t ${revoked || expired ? "opacity-60" : ""}`}>
                    <td className="px-4 py-2.5 font-medium">{k.name}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{k.prefix}&hellip;</td>
                    <td className="px-4 py-2.5 text-xs uppercase">{k.role}</td>
                    <td className="px-4 py-2.5 text-xs">
                      {k.scopedReportIds && k.scopedReportIds.length > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-primary">
                          <ShieldCheck className="h-3 w-3" />{" "}
                          {t("admin.apikeys.reportsCount")
                            .replace("{n}", String(k.scopedReportIds.length))
                            .replace("{plural}", k.scopedReportIds.length === 1 ? "" : "s")}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{t("admin.apikeys.fullTenant")}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs tabular-nums text-muted-foreground">{k.requestCount ?? 0}</td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : t("common.never")}
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      {revoked ? <span className="text-destructive">{t("admin.apikeys.statusRevoked")}</span> :
                       expired ? <span className="text-destructive">{t("admin.apikeys.statusExpired")}</span> :
                       <span className="text-success"><Check className="inline h-3.5 w-3.5" /> {t("admin.apikeys.statusActive")}</span>}
                    </td>
                    <td className="px-2 py-2">
                      {!revoked && !expired && (
                        <Button size="icon" variant="ghost" onClick={() => revoke(k)} title={t("admin.apikeys.revokeTitle")}>
                          <Trash2 className="h-4 w-4 text-destructive/80" />
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {keys.length === 0 && (
                <tr><td colSpan={8} className="p-10 text-center text-xs text-muted-foreground">{t("admin.apikeys.empty")}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
