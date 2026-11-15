"use client";
/**
 * PendingDeletionPanel — workspaces this admin has asked to delete that are still inside their grace period. They are
 * closed, so they can't be opened; this is where an admin of one (signed in through another workspace) cancels the
 * deletion or downloads the copy of its data. The server re-checks everything (POST /api/workspaces/:id/deletion/cancel).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Download, Loader2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n/LocaleContext";

export type PendingWorkspace = { id: string; name: string; purgeAt: string; daysLeft: number; exportId: string | null };

export function PendingDeletionPanel({ items }: { items: PendingWorkspace[] }) {
  const { t } = useT();
  const { push } = useToast();
  const router = useRouter();
  const { update } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  if (items.length === 0) return null;

  async function cancel(id: string) {
    setBusy(id);
    try {
      const res = await fetch(`/api/workspaces/${id}/deletion/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { push({ variant: "destructive", title: j?.error ?? "Failed" }); return; }
      push({ variant: "success", title: t("adminTenant.pendingCancelled") });
      await update({ refreshMemberships: true });
      router.refresh();
    } finally { setBusy(null); }
  }

  return (
    <section className="mb-8 space-y-3 rounded-lg border border-warning/40 bg-warning/5 p-5 shadow-xs">
      <p className="text-2xs font-semibold uppercase tracking-wider text-warning">{t("adminTenant.pendingHeading")}</p>
      {items.map((w) => (
        <div key={w.id} className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-xl text-sm text-muted-foreground">
            {t("adminTenant.pendingDesc").replace("{name}", w.name).replace("{date}", new Date(w.purgeAt).toLocaleDateString()).replace("{days}", String(w.daysLeft))}
          </p>
          <div className="flex gap-2">
            {w.exportId ? (
              <Button asChild variant="outline" size="sm">
                <a href={`/api/workspaces/${w.id}/exports/${w.exportId}`} download><Download className="mr-1.5 h-4 w-4" />{t("adminTenant.pendingDownload")}</a>
              </Button>
            ) : (
              <span className="self-center text-xs text-muted-foreground">{t("adminTenant.pendingExportPreparing")}</span>
            )}
            <Button size="sm" onClick={() => void cancel(w.id)} disabled={busy === w.id}>
              {busy === w.id ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Undo2 className="mr-1.5 h-4 w-4" />}
              {t("adminTenant.pendingCancel")}
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}
