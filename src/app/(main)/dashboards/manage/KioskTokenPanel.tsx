"use client";
import { useT } from "@/lib/i18n/LocaleContext";

/**
 * Kiosk-token management panel for one dashboard. Shown inside the
 * DashboardsManager edit form when an admin is editing an existing
 * dashboard. Lets them:
 *
 *   - Mint a new token (with optional label and expiry). The cleartext
 *     token + its kiosk URL are shown EXACTLY ONCE in a green banner;
 *     dismissing the banner removes it from memory.
 *   - List active (non-revoked) tokens with their label, expiry, last-used
 *     timestamp.
 *   - Revoke any token (soft-delete). The row disappears from the list but
 *     the audit trail in the DB persists.
 *
 * Each token grants unauthenticated read-only access to the dashboard via
 * /dashboards/[slug]/kiosk?token=… — wall-display use case.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2, Copy, Check, RefreshCw } from "lucide-react";
import { useToast } from "@/lib/toast";

type KioskToken = {
  id: string;
  label: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

type FreshToken = {
  id: string;
  token: string;
  kioskUrl: string;
  label: string | null;
};

export function KioskTokenPanel({
  dashboardId,
  initialTokens,
  apiBase = "/api/dashboards",
}: {
  dashboardId: string;
  initialTokens: KioskToken[];
  /** Lets OnScreenManager reuse this panel against /api/on-screen instead of forking it. */
  apiBase?: string;
}) {
  const { t } = useT();
  const { push } = useToast();
  const [tokens, setTokens] = useState<KioskToken[]>(initialTokens);
  const [fresh, setFresh] = useState<FreshToken | null>(null);
  const [copied, setCopied] = useState(false);
  // Mint-form state
  const [label, setLabel] = useState("");
  // Empty string = never expires. The Mint POST converts this to null.
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);

  // When the parent flips to a different dashboard the cached token list is
  // stale — refetch instead of re-using initialTokens.
  useEffect(() => { setTokens(initialTokens); setFresh(null); setCopied(false); }, [dashboardId, initialTokens]);

  async function refresh() {
    const r = await fetch(`${apiBase}/${dashboardId}/kiosk-tokens`).then((r) => r.json());
    setTokens(r.items ?? []);
  }

  async function mint() {
    setBusy(true);
    try {
      const body: any = {};
      if (label.trim()) body.label = label.trim();
      // Convert local datetime-local input → full ISO so zod's .datetime() is happy.
      if (expiresAt) body.expiresAt = new Date(expiresAt).toISOString();
      const r = await fetch(`${apiBase}/${dashboardId}/kiosk-tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await r.json();
      if (!r.ok) {
        push({ variant: "destructive", title: t("dashboards.tokens.mintFailed"), description: json.error ?? r.statusText });
        return;
      }
      setFresh(json);
      setLabel(""); setExpiresAt("");
      // Reload list so the new (non-cleartext) row appears.
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(tokenId: string, tokenLabel: string | null) {
    const confirmMsg = tokenLabel
      ? t("dashboards.tokens.confirmRevokeNamed").replace("{label}", tokenLabel)
      : t("dashboards.tokens.confirmRevokeGeneric");
    if (!confirm(confirmMsg)) return;
    const r = await fetch(`${apiBase}/${dashboardId}/kiosk-tokens/${tokenId}`, { method: "DELETE" });
    if (!r.ok) {
      push({ variant: "destructive", title: t("dashboards.tokens.revokeFailed"), description: await r.text() });
      return;
    }
    push({ variant: "success", title: t("dashboards.tokens.revoked") });
    await refresh();
  }

  async function copyUrl() {
    if (!fresh) return;
    const fullUrl = window.location.origin + fresh.kioskUrl;
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      push({ variant: "destructive", title: t("dashboards.tokens.copyFailed") });
    }
  }

  return (
    <div className="grid gap-3">
      {/* Fresh-token banner — shown ONCE after mint. */}
      {fresh && (
        <div className="rounded-md border border-success/40 bg-success/5 p-3 text-xs">
          <div className="mb-1 font-medium">
            {t("dashboards.tokens.mintedPrefix")}{fresh.label ? ` — "${fresh.label}"` : ""}.
            {" "}{t("dashboards.tokens.mintedCopyHint")}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 select-all overflow-x-auto rounded border border-border bg-background px-2 py-1.5 font-mono text-[11px]">
              {typeof window !== "undefined" ? window.location.origin : ""}{fresh.kioskUrl}
            </code>
            <Button size="sm" variant="outline" onClick={copyUrl}>
              {copied ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
              {copied ? t("dashboards.tokens.copied") : t("dashboards.tokens.copy")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setFresh(null); setCopied(false); }}>
              {t("watchers.dismiss")}
            </Button>
          </div>
        </div>
      )}

      {/* Mint form. */}
      <div className="grid gap-2 rounded-md border border-dashed border-border/80 p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("dashboards.tokens.mintHeading")}</p>
        <p className="text-xs text-muted-foreground">
          {t("dashboards.tokens.mintDesc")}
        </p>
        <div className="grid grid-cols-[1fr_220px_auto] gap-2">
          <F label={`${t("opTemplates.label")} ${t("common.optional")}`}>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("dashboards.tokens.labelPlaceholder")} />
          </F>
          <F label={`${t("dashboards.tokens.expiresField")} ${t("common.optional")}`}>
            <Input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </F>
          <div className="flex items-end">
            <Button size="sm" onClick={mint} disabled={busy}>
              <Plus className="mr-1.5 h-4 w-4" />
              {busy ? t("dashboards.tokens.minting") : t("dashboards.tokens.mint")}
            </Button>
          </div>
        </div>
      </div>

      {/* Active token list. */}
      <div className="overflow-hidden rounded-md border bg-card">
        <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
          <p className="text-xs font-medium text-muted-foreground">
            {t("dashboards.tokens.activeCount").replace("{n}", String(tokens.length)).replace("{plural}", tokens.length === 1 ? "" : "s")}
          </p>
          <Button size="sm" variant="ghost" onClick={refresh}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> {t("action.refresh")}
          </Button>
        </div>
        <table className="w-full text-xs">
          <thead className="bg-muted/20 text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">{t("opTemplates.label")}</th>
              <th className="px-3 py-1.5 text-left font-medium">{t("dashboards.tokens.colExpires")}</th>
              <th className="px-3 py-1.5 text-left font-medium">{t("dashboards.tokens.colLastUsed")}</th>
              <th className="px-3 py-1.5 text-left font-medium">{t("templateAnalytics.legendCreated")}</th>
              <th className="w-12" />
            </tr>
          </thead>
          <tbody>
            {tokens.map((tok) => (
              <tr key={tok.id} className="border-t">
                <td className="px-3 py-1.5 font-medium">{tok.label ?? <span className="italic text-muted-foreground">{t("dashboards.tokens.unlabelled")}</span>}</td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {tok.expiresAt ? new Date(tok.expiresAt).toLocaleString() : <span className="italic">{t("common.never")}</span>}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {tok.lastUsedAt ? new Date(tok.lastUsedAt).toLocaleString() : <span className="italic">{t("common.never")}</span>}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {new Date(tok.createdAt).toLocaleString()}
                </td>
                <td className="px-2 py-1">
                  <Button
                    size="icon" variant="ghost"
                    onClick={() => revoke(tok.id, tok.label)}
                    title={t("dashboards.tokens.revokeTooltip")}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive/80" />
                  </Button>
                </td>
              </tr>
            ))}
            {tokens.length === 0 && (
              <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">{t("dashboards.tokens.empty")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}
