"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n/LocaleContext";

/**
 * Danger Zone — permanently delete the current workspace. Only an admin of
 * THIS workspace sees any effect (the API re-checks server-side regardless
 * of what's rendered here); a caller with no other workspace to fall back
 * to never even gets the button, since deleting their only membership would
 * strand the account.
 */
export function DeleteWorkspacePanel({
  tenant,
  otherWorkspaceCount,
  fallbackTenantId,
}: {
  tenant: { id: string; name: string; slug: string };
  /** Real (non-virtual) memberships this user holds elsewhere — 0 means this is their only workspace. */
  otherWorkspaceCount: number;
  /** First other real membership's tenant id — where to land the session after deleting the active one. */
  fallbackTenantId?: string;
}) {
  const { t } = useT();
  const { push } = useToast();
  const router = useRouter();
  const { update } = useSession();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  const canDelete = otherWorkspaceCount > 0;

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/workspaces/${tenant.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmSlug: confirmText.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        push({
          variant: "destructive",
          title: t("adminTenant.deleteFailedTitle"),
          description: json?.error ?? t("adminTenant.deleteFailedGeneric"),
        });
        return;
      }
      push({ variant: "success", title: t("adminTenant.deleteSuccess") });
      // The active tenant no longer exists — refreshMemberships alone drops
      // the deleted one from the switcher's list but leaves the session's
      // activeTenantId pointing at a tenant that's now gone (every
      // subsequent request 404s until the user manually switches). Both
      // flags go in ONE update() call, not two sequential ones: the JWT
      // callback's activeTenantId switch looks up `fallbackTenantId`
      // against the token's CURRENT memberships, which already contains it
      // (deleting a tenant only removes one, never adds a new one) — so
      // there's no ordering dependency on refreshMemberships within this
      // same call, and no risk of the second of two separate client-side
      // update() calls reading a not-yet-persisted cookie from the first.
      await update({ refreshMemberships: true, activeTenantId: fallbackTenantId });
      setOpen(false);
      router.push("/reports");
      router.refresh();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="mb-8 rounded-lg border border-destructive/30 bg-destructive/5 p-5 shadow-xs">
      <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-destructive">
        <AlertTriangle className="h-3.5 w-3.5" /> {t("adminTenant.dangerZone")}
      </p>
      <p className="mb-3 text-sm text-muted-foreground">
        {t("adminTenant.deleteWarning").replace("{name}", tenant.name)}
      </p>
      {!canDelete && (
        <p className="mb-3 text-xs text-muted-foreground italic">
          {t("adminTenant.deleteOnlyWorkspace")}
        </p>
      )}
      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={!canDelete}
        onClick={() => setOpen(true)}
      >
        <Trash2 className="mr-1.5 h-4 w-4" /> {t("adminTenant.deleteButton")}
      </Button>

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setConfirmText(""); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("adminTenant.deleteDialogTitle").replace("{name}", tenant.name)}</DialogTitle>
            <DialogDescription>
              {t("adminTenant.deleteDialogDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Label htmlFor="confirm-slug">
              {t("adminTenant.deleteConfirmLabel").replace("{slug}", tenant.slug)}
            </Label>
            <Input
              id="confirm-slug"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && confirmText === tenant.slug && !deleting) void handleDelete(); }}
              placeholder={tenant.slug}
              autoFocus
              className="font-mono"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={deleting}>
              {t("action.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={deleting || confirmText !== tenant.slug}
            >
              {deleting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1.5 h-4 w-4" />}
              {t("adminTenant.deletePermanently")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
