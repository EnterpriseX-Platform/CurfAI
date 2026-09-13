"use client";
/**
 * GaugeZonesEditor — bespoke UI for ChartConfigSchema.gaugeZones[].
 *
 * Each zone is { upTo: number; color: 'danger'|'warning'|'success'|'info'|'neutral' }.
 * Rendered top-down sorted by upTo: the renderer paints each zone arc from
 * the previous boundary to its upTo. Authors typically chain three zones
 * (red < threshold-1 < amber < threshold-2 < green).
 *
 * The editor offers:
 *   - Live preview bar showing where each zone falls inside min..max
 *   - Per-zone: upTo number input + color picker (5 semantic chips)
 *   - Reorder by sorting on every change so zones stay coherent
 *
 * Min/max bounds come from the chart's gaugeMin/gaugeMax fields. We don't
 * expose them inside the editor itself — they have their own number
 * inputs in the auto-generated property panel sitting one row above.
 */
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Color = "danger" | "warning" | "success" | "info" | "neutral";
type Zone = { upTo: number; color: Color };

const COLOR_CHIP: Record<Color, { label: string; bg: string; ring: string }> = {
  danger:  { label: "Danger",  bg: "bg-destructive/15",    ring: "ring-destructive" },
  warning: { label: "Warning", bg: "bg-warning/15",   ring: "ring-warning" },
  success: { label: "Good",    bg: "bg-success/15", ring: "ring-success" },
  info:    { label: "Info",    bg: "bg-primary-soft",  ring: "ring-primary" },
  neutral: { label: "Neutral", bg: "bg-muted/70",   ring: "ring-faint" },
};

const PREVIEW_FILL: Record<Color, string> = {
  danger:  "#fecdd3", warning: "#fde68a", success: "#a7f3d0",
  info:    "#c7d2fe", neutral: "#e2e8f0",
};

export function GaugeZonesEditor({
  value, onChange, min = 0, max = 100,
}: {
  value: Zone[] | undefined;
  onChange: (next: Zone[] | undefined) => void;
  /** Render bounds for the live preview bar. Defaults to 0..100. */
  min?: number;
  max?: number;
}) {
  const list = value ?? [];
  const sorted = [...list].sort((a, b) => a.upTo - b.upTo);
  const span = (max - min) || 1;

  function commit(next: Zone[]) {
    if (next.length === 0) onChange(undefined);
    else onChange([...next].sort((a, b) => a.upTo - b.upTo));
  }
  function patchOne(i: number, p: Partial<Zone>) {
    commit(list.map((z, idx) => (idx === i ? { ...z, ...p } : z)));
  }
  function add() {
    const lastUpTo = sorted.length ? sorted[sorted.length - 1].upTo : min;
    const upTo = Math.min(max, lastUpTo + (max - min) / 4);
    const colorOrder: Color[] = ["danger", "warning", "success"];
    const color = colorOrder[sorted.length % colorOrder.length];
    commit([...list, { upTo, color }]);
  }
  function remove(i: number) {
    commit(list.filter((_, idx) => idx !== i));
  }

  return (
    <div className="space-y-2">
      {/* Live preview bar */}
      <div className="space-y-1">
        <div className="relative h-3 overflow-hidden rounded border border-border bg-muted/40">
          {(() => {
            // Walk sorted zones; each fills from prev boundary up to its upTo.
            let prev = min;
            return sorted.map((z, i) => {
              const left = ((prev - min) / span) * 100;
              const width = ((z.upTo - prev) / span) * 100;
              prev = z.upTo;
              return (
                <span
                  key={i}
                  className="absolute inset-y-0"
                  style={{ left: `${left}%`, width: `${Math.max(0, width)}%`, background: PREVIEW_FILL[z.color] }}
                />
              );
            });
          })()}
        </div>
        <div className="flex justify-between text-[10px] tabular-nums text-muted-foreground">
          <span>{min}</span>
          <span>{max}</span>
        </div>
      </div>

      {list.length === 0 && (
        <p className="rounded-md border border-dashed border-border/60 bg-background px-2.5 py-2 text-[11px] text-muted-foreground">
          No zones. Add one to paint a colored band on the gauge track.
        </p>
      )}

      {list.map((z, i) => (
        <div key={i} className="flex items-center gap-2 rounded-md border border-border bg-background p-2">
          <div className="grid gap-0.5">
            <Label className="text-[10px]">Up to</Label>
            <Input
              type="number"
              value={z.upTo}
              onChange={(e) => patchOne(i, { upTo: Number(e.target.value) })}
              className="h-7 w-20 text-xs"
            />
          </div>
          <div className="grid flex-1 gap-0.5">
            <Label className="text-[10px]">Color</Label>
            <div className="flex flex-wrap gap-1">
              {(Object.keys(COLOR_CHIP) as Color[]).map((c) => {
                const cfg = COLOR_CHIP[c];
                const active = z.color === c;
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => patchOne(i, { color: c })}
                    title={cfg.label}
                    className={cn(
                      "h-6 w-6 rounded-md ring-1 transition-shadow",
                      cfg.bg,
                      active ? "ring-2 " + cfg.ring : "ring-border opacity-70 hover:opacity-100",
                    )}
                  />
                );
              })}
            </div>
          </div>
          <button
            type="button"
            onClick={() => remove(i)}
            title="Remove zone"
            className="flex h-7 w-7 items-center justify-center rounded-md text-destructive/70 hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}

      <Button size="sm" variant="outline" onClick={add} type="button" className="w-full">
        <Plus className="mr-1.5 h-3.5 w-3.5" /> Add zone
      </Button>
    </div>
  );
}
