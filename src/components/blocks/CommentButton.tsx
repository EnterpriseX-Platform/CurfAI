"use client";
/**
 * Block-level comment threads — Notion / Figma / Linear-style discussions.
 *
 * Shape:
 *   - Each block in the report has its own slide-out drawer.
 *   - Comments form 1-deep threads: a top-level seed + N replies. We
 *     deliberately don't allow nested replies (replies-of-replies) — that
 *     UI gets unscannable fast and matches what every modern collab tool
 *     converged on.
 *   - Threads carry a resolved state. Resolving a thread collapses it
 *     (still visible, with a "Reopen" affordance).
 *   - @mentions: type "@" → autocomplete dropdown of tenant users. Picking
 *     one inserts `@Name` and stores their id in the comment's mentions[].
 *     The notification dispatcher (already running) emails mentioned users
 *     on top of the existing "anyone who's commented before" list.
 *
 * The drawer is fully client-side — no SSR — because it depends on
 * scroll-into-view + textarea focus + a draft-state state machine that
 * doesn't make sense to render on the server.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageCircle, Send, Check, Trash2, Loader2, X as CloseIcon, Reply, AtSign } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Author = { id: string; name: string | null; email: string };
type Comment = {
  id: string;
  blockId: string;
  body: string;
  resolvedAt: string | null;
  parentId: string | null;
  mentions: string[];
  createdAt: string;
  updatedAt: string;
  author: Author | null;
};

type Mentionable = { id: string; name: string | null; email: string };

export function CommentButton({
  reportId,
  blockId,
  proofHash,
}: {
  reportId: string;
  blockId: string;
  proofHash?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Lazy-load on first open. Refresh after every mutation so optimistic
  // updates aren't load-bearing — server is source of truth.
  const refresh = useCallback(async () => {
    const r = await fetch(`/api/reports/${reportId}/comments`, { cache: "no-store" });
    if (!r.ok) return;
    const { items } = await r.json();
    setComments((items as Comment[]).filter((c) => c.blockId === blockId));
    setLoaded(true);
  }, [reportId, blockId]);

  useEffect(() => {
    if (open && !loaded) void refresh();
  }, [open, loaded, refresh]);

  const unresolvedThreadCount = countUnresolvedThreads(comments);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="relative rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title={comments.length > 0 ? `${comments.length} comment${comments.length === 1 ? "" : "s"}` : "Comments"}
      >
        <MessageCircle className="h-3.5 w-3.5" />
        {unresolvedThreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-warning px-0.5 text-[9px] font-semibold leading-none text-white">
            {unresolvedThreadCount}
          </span>
        )}
      </button>

      {open && (
        <CommentDrawer
          reportId={reportId}
          blockId={blockId}
          proofHash={proofHash}
          comments={comments}
          loaded={loaded}
          onClose={() => setOpen(false)}
          onChanged={refresh}
        />
      )}
    </>
  );
}

/**
 * Slide-out panel listing threads on this block + a composer for a new
 * thread. Reply composers expand inline within each thread.
 */
function CommentDrawer({
  reportId, blockId, proofHash, comments, loaded, onClose, onChanged,
}: {
  reportId: string;
  blockId: string;
  proofHash?: string | null;
  comments: Comment[];
  loaded: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  // Pre-fetch the mention list once when the drawer opens. ~all the
  // workspace's users — small enough (<100) that a single GET is fine.
  const [mentionables, setMentionables] = useState<Mentionable[]>([]);
  useEffect(() => {
    fetch("/api/users/mentionable", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : { items: [] })
      .then((j) => setMentionables(j.items ?? []))
      .catch(() => {});
  }, []);

  // Portal-mount detection — `document` doesn't exist on the server, so
  // we wait until effects run (mounted=true) before rendering through
  // createPortal. Avoids the flicker of double-rendering during hydration.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Group into threads: { topLevelComment, replies[] }.
  const threads = (() => {
    const tops = comments.filter((c) => !c.parentId).sort((a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    return tops.map((t) => ({
      seed: t,
      replies: comments
        .filter((c) => c.parentId === t.id)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    }));
  })();

  // Body of the drawer. Pulled out so the conditional portal call stays
  // readable and the SSR-safe path renders nothing on the first frame.
  const body = (
    <div className="fixed inset-0 z-50 flex">
      <button
        type="button"
        className="flex-1 bg-foreground/30 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Close comments"
      />
      <aside className="flex h-full w-full max-w-md flex-col border-l border-border bg-background shadow-2xl shadow-black/20">
        <header className="flex items-start justify-between gap-2 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
              <MessageCircle className="h-3 w-3" /> Threads
            </p>
            <h3 className="mt-1 text-sm font-semibold">Comments on this block</h3>
            <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{blockId}</p>
          </div>
          <Button size="icon" variant="ghost" onClick={onClose}>
            <CloseIcon className="h-4 w-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {!loaded && (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading threads…
            </div>
          )}
          {loaded && threads.length === 0 && (
            <p className="rounded-md bg-muted/40 px-3 py-8 text-center text-xs text-muted-foreground">
              No comments yet. Start the first thread below.
            </p>
          )}
          <ul className="space-y-4">
            {threads.map((t) => (
              <Thread
                key={t.seed.id}
                reportId={reportId}
                seed={t.seed}
                replies={t.replies}
                mentionables={mentionables}
                onChanged={onChanged}
              />
            ))}
          </ul>
        </div>

        <NewThreadComposer
          reportId={reportId}
          blockId={blockId}
          proofHash={proofHash}
          mentionables={mentionables}
          onPosted={onChanged}
        />
      </aside>
    </div>
  );

  // Portal to <body> so the drawer escapes any ancestor with `transform`,
  // `contain`, or other containing-block triggers — including the small
  // BlockActions popover the trigger now lives inside. Without the portal,
  // the `fixed inset-0` resolves relative to the BlockActions container
  // and the drawer renders ~80px wide. Classic CSS gotcha.
  if (!mounted) return null;
  return createPortal(body, document.body);
}

// ---- Thread (one seed + N replies) -----------------------------------------

function Thread({
  reportId, seed, replies, mentionables, onChanged,
}: {
  reportId: string;
  seed: Comment;
  replies: Comment[];
  mentionables: Mentionable[];
  onChanged: () => Promise<void>;
}) {
  const [showReply, setShowReply] = useState(false);
  const resolved = !!seed.resolvedAt;

  async function toggleResolve() {
    await fetch(`/api/reports/${reportId}/comments/${seed.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolved: !resolved }),
    });
    await onChanged();
  }

  async function remove(c: Comment) {
    if (!confirm("Delete this comment?")) return;
    await fetch(`/api/reports/${reportId}/comments/${c.id}`, { method: "DELETE" });
    await onChanged();
  }

  return (
    <li className={cn(
      "rounded-lg border",
      resolved ? "border-dashed border-border/50 bg-muted/20" : "border-border bg-card",
    )}>
      <CommentRow comment={seed} onDelete={() => remove(seed)} dimmed={resolved} />

      {/* Replies — indented 24px on the left to anchor visually as a thread */}
      {replies.length > 0 && (
        <div className="border-t border-border/40 bg-muted/20">
          {replies.map((r) => (
            <CommentRow
              key={r.id}
              comment={r}
              onDelete={() => remove(r)}
              dimmed={resolved}
              indented
            />
          ))}
        </div>
      )}

      {/* Footer — Reply / Resolve actions */}
      <div className="flex items-center justify-between border-t border-border/40 bg-muted/30 px-3 py-1.5">
        <button
          type="button"
          onClick={() => setShowReply((v) => !v)}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Reply className="h-3 w-3" /> Reply
        </button>
        <button
          type="button"
          onClick={toggleResolve}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
            resolved ? "text-success hover:bg-success/10" : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <Check className="h-3 w-3" /> {resolved ? "Resolved · reopen" : "Resolve"}
        </button>
      </div>

      {showReply && (
        <ReplyComposer
          reportId={reportId}
          parentId={seed.id}
          blockId={seed.blockId}
          mentionables={mentionables}
          onPosted={async () => { await onChanged(); setShowReply(false); }}
          onCancel={() => setShowReply(false)}
        />
      )}
    </li>
  );
}

function CommentRow({
  comment, onDelete, dimmed, indented,
}: {
  comment: Comment;
  onDelete: () => void;
  dimmed?: boolean;
  indented?: boolean;
}) {
  const initials = (comment.author?.name ?? comment.author?.email ?? "?")
    .split(/\s+/).map((s) => s[0]?.toUpperCase()).slice(0, 2).join("");
  return (
    <div className={cn(
      "flex items-start gap-3 px-3 py-2.5",
      indented && "pl-9 border-l-2 border-primary/10 ml-4",
      dimmed && "opacity-70",
    )}>
      <Avatar initials={initials} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2 text-[11px]">
          <span className="font-medium text-foreground">
            {comment.author?.name ?? comment.author?.email ?? "Unknown"}
          </span>
          <span className="shrink-0 text-muted-foreground">{shortAgo(comment.createdAt)}</span>
        </div>
        <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
          {/* Minimal mention rendering — bold text after @ until the next
              whitespace. Full rendering with linked profiles can come in
              a Stage 2 polish; this gets us the visual hint cheaply. */}
          {renderBodyWithMentions(comment.body)}
        </p>
        <div className="mt-1 flex items-center justify-end">
          <button
            type="button"
            onClick={onDelete}
            title="Delete"
            className="rounded p-0.5 text-destructive/60 hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}

function Avatar({ initials }: { initials: string }) {
  // Stable color from the initials so two users with the same letters
  // get the same avatar — recognisable across threads. Hash → hue.
  let h = 0;
  for (const ch of initials) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const hue = Math.abs(h) % 360;
  return (
    <span
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
      style={{ background: `hsl(${hue}, 60%, 45%)` }}
    >
      {initials || "?"}
    </span>
  );
}

// ---- Composers --------------------------------------------------------------

function NewThreadComposer({
  reportId, blockId, proofHash, mentionables, onPosted,
}: {
  reportId: string;
  blockId: string;
  proofHash?: string | null;
  mentionables: Mentionable[];
  onPosted: () => Promise<void>;
}) {
  return (
    <Composer
      reportId={reportId}
      blockId={blockId}
      proofHash={proofHash}
      mentionables={mentionables}
      placeholder="Start a new thread on this block. Type @ to mention someone…"
      submitLabel="Post"
      bottom
      onPosted={onPosted}
    />
  );
}

function ReplyComposer({
  reportId, parentId, blockId, mentionables, onPosted, onCancel,
}: {
  reportId: string;
  parentId: string;
  blockId: string;
  mentionables: Mentionable[];
  onPosted: () => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <Composer
      reportId={reportId}
      blockId={blockId}
      parentId={parentId}
      mentionables={mentionables}
      placeholder="Write a reply… type @ to mention"
      submitLabel="Reply"
      onPosted={onPosted}
      onCancel={onCancel}
      autoFocus
      compact
    />
  );
}

function Composer({
  reportId, blockId, parentId, proofHash, mentionables, placeholder, submitLabel,
  onPosted, onCancel, autoFocus, compact, bottom,
}: {
  reportId: string;
  blockId: string;
  parentId?: string;
  proofHash?: string | null;
  mentionables: Mentionable[];
  placeholder: string;
  submitLabel: string;
  onPosted: () => Promise<void>;
  onCancel?: () => void;
  autoFocus?: boolean;
  compact?: boolean;
  bottom?: boolean;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [mentions, setMentions] = useState<string[]>([]);
  const [picker, setPicker] = useState<null | { query: string; index: number }>(null);

  // Detect "@" at cursor — open the picker. We track the slice from "@"
  // to the current caret as the live query so the user can type "@bo" and
  // narrow the dropdown to "Bob" / "Bobby".
  function onKeyUp() {
    const ta = taRef.current;
    if (!ta) return;
    const value = ta.value;
    const caret = ta.selectionStart ?? value.length;
    // Find the "@" closest to the caret on the left, with no whitespace between.
    const before = value.slice(0, caret);
    const at = before.lastIndexOf("@");
    if (at === -1) { setPicker(null); return; }
    const between = before.slice(at + 1);
    if (/\s/.test(between)) { setPicker(null); return; }
    setPicker({ query: between.toLowerCase(), index: at });
  }

  function pickMention(u: Mentionable) {
    if (!picker) return;
    const ta = taRef.current!;
    const display = "@" + (u.name?.replace(/\s/g, "") ?? u.email.split("@")[0]);
    const before = ta.value.slice(0, picker.index);
    const after  = ta.value.slice(ta.selectionStart ?? ta.value.length);
    const next = `${before}${display} ${after}`;
    setDraft(next);
    setMentions((xs) => Array.from(new Set([...xs, u.id])));
    setPicker(null);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = before.length + display.length + 1;
      ta.setSelectionRange(pos, pos);
    });
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    try {
      const r = await fetch(`/api/reports/${reportId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          blockId,
          body: text,
          parentId: parentId ?? undefined,
          mentions,
          proofHash: proofHash ?? undefined,
        }),
      });
      if (r.ok) {
        setDraft("");
        setMentions([]);
        await onPosted();
      }
    } finally {
      setSending(false);
    }
  }

  // Filter the mention list against the live query. Capped at 8 visible
  // matches — keeps the picker UI scannable.
  const matches = picker
    ? mentionables
        .filter((u) => {
          const q = picker.query;
          return (u.name ?? "").toLowerCase().includes(q) || (u.email ?? "").toLowerCase().includes(q);
        })
        .slice(0, 8)
    : [];

  return (
    <form
      onSubmit={submit}
      className={cn(
        "relative",
        bottom && "border-t border-border bg-muted/30",
        compact && "border-t border-border/40 bg-background",
      )}
    >
      <div className={cn("relative", bottom ? "p-3" : "px-3 py-2")}>
        <textarea
          ref={taRef}
          autoFocus={autoFocus}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyUp={onKeyUp}
          onClick={onKeyUp}
          placeholder={placeholder}
          className={cn(
            "w-full resize-y rounded-md border border-input bg-background p-2 text-sm",
            compact ? "min-h-[56px]" : "min-h-[72px]",
          )}
          maxLength={5000}
        />
        {/* Mention picker — anchored above the textarea so it doesn't get
            cut off by the panel bottom. We position absolutely with a
            margin-bottom so it floats just above the input. */}
        {picker && matches.length > 0 && (
          <ul
            className="absolute z-10 mt-1 max-h-56 w-[min(280px,90%)] overflow-y-auto rounded-md border border-border bg-background shadow-lg"
            style={{ bottom: bottom ? "calc(100% - 0.5rem)" : "calc(100% + 0.25rem)", left: "0.75rem" }}
          >
            {matches.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickMention(u)}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-muted"
                >
                  <Avatar initials={(u.name ?? u.email).slice(0, 2).toUpperCase()} />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{u.name ?? u.email}</span>
                    {u.name && <span className="block truncate text-[10px] text-muted-foreground">{u.email}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className={cn(
        "flex items-center justify-between gap-2 px-3",
        bottom ? "pb-3" : "pb-2",
      )}>
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <AtSign className="h-3 w-3" /> @ to mention {mentions.length > 0 && <>· {mentions.length}</>}
        </span>
        <div className="flex items-center gap-1">
          {onCancel && (
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
          )}
          <Button type="submit" size="sm" disabled={sending || !draft.trim()}>
            {sending ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Send className="mr-1.5 h-3 w-3" />}
            {submitLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}

// ---- Helpers ---------------------------------------------------------------

function renderBodyWithMentions(body: string): React.ReactNode {
  // Split on @-mention tokens (@Name or @Name.Last). We don't validate
  // against the mentions[] list — the visual cue is enough; the
  // notification routing is what consumes the structured ids.
  const parts = body.split(/(@[A-Za-z0-9_.\-]+)/g);
  return parts.map((p, i) =>
    p.startsWith("@")
      ? <span key={i} className="font-semibold text-primary">{p}</span>
      : <span key={i}>{p}</span>
  );
}

function countUnresolvedThreads(comments: Comment[]): number {
  // Only count top-level seeds whose resolvedAt is null. Replies inherit
  // the seed's resolved state visually so we don't double-count them.
  return comments.filter((c) => !c.parentId && !c.resolvedAt).length;
}

function shortAgo(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}
