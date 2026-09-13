"use client";
import { useState } from "react";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/lib/toast";

/**
 * Super-confirm destructive dialog. The Delete button arms only when the user
 * types the report name exactly (case-sensitive). This pattern comes straight
 * from GitHub / Vercel / Stripe etc. — it forces a deliberate pause.
 */
export function DeleteReportDialog({
  reportId, reportName, onClose, onDeleted,
}: {
  reportId: string;
  reportName: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { push } = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const armed = typed.trim() === reportName;

  async function doDelete() {
    setBusy(true);
    try {
      const r = await fetch(`/api/reports/${reportId}`, { method: "DELETE" });
      if (!r.ok) {
        let msg = await r.text();
        try { msg = JSON.parse(msg).error ?? msg; } catch { /* keep text */ }
        push({ variant: "destructive", title: "Delete failed", description: msg });
        return;
      }
      push({ variant: "success", title: "Report deleted" });
      onDeleted();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader className="border-b-0 p-6 pb-3">
          <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <DialogTitle>Delete this report?</DialogTitle>
          <DialogDescription>
            This permanently deletes <span className="font-semibold text-foreground">{reportName}</span> and its run history.
            This action <span className="font-semibold text-foreground">cannot be undone</span>.
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-4">
          <Label className="mb-1.5 block">
            To confirm, type the report name: <span className="font-mono text-foreground">{reportName}</span>
          </Label>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={reportName}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-6 py-4">
          <DialogClose asChild>
            <Button variant="ghost" size="sm" disabled={busy}>Cancel</Button>
          </DialogClose>
          <Button
            variant="destructive"
            size="sm"
            onClick={doDelete}
            disabled={!armed || busy}
          >
            {busy
              ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Deleting…</>
              : <><Trash2 className="mr-1.5 h-4 w-4" /> Delete report</>}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
