"use client";
/**
 * LiveIndicator — small UI badge + EventSource subscription.
 *
 * Drops into any client surface that wants to react to tenant-scoped
 * realtime events. Subscribes to /api/realtime/events on mount and
 * forwards each event to the supplied `onEvent` handler. Renders a
 * tiny pill in the header showing connection state:
 *
 *   • LIVE       — connected, heartbeats arriving
 *   • RECONNECT  — disconnected, EventSource is auto-reconnecting
 *   • OFFLINE    — explicitly disabled or unsupported
 *
 * The hook below (useRealtimeEvents) is the consumer-friendly form
 * when you don't want the badge — e.g. a hidden subscription that
 * just calls router.refresh() on lake busts.
 */
import { useEffect, useRef, useState } from "react";

export type RealtimeEvent =
  | { kind: "lake.bust"; dataSourceId: string; tableName?: string | null; ts: number }
  | { kind: "watcher.fired"; watcherId: string; reportId: string; severity: string; ts: number }
  | { kind: "activation.done"; activationId: string; status: string; rowsSent: number; ts: number }
  | { kind: "ping"; ts: number };

type Status = "connecting" | "live" | "reconnect" | "offline";

export function useRealtimeEvents(onEvent: (event: RealtimeEvent) => void): Status {
  const [status, setStatus] = useState<Status>("connecting");
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (typeof window === "undefined" || !("EventSource" in window)) {
      setStatus("offline");
      return;
    }
    let es: EventSource | null = null;
    let stopped = false;

    function open() {
      if (stopped) return;
      es = new EventSource("/api/realtime/events");
      es.onopen = () => setStatus("live");
      es.onerror = () => {
        // Browsers auto-reconnect on a closed stream; surface the
        // intermediate state so the UI can show "reconnecting".
        setStatus("reconnect");
      };
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as RealtimeEvent;
          onEventRef.current(data);
        } catch {
          /* ignore malformed event */
        }
      };
    }
    open();

    return () => {
      stopped = true;
      es?.close();
    };
  }, []);

  return status;
}

/**
 * The pill-style badge component, e.g. for a dashboard header.
 * Pure visual — pair it with `useRealtimeEvents` in the parent for the
 * actual side-effect.
 */
export function LiveBadge({ status }: { status: Status }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted || status === "offline") return null;

  const config: Record<Exclude<Status, "offline">, { label: string; cls: string; pulse: boolean }> = {
    connecting: { label: "Connecting…", cls: "bg-muted text-muted-foreground", pulse: false },
    live: { label: "Live", cls: "bg-success/10 text-success", pulse: true },
    reconnect: { label: "Reconnecting", cls: "bg-warning/10 text-warning", pulse: false },
  };
  const c = config[status] || config.connecting;
  return (
    <span suppressHydrationWarning className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${c.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full bg-current ${c.pulse ? "animate-pulse" : ""}`} />
      {c.label}
    </span>
  );
}
