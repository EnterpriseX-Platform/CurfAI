"use client";
/**
 * Tracker — Tremor-style status grid (one cell per period).
 *
 * Best for "how's the SLA streak looking" / "schedule run history" /
 * "uptime over time" — anywhere you want to scan reliability at a
 * glance. Each cell is a thin colored rounded rect; hover surfaces a
 * tooltip with the date + status + optional detail.
 *
 * 90 cells fit comfortably in a card width without scroll. For longer
 * windows pass `cellWidthPx` to compress.
 *
 * Owned in this repo (Tremor-Raw style) so we can edit freely.
 */
import { useState } from "react";
import { cn } from "@/lib/utils";

export type TrackerStatus = "ok" | "warn" | "breach" | "none";

export type TrackerCell = {
  /** ISO date or any short label shown in the tooltip. */
  date: string;
  status: TrackerStatus;
  /** Optional detail line shown under the date in the tooltip. */
  detail?: string;
};

const COLORS: Record<TrackerStatus, string> = {
  ok:     "bg-success",
  warn:   "bg-warning",
  breach: "bg-destructive",
  none:   "bg-muted",
};

export function Tracker({
  data, className, cellHeight = 28,
}: {
  data: TrackerCell[];
  className?: string;
  cellHeight?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const counts = data.reduce<Record<TrackerStatus, number>>(
    (acc, c) => ((acc[c.status] = (acc[c.status] || 0) + 1), acc),
    { ok: 0, warn: 0, breach: 0, none: 0 },
  );
  const measured = counts.ok + counts.warn + counts.breach;
  const okRate = measured ? Math.round((counts.ok / measured) * 100) : null;

  return (
    <div className={cn("relative", className)}>
      <div className="flex items-end gap-[2px]" style={{ height: cellHeight }}>
        {data.map((c, i) => (
          <div
            key={i}
            className={cn(
              "h-full flex-1 cursor-default rounded-[3px] transition-opacity",
              COLORS[c.status],
              hover !== null && hover !== i && "opacity-60",
            )}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            title={`${c.date} · ${c.status}${c.detail ? " · " + c.detail : ""}`}
            aria-label={`${c.date}: ${c.status}`}
          />
        ))}
      </div>
      {/* Footer summary — uptime-style summary line under the grid. */}
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{data.length} day{data.length === 1 ? "" : "s"}</span>
        <span className="flex items-center gap-3">
          <Legend color={COLORS.ok} label={`On time · ${counts.ok}`} />
          {counts.warn > 0 && <Legend color={COLORS.warn} label={`Warn · ${counts.warn}`} />}
          {counts.breach > 0 && <Legend color={COLORS.breach} label={`Breach · ${counts.breach}`} />}
          {okRate !== null && <span className="font-medium tabular-nums text-foreground">{okRate}% on-time</span>}
        </span>
      </div>
      {/* Tooltip — appears above the hovered cell with date + detail. */}
      {hover !== null && data[hover] && (
        <div
          className="pointer-events-none absolute -top-12 z-10 -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] text-popover-foreground shadow-md"
          style={{ left: `${((hover + 0.5) / data.length) * 100}%` }}
        >
          <div className="font-medium">{data[hover].date}</div>
          <div className="mt-0.5 capitalize opacity-80">
            {data[hover].status}{data[hover].detail ? " · " + data[hover].detail : ""}
          </div>
        </div>
      )}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="inline-flex items-center gap-1"><span className={cn("h-2 w-2 rounded-sm", color)} />{label}</span>;
}
