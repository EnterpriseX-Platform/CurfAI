"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogIcon, DialogTitle } from "@/components/ui/dialog";

/**
 * The console's yes/no question, in the page. The browser's own confirm() is not available everywhere
 * (embedded panes and some browsers block it and answer "no", so a button silently does nothing), cannot
 * be styled, and cannot be translated beyond its message. The words come in as props: this component has
 * no dictionary of its own.
 */
export function ConfirmDialog({ title, message, confirmLabel, cancelLabel, destructive = false, onConfirm, onCancel }: {
  title: string;
  /** Optional detail under the title; line breaks are kept. */
  message?: string;
  confirmLabel: string;
  cancelLabel: string;
  /** The confirm button reads as a loss (discarding work) rather than as a normal action. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="max-w-md" data-testid="engine-confirm">
        <DialogHeader>
          <DialogIcon variant={destructive ? "danger" : "warning"}><AlertTriangle className="h-4 w-4" aria-hidden="true" /></DialogIcon>
          <div>
            <DialogTitle>{title}</DialogTitle>
            {message ? <DialogDescription className="whitespace-pre-line">{message}</DialogDescription> : null}
          </div>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} autoFocus>{cancelLabel}</Button>
          <Button type="button" variant={destructive ? "destructive" : "default"} onClick={onConfirm}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
