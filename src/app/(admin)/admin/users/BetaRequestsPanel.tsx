"use client";
/**
 * BetaRequestsPanel — shown in Admin → Users below the user/role table.
 *
 * Displays pending beta-access requests submitted via the public landing
 * page "Request beta access" form. Admins can approve (mints a 24h magic
 * link + emails the requester), deny, or mark as spam.
 *
 * Initial data comes from the server (page.tsx passes initialRows so the
 * page doesn't flash a loader). Refresh re-fetches via the same API.
 */
import { useCallback, useState } from "react";
import { useT } from "@/lib/i18n/LocaleContext";
import {
  Loader2, Check, Ban, ShieldAlert, RefreshCw, Inbox, ChevronDown, ChevronUp, Copy, X, ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/lib/toast";

type WaitlistRow = {
  id: string;
  email: string;
  workspaceName: string | null;
  reason: string | null;
  source: string;
  status: string;
  createdAt: string;
};

type Props = {
  initialRows: WaitlistRow[];
  initialTotal: number;
};

export function BetaRequestsPanel({ initialRows, initialTotal }: Props) {
  const { t } = useT();
  const { push } = useToast();
  const [rows, setRows] = useState<WaitlistRow[]>(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [magicLink, setMagicLink] = useState<{ email: string; url: string } | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/users/beta-requests?pageSize=50", {
        credentials: "include",
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`Server returned ${r.status}`);
      const j = await r.json();
      setRows(Array.isArray(j.items) ? j.items : []);
      setTotal(j.total ?? 0);
    } catch (err: any) {
      push({ variant: "destructive", title: t("admin.betaRequests.refreshFailedTitle"), description: err?.message });
    } finally {
      setLoading(false);
    }
  }, [push, t]);

  async function act(id: string, action: "approve" | "deny" | "spam") {
    setBusyRow(id);
    try {
      const r = await fetch(`/api/admin/users/beta-requests/${id}/${action}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);

      if (action === "approve") {
        const link = j?.magicLinkUrl as string | undefined;
        if (link) {
          const abs = link.startsWith("http") ? link : window.location.origin + link;
          try { void navigator.clipboard?.writeText(abs); } catch { /* ignore */ }
          const emailOk = j?.emailStatus === "sent";
          if (emailOk) {
            push({ variant: "success", title: t("admin.betaRequests.approvedEmailSentTitle"), description: t("admin.betaRequests.approvedEmailSentDesc") });
          } else {
            // SMTP not configured — surface the link in the UI so admin can share it manually
            setMagicLink({ email: rows.find((r) => r.id === id)?.email ?? "", url: abs });
            push({ variant: "success", title: t("admin.betaRequests.approvedTitle"), description: t("admin.betaRequests.approvedNoSmtpDesc") });
          }
        } else {
          push({ variant: "success", title: t("admin.betaRequests.approvedTitle") });
        }
      } else if (action === "deny") {
        push({ title: t("admin.betaRequests.deniedTitle"), description: t("admin.betaRequests.deniedDesc") });
      } else {
        push({ variant: "destructive", title: t("admin.betaRequests.markedSpamTitle") });
      }

      // Optimistically remove the actioned row from the pending list.
      setRows((prev) => prev.filter((row) => row.id !== id));
      setTotal((prev) => Math.max(0, prev - 1));
    } catch (err: any) {
      push({ variant: "destructive", title: t("admin.betaRequests.actionFailedTitle"), description: err?.message ?? t("admin.betaRequests.tryAgainFallback") });
    } finally {
      setBusyRow(null);
    }
  }

  return (
    <section className="mt-10">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            {t("admin.betaRequests.title")}
            {total > 0 && (
              <span className="ml-2 rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning ">
                {t("admin.betaRequests.pendingBadge").replace("{n}", String(total))}
              </span>
            )}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t("admin.betaRequests.subtitle")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={reload}
          disabled={loading}
        >
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          {t("action.refresh")}
        </Button>
      </div>

      {magicLink && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-warning " />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-warning ">
              {t("admin.betaRequests.magicLinkForPrefix")} <span className="font-mono">{magicLink.email}</span>
            </p>
            <p className="mt-0.5 text-xs text-warning/80  mb-2">
              {t("admin.betaRequests.smtpNotConfigured")}
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-warning/10 px-2 py-1 text-xs font-mono text-warning  border border-warning/30">
                {magicLink.url}
              </code>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0 border-warning/40 text-warning hover:bg-warning/10 "
                onClick={() => { void navigator.clipboard?.writeText(magicLink.url); push({ title: t("admin.betaRequests.copiedToastTitle"), description: t("admin.betaRequests.copiedToastDesc") }); }}
              >
                <Copy className="h-3 w-3 mr-1" />
                {t("admin.betaRequests.copyButton")}
              </Button>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setMagicLink(null)}
            className="shrink-0 rounded p-0.5 text-warning hover:bg-warning/20 "
            aria-label={t("admin.betaRequests.dismissAriaLabel")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-6 py-14 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("admin.betaRequests.loading")}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-14 text-sm text-muted-foreground">
            <Inbox className="h-8 w-8 opacity-40" />
            <p>{t("admin.betaRequests.noPending")}</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs">
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">{t("admin.betaRequests.colEmail")}</th>
                <th className="px-4 py-2.5 font-medium">{t("admin.betaRequests.colWorkspace")}</th>
                <th className="px-4 py-2.5 font-medium">{t("admin.betaRequests.colReason")}</th>
                <th className="px-4 py-2.5 font-medium">{t("admin.betaRequests.colRequested")}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t("admin.betaRequests.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const busy = busyRow === row.id;
                const isExpanded = !!expanded[row.id];
                const reasonShort =
                  row.reason && row.reason.length > 80
                    ? row.reason.slice(0, 80) + "…"
                    : row.reason;

                return (
                  <tr
                    key={row.id}
                    className="border-b border-border last:border-b-0 align-top"
                  >
                    <td className="px-4 py-3 font-mono text-xs">{row.email}</td>
                    <td className="px-4 py-3 text-xs">
                      {row.workspaceName ?? (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {row.reason ? (
                        <button
                          type="button"
                          className="flex items-start gap-1 text-left text-foreground/80 hover:text-foreground"
                          onClick={() =>
                            setExpanded((s) => ({ ...s, [row.id]: !s[row.id] }))
                          }
                        >
                          <span className="max-w-xs">
                            {isExpanded ? row.reason : reasonShort}
                          </span>
                          {row.reason.length > 80 &&
                            (isExpanded ? (
                              <ChevronUp className="mt-0.5 h-3 w-3 shrink-0" />
                            ) : (
                              <ChevronDown className="mt-0.5 h-3 w-3 shrink-0" />
                            ))}
                        </button>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground tabular-nums">
                      {new Date(row.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => act(row.id, "approve")}
                          className="border-success/40 bg-success/5 text-success hover:bg-success/10 "
                        >
                          {busy ? (
                            <Loader2 className="pointer-events-none h-3 w-3 animate-spin" />
                          ) : (
                            <Check className="pointer-events-none h-3 w-3" />
                          )}
                          <span className="pointer-events-none ml-1">{t("admin.betaRequests.approveButton")}</span>
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => act(row.id, "deny")}
                        >
                          <Ban className="pointer-events-none h-3 w-3" />
                          <span className="pointer-events-none ml-1">{t("admin.betaRequests.denyButton")}</span>
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => act(row.id, "spam")}
                          className="border-destructive/40 bg-destructive/5 text-destructive hover:bg-destructive/10 "
                        >
                          <ShieldAlert className="pointer-events-none h-3 w-3" />
                          <span className="pointer-events-none ml-1">{t("admin.betaRequests.spamButton")}</span>
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
        <Copy className="h-3 w-3" />
        {t("admin.betaRequests.footerNote")}
      </p>
    </section>
  );
}
