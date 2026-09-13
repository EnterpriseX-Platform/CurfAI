"use client";
/**
 * ChartPinOverlay — click-to-pin annotations on top of any chart block.
 *
 * Purpose:
 *   Lets a viewer click anywhere on a chart and drop a tiny "comment pin" at
 *   that exact spot. The pin opens a single-thread mini drawer; replies and
 *   resolution flow through the existing /comments API.
 *
 * Storage:
 *   We piggyback on the existing Comment model. Pin coords are encoded into
 *   `cellKey` as `pin:<xPct>,<yPct>` (4-decimal precision — sub-pixel on a
 *   2k display). No schema migration required, which is the whole point —
 *   shipping a new feature without asking the user to run prisma db push
 *   keeps iteration fast.
 *
 * Layout:
 *   The overlay sits as an absolutely-positioned layer above the chart's
 *   render area. It captures pointer events ONLY when pin-mode is on, so
 *   normal chart interactions (drill-through, hover tooltips) keep working
 *   the rest of the time. Existing pins are rendered with `pointer-events:auto`
 *   even outside pin-mode so they're always clickable.
 *
 *   Coords are stored as relative percentages (0–1) of the overlay's bounding
 *   box, so resizing the chart preserves the pin position. This is the same
 *   trick Figma / Miro use for sticky annotations.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapPin, MessageCircle, Send, Check, X, Loader2, Trash2 } from "lucide-react";

type PinComment = {
  id: string;
  blockId: string;
  cellKey: string | null;
  body: string;
  resolvedAt: string | null;
  parentId: string | null;
  createdAt: string;
  author: { id: string; name: string | null; email: string } | null;
};

type Pin = {
  cellKey: string;       // canonical "pin:x,y"
  xPct: number;          // 0..1
  yPct: number;          // 0..1
  threadCount: number;   // total comments in thread
  unresolved: boolean;   // is the seed unresolved?
  seedId: string | null; // first comment id for delete/resolve
};

const PIN_PREFIX = "pin:";

export function ChartPinOverlay({
  reportId,
  blockId,
}: {
  reportId: string;
  blockId: string;
}) {
  const [pinMode, setPinMode] = useState(false);
  const [comments, setComments] = useState<PinComment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [composer, setComposer] = useState<null | { xPct: number; yPct: number }>(null);
  const [openPin, setOpenPin] = useState<string | null>(null); // cellKey of open thread
  const containerRef = useRef<HTMLDivElement>(null);

  // Lazy first-load. Re-fetch after every mutation so we stay consistent with
  // what other viewers might have added.
  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/reports/${reportId}/comments`, { cache: "no-store", credentials: "include" });
      if (!r.ok) return;
      const j = await r.json();
      const items: PinComment[] = (j.items ?? []).filter((c: PinComment) =>
        c.blockId === blockId && c.cellKey?.startsWith(PIN_PREFIX),
      );
      setComments(items);
      setLoaded(true);
    } catch {
      /* keep stale state — overlay still works for placing new pins */
    }
  }, [reportId, blockId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Group flat comment list into pins keyed by their cellKey ("pin:x,y").
  const pins: Pin[] = useMemo(() => {
    const map = new Map<string, PinComment[]>();
    for (const c of comments) {
      if (!c.cellKey) continue;
      const arr = map.get(c.cellKey) ?? [];
      arr.push(c);
      map.set(c.cellKey, arr);
    }
    const out: Pin[] = [];
    for (const [key, arr] of map.entries()) {
      const coords = parsePin(key);
      if (!coords) continue;
      const seed = arr.find((c) => !c.parentId) ?? arr[0];
      out.push({
        cellKey: key,
        xPct: coords.x,
        yPct: coords.y,
        threadCount: arr.length,
        unresolved: !seed.resolvedAt,
        seedId: seed?.id ?? null,
      });
    }
    return out;
  }, [comments]);

  function onOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!pinMode) return;
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return;
    const x = (e.clientX - box.left) / box.width;
    const y = (e.clientY - box.top) / box.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    setComposer({ xPct: round(x), yPct: round(y) });
  }

  async function postPin(body: string) {
    if (!composer) return;
    const cellKey = `${PIN_PREFIX}${composer.xPct},${composer.yPct}`;
    const r = await fetch(`/api/reports/${reportId}/comments`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blockId, cellKey, body }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(j?.error ?? "Failed to post pin");
      return;
    }
    setComposer(null);
    setPinMode(false);
    await refresh();
    setOpenPin(cellKey);
  }

  return (
    // pointer-events-none on the wrapper means existing chart interactions
    // (drill, hover) pass through. Children selectively re-enable events.
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-0 z-20"
      onClick={onOverlayClick}
      style={{ pointerEvents: pinMode || composer ? "auto" : "none" }}
    >
      {/* Pin-mode toggle — sits in the BOTTOM-left of the chart so it
          never collides with the chart title (top) or BlockActions (top-
          right). Becomes prominent in pin mode; fades to a subtle hover
          affordance otherwise. */}
      <div className="pointer-events-auto absolute bottom-2 left-2 flex items-center gap-1">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setPinMode((v) => !v); setComposer(null); }}
          style={pinMode ? undefined : { backgroundColor: "hsl(var(--background, 0 0% 100%) / 0.9)" }}
          className={
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium shadow-sm transition-colors " +
            (pinMode
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border text-muted-foreground opacity-0 backdrop-blur hover:bg-muted hover:text-foreground group-hover:opacity-100")
          }
          title={pinMode ? "Cancel pin mode" : "Drop a comment pin"}
        >
          <MapPin className="h-3 w-3" />
          {pinMode ? "Click chart to drop pin" : "Pin"}
          {pins.length > 0 && !pinMode && (
            <span className="ml-1 rounded-full bg-primary/20 px-1 text-[9px] font-bold text-primary">{pins.length}</span>
          )}
        </button>
      </div>

      {/* Pin-mode crosshair feedback — subtle blue tint over the chart so the
          viewer knows clicks will land somewhere. */}
      {pinMode && (
        <div
          className="pointer-events-none absolute inset-0 cursor-crosshair bg-primary/[0.04] ring-2 ring-inset ring-primary/30"
          aria-hidden
        />
      )}

      {/* Existing pins — clickable always. Slight outline so they pop on
          dark or busy chart backgrounds. */}
      {loaded && pins.map((pin) => (
        <PinMarker
          key={pin.cellKey}
          pin={pin}
          open={openPin === pin.cellKey}
          onOpen={() => setOpenPin(pin.cellKey)}
          onClose={() => setOpenPin(null)}
          reportId={reportId}
          blockId={blockId}
          comments={comments.filter((c) => c.cellKey === pin.cellKey)}
          onChanged={refresh}
        />
      ))}

      {/* Inline composer — appears at the click point and floats up so the
          user sees what they're writing without losing the spot. */}
      {composer && (
        <div
          className="pointer-events-auto absolute z-30"
          style={{
            left: `${composer.xPct * 100}%`,
            top: `${composer.yPct * 100}%`,
            transform: "translate(-12px, -12px)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Stem dot at the click location for visual anchoring */}
          <span className="absolute left-3 top-3 h-2 w-2 rounded-full bg-primary ring-2 ring-background" />
          <PinComposer
            onSubmit={postPin}
            onCancel={() => { setComposer(null); }}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pin marker + thread popover
// ---------------------------------------------------------------------------

function PinMarker({
  pin, open, onOpen, onClose, reportId, blockId, comments, onChanged,
}: {
  pin: Pin;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  reportId: string;
  blockId: string;
  comments: PinComment[];
  onChanged: () => Promise<void>;
}) {
  // Sort thread chronologically. Seed first, replies after.
  const ordered = [...comments].sort((a, b) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  const seed = ordered.find((c) => !c.parentId) ?? ordered[0];
  const replies = ordered.filter((c) => c !== seed);
  const resolved = !!seed?.resolvedAt;

  async function postReply(body: string) {
    if (!seed) return;
    const r = await fetch(`/api/reports/${reportId}/comments`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blockId, body, parentId: seed.id, cellKey: pin.cellKey }),
    });
    if (r.ok) await onChanged();
  }

  async function toggleResolve() {
    if (!seed) return;
    await fetch(`/api/reports/${reportId}/comments/${seed.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolved: !resolved }),
    });
    await onChanged();
  }

  async function deleteComment(id: string) {
    if (!confirm("Delete this comment?")) return;
    await fetch(`/api/reports/${reportId}/comments/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    await onChanged();
  }

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); open ? onClose() : onOpen(); }}
        className={
          "pointer-events-auto absolute -ml-3 -mt-3 inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold shadow-md ring-2 ring-background transition-transform hover:scale-110 " +
          (resolved
            ? "bg-success text-white"
            : "bg-warning text-warning")
        }
        style={{
          left: `${pin.xPct * 100}%`,
          top: `${pin.yPct * 100}%`,
        }}
        title={resolved ? "Resolved comment" : `${pin.threadCount} comment${pin.threadCount === 1 ? "" : "s"}`}
        aria-label="Open pin thread"
      >
        <MapPin className="h-3 w-3" />
      </button>

      {open && seed && (
        // Thread popover — anchored next to the pin. Width is fixed so it
        // doesn't reflow as comments are added.
        <div
          // Inline bg fallback — same `--popover` resolution issue as the
          // composer (see PinComposer comment). Without it the thread
          // bleeds into the chart underneath.
          style={{
            left: `${pin.xPct * 100}%`,
            top: `${pin.yPct * 100}%`,
            transform: "translate(12px, -8px)",
            backgroundColor: "hsl(var(--background, 0 0% 100%))",
          }}
          className="pointer-events-auto absolute z-40 w-72 overflow-hidden rounded-lg border border-border text-foreground shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <header className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
              <MessageCircle className="h-3 w-3" /> Pinned thread
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={toggleResolve}
                className={
                  "inline-flex items-center gap-1 rounded p-1 text-[10px] font-medium " +
                  (resolved
                    ? "text-success hover:bg-success/10"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground")
                }
                title={resolved ? "Re-open" : "Resolve"}
              >
                <Check className="h-3 w-3" /> {resolved ? "Reopen" : "Resolve"}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Close"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </header>

          <div className="max-h-64 overflow-y-auto px-3 py-2">
            {ordered.map((c) => (
              <div
                key={c.id}
                className={
                  "mb-2 rounded-md border px-2.5 py-1.5 text-xs last:mb-0 " +
                  (c === seed ? "border-border bg-muted/30" : "ml-3 border-border/50 bg-background")
                }
              >
                <div className="flex items-baseline justify-between gap-2 text-[10px]">
                  <span className="font-semibold text-foreground">
                    {c.author?.name ?? c.author?.email ?? "Unknown"}
                  </span>
                  <button
                    type="button"
                    onClick={() => deleteComment(c.id)}
                    className="rounded p-0.5 text-destructive/60 hover:bg-destructive/10 hover:text-destructive"
                    title="Delete"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
                <p className="mt-1 whitespace-pre-wrap leading-relaxed">{c.body}</p>
              </div>
            ))}
          </div>

          {!resolved && (
            <div className="border-t border-border bg-muted/20 px-2 py-2">
              <PinComposer compact onSubmit={postReply} onCancel={onClose} placeholder="Reply…" submitLabel="Reply" />
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Composer — same shape for the new-pin and reply cases
// ---------------------------------------------------------------------------

function PinComposer({
  onSubmit, onCancel, compact, placeholder, submitLabel,
}: {
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
  compact?: boolean;
  placeholder?: string;
  submitLabel?: string;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { taRef.current?.focus(); }, []);

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    try { await onSubmit(text); setDraft(""); }
    finally { setSending(false); }
  }

  return (
    <form
      onSubmit={handleSubmit}
      // Inline backgroundColor fallback — `bg-popover` resolves through a CSS
      // variable that isn't always loaded (SSR + first paint), and on chart
      // overlays the form ends up transparent. Setting an explicit fallback
      // means the composer always has a solid surface.
      style={{ backgroundColor: "hsl(var(--background, 0 0% 100%))" }}
      className={
        "relative ml-6 w-64 overflow-hidden rounded-lg border border-border text-foreground shadow-2xl " +
        (compact ? "" : "")
      }
      onClick={(e) => e.stopPropagation()}
    >
      <textarea
        ref={taRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder ?? "Comment on this exact spot…"}
        // Explicit inline bg again — textarea inherits transparent from
        // user agent stylesheet which would re-expose the chart underneath.
        style={{ backgroundColor: "transparent" }}
        className="block min-h-[60px] w-full resize-y border-0 p-2.5 text-xs leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none"
        maxLength={2000}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void handleSubmit(); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
      />
      <div
        // Footer needs its own opaque bg too — same fallback story.
        style={{ backgroundColor: "hsl(var(--muted, 0 0% 96%))" }}
        className="flex items-center justify-between gap-2 border-t border-border px-2 py-1.5 text-[10px] text-muted-foreground"
      >
        <span>⌘+↩ to post</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-2 py-0.5 hover:bg-muted hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={sending || !draft.trim()}
            className="inline-flex items-center gap-1 rounded bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
            {submitLabel ?? "Post"}
          </button>
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePin(cellKey: string): { x: number; y: number } | null {
  if (!cellKey.startsWith(PIN_PREFIX)) return null;
  const [xs, ys] = cellKey.slice(PIN_PREFIX.length).split(",");
  const x = parseFloat(xs); const y = parseFloat(ys);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

function round(n: number): number {
  // 4 decimals — sub-pixel on a 2k display, but keeps the cellKey short.
  return Math.round(n * 10000) / 10000;
}
