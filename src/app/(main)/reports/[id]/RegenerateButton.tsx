"use client";
/**
 * "Regenerate from comments" button for the report viewer toolbar.
 *
 * On click, opens a modal that lists the report's unresolved comments,
 * lets the user add an optional refinement prompt, and POSTs to
 * /api/reports/[id]/regenerate. On success we hard-reload the page so the
 * fresh definition + dataset render top-to-bottom (and the comments roll
 * forward to the new version).
 *
 * The button is opt-in for editor and admin roles — viewers don't see it.
 * The badge shows the count of unresolved comments so the affordance is
 * visible even when the user hasn't opened the side panel.
 */
import { useEffect, useRef, useState } from "react";
import { Sparkles, X as CloseIcon, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/lib/toast";
import { useEscapeAndFocusTrap } from "@/hooks/useEscapeAndFocusTrap";

type CommentRow = {
  id: string;
  blockId: string;
  cellKey: string | null;
  body: string;
  resolvedAt: string | null;
  authorEmail: string | null;
  authorName: string | null;
  createdAt: string;
};

export function RegenerateButton({ reportId }: { reportId: string }) {
  const { push } = useToast();
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [extra, setExtra] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  useEscapeAndFocusTrap(open, () => setOpen(false), modalRef);

  const unresolved = comments.filter((c) => !c.resolvedAt);

  // Lightweight count poll on mount — same endpoint feeds the modal so we
  // only fetch once. The catalog comment-notification badge already handles
  // unread state separately, so we just want a quick "are there comments to
  // refine against" total here.
  useEffect(() => {
    let cancel = false;
    fetch(`/api/reports/${reportId}/comments`).then((r) => r.ok ? r.json() : { items: [] })
      .then((j) => { if (!cancel) setComments((j.items ?? []) as CommentRow[]); })
      .catch(() => { /* ignore — button just won't show a count */ });
    return () => { cancel = true; };
  }, [reportId]);

  // Refresh when modal opens to catch comments added in another tab.
  async function refreshComments() {
    setLoading(true);
    try {
      const r = await fetch(`/api/reports/${reportId}/comments`).then((r) => r.json());
      setComments((r.items ?? []) as CommentRow[]);
    } finally { setLoading(false); }
  }

  function handleOpen() {
    setOpen(true);
    setExtra("");
    refreshComments();
  }

  async function regenerate() {
    setSubmitting(true);
    try {
      const r = await fetch(`/api/reports/${reportId}/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          extraPrompt: extra.trim() || undefined,
        }),
      });
      const json = await r.json();
      if (!r.ok) {
        push({
          variant: "destructive",
          title: "Regenerate failed",
          description: json.error ?? r.statusText,
        });
        return;
      }
      push({
        variant: "success",
        title: "Report refined",
        description: `Refined using ${json.commentsConsumed} comment${json.commentsConsumed === 1 ? "" : "s"} — now at version ${json.version}.`,
      });
      setOpen(false);
      // Hard reload so the runner picks up the new definition + every block
      // re-renders against the refined queries.
      window.location.reload();
    } finally {
      setSubmitting(false);
    }
  }

  const canRegenerate = unresolved.length > 0 || extra.trim().length > 0;

  return (
    <>
      <Button
        size="sm" variant="ghost" onClick={handleOpen}
        title={unresolved.length > 0
          ? `Refine this report based on ${unresolved.length} unresolved comment${unresolved.length === 1 ? "" : "s"}`
          : "Open a refinement prompt for the AI"}
        className="w-full justify-start gap-2 font-normal"
      >
        {/* Rendered as a row inside the report header's "more tools" popover. */}
        <Sparkles className="h-4 w-4 text-primary" />
        Regenerate
        {unresolved.length > 0 && (
          <span className="ml-auto font-mono text-xs text-faint">
            {unresolved.length}
          </span>
        )}
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/40 p-4" onClick={() => !submitting && setOpen(false)}>
          <div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between border-b px-5 py-3">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold">Regenerate from comments</h2>
              </div>
              <Button size="icon" variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>
                <CloseIcon className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex-1 grid gap-4 overflow-y-auto p-5">
              <p className="text-xs text-muted-foreground">
                The AI reads the current report alongside the comments below, then returns a refined definition. The previous version is saved automatically — you can roll back from <span className="font-medium">History</span>.
              </p>

              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Unresolved comments ({unresolved.length})
                </p>
                <div className="max-h-56 overflow-y-auto rounded-md border bg-card">
                  {loading ? (
                    <div className="grid place-items-center p-6 text-xs text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                    </div>
                  ) : unresolved.length === 0 ? (
                    <div className="p-6 text-center text-xs italic text-muted-foreground">
                      No unresolved comments. Use the prompt below to direct the AI instead.
                    </div>
                  ) : (
                    unresolved.map((c) => (
                      <div key={c.id} className="border-b border-border/60 px-3 py-2 text-xs last:border-b-0">
                        <div className="text-muted-foreground">
                          <span className="font-mono text-[10px]">{c.blockId.slice(0, 8)}</span>
                          {c.cellKey && <span className="ml-1 font-mono text-[10px] text-muted-foreground/70">cell={c.cellKey}</span>}
                          <span className="ml-2">{c.authorName || c.authorEmail || "anon"}</span>
                          <span className="ml-2 text-muted-foreground/70">{new Date(c.createdAt).toLocaleString()}</span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap text-foreground">{c.body}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Extra direction (optional)
                </p>
                <textarea
                  className="min-h-[80px] w-full rounded-md border border-input bg-background p-2 text-xs"
                  value={extra}
                  onChange={(e) => setExtra(e.target.value)}
                  placeholder='e.g. "Drop the bar chart at the top and lead with the KPIs."'
                  disabled={submitting}
                />
              </div>

              {!canRegenerate && (
                <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning  ">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5" />
                  <span>Add at least one comment or some extra direction before regenerating — there's nothing for the AI to act on otherwise.</span>
                </div>
              )}
            </div>

            <div className="flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3">
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button size="sm" onClick={regenerate} disabled={submitting || !canRegenerate}>
                {submitting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
                {submitting ? "Refining…" : "Regenerate"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
