"use client";
/**
 * PresenceChip — "X is viewing" pill that lives in the viewer header.
 *
 * Talks to /api/reports/:id/presence over EventSource (SSE):
 *   - On mount, opens a stream + starts a 10s heartbeat POST loop
 *   - Receives a `snapshot` event whenever the room changes
 *   - On unmount or tab-close, fires DELETE to leave the room
 *
 * Visual: a row of avatar bubbles + a count. Clicking the chip opens a
 * dropdown listing the viewers' names. Stays compact at 1–3 viewers,
 * collapses to "+N" beyond that.
 *
 * Notes:
 *   - The connection uses `credentials: "include"` semantics by default
 *     because EventSource sends cookies automatically when same-origin.
 *   - We never display anything for solo sessions (chip is "X others
 *     here" — no need for ego mode).
 */
import { useEffect, useRef, useState } from "react";
import { Eye, ChevronDown, Loader2 } from "lucide-react";

type Viewer = {
  key: string;
  name: string;
  email?: string;
  initials: string;
  hue: number;
};

export function PresenceChip({ reportId, selfKey }: { reportId: string; selfKey: string }) {
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  // Used to suppress the chip during reconnect flicker.
  const lastSnapshotAt = useRef<number>(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    let es: EventSource | null = null;
    let hbTimer: ReturnType<typeof setInterval> | null = null;

    function connect() {
      es = new EventSource(`/api/reports/${reportId}/presence`);
      es.addEventListener("snapshot", (ev: MessageEvent) => {
        if (cancelled) return;
        try {
          const j = JSON.parse(ev.data);
          setViewers(Array.isArray(j.viewers) ? j.viewers : []);
          setConnected(true);
          lastSnapshotAt.current = Date.now();
        } catch { /* malformed payload — ignore */ }
      });
      es.onerror = () => {
        // Browser EventSource auto-reconnects; we just record state.
        setConnected(false);
      };
    }
    connect();

    // Heartbeat — server side reaps anyone idle > 30s. We ping every 10s
    // so we always have ~3x headroom against transient blips.
    hbTimer = setInterval(() => {
      fetch(`/api/reports/${reportId}/presence`, { method: "POST", credentials: "include" })
        .catch(() => { /* dropped — SSE will reconnect us */ });
    }, 10_000);

    // Best-effort leave on tab close. `keepalive` lets the request fly
    // even though the page is being unloaded.
    const onUnload = () => {
      try {
        fetch(`/api/reports/${reportId}/presence`, {
          method: "DELETE",
          credentials: "include",
          keepalive: true,
        });
      } catch { /* fire and forget */ }
    };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("pagehide", onUnload);

    return () => {
      cancelled = true;
      if (hbTimer) clearInterval(hbTimer);
      es?.close();
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("pagehide", onUnload);
      onUnload(); // also fire on react unmount (e.g. SPA navigation)
    };
  }, [reportId]);

  // Filter myself out — no point showing "you are also here" — and only
  // render the chip when there's at least one other viewer.
  const others = viewers.filter((v) => v.key !== selfKey);
  if (others.length === 0) return null;

  // First N avatars stack visually; the rest collapse into a +N counter.
  const visible = others.slice(0, 3);
  const overflow = others.length - visible.length;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent"
        title={`${others.length} other ${others.length === 1 ? "viewer" : "viewers"}`}
      >
        <span className="relative flex items-center" aria-hidden>
          <span className={"absolute -left-1.5 inline-flex h-1.5 w-1.5 rounded-full " + (connected ? "bg-success" : "bg-warning")} />
          <Eye className="ml-1 h-3 w-3" />
        </span>
        <span className="flex -space-x-1.5">
          {visible.map((v) => (
            <Avatar key={v.key} viewer={v} ringClass="ring-background" />
          ))}
        </span>
        {overflow > 0 && (
          <span className="ml-0.5 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-muted px-1 text-[10px] font-semibold text-muted-foreground">
            +{overflow}
          </span>
        )}
        <span className="hidden sm:inline">{others.length} viewing</span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {open && (
        <>
          {/* Click-outside backdrop. Cheap; no Radix needed for a list this small. */}
          <button
            type="button"
            aria-hidden
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl">
            <div className="border-b border-border bg-muted/30 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Viewing right now ({others.length})
            </div>
            <ul className="max-h-72 divide-y divide-border overflow-y-auto">
              {others.map((v) => (
                <li key={v.key} className="flex items-center gap-2 px-3 py-2">
                  <Avatar viewer={v} ringClass="ring-popover" />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{v.name}</span>
                    {v.email && v.email !== v.name && (
                      <span className="block truncate text-[10px] text-muted-foreground">{v.email}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {!connected && (
              <div className="flex items-center justify-center gap-1.5 border-t border-border bg-muted/30 px-3 py-1.5 text-[10px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Reconnecting…
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Avatar({ viewer, ringClass }: { viewer: Viewer; ringClass: string }) {
  return (
    <span
      className={"flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white ring-2 " + ringClass}
      style={{ background: `hsl(${viewer.hue}, 60%, 45%)` }}
      title={viewer.name}
    >
      {viewer.initials}
    </span>
  );
}
