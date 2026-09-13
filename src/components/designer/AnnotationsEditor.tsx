"use client";
/**
 * AnnotationsEditor — bespoke UI for ChartConfigSchema.annotations[].
 *
 * Each annotation is a vertical event marker on a chart at a specific
 * x-value. The editor offers:
 *
 *   - xValue input with a datalist of distinct values from the chart's
 *     dataset (so authors don't have to remember which date format the
 *     query returned). The datalist is populated on first focus from the
 *     report's currently rendered dataset (passed in as `xValueOptions`).
 *
 *   - label input — what the marker reads.
 *
 *   - variant chip + iconKind grid (the same VariantPicker pair used by
 *     ConditionalEditor) so annotations match the visual language of the
 *     conditional rules system.
 *
 * No drag-reorder; annotations don't have first-match-wins semantics so
 * order is purely cosmetic. We sort by xValue at render time anyway.
 */
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ChartAnnotation } from "@/lib/reporting/schema";
import { VariantChips, IconKindGrid } from "./VariantPicker";

export function AnnotationsEditor({
  value, onChange, xValueOptions = [],
}: {
  value: ChartAnnotation[] | undefined;
  onChange: (next: ChartAnnotation[] | undefined) => void;
  /** Distinct x-values seen in the chart's dataset (e.g. "2025-Q1", "2025-Q2"). */
  xValueOptions?: string[];
}) {
  const list = value ?? [];

  function patchOne(i: number, p: Partial<ChartAnnotation>) {
    const next = list.map((a, idx) => (idx === i ? { ...a, ...p } : a));
    onChange(next.length ? next : undefined);
  }
  function add() {
    const sample = xValueOptions[0] ?? "";
    onChange([
      ...list,
      { xValue: sample, label: "Event", variant: "info", iconKind: "auto" },
    ]);
  }
  function remove(i: number) {
    const next = list.filter((_, idx) => idx !== i);
    onChange(next.length ? next : undefined);
  }

  return (
    <div className="space-y-2">
      {list.length === 0 && (
        <p className="rounded-md border border-dashed border-border/60 bg-background px-2.5 py-2 text-[11px] text-muted-foreground">
          No annotations. Add one to mark an event on the chart (campaign
          launch, holiday, outage, …).
        </p>
      )}

      {/* Hidden datalist shared by every xValue input. */}
      {xValueOptions.length > 0 && (
        <datalist id="annot-xvals">
          {xValueOptions.map((v) => <option key={v} value={v} />)}
        </datalist>
      )}

      {list.map((a, i) => (
        <div key={i} className="space-y-2 rounded-md border border-border bg-background p-2">
          <div className="flex items-center gap-1.5">
            <div className="grid flex-1 grid-cols-2 gap-1.5">
              <div className="grid gap-0.5">
                <Label className="text-[10px]">x value</Label>
                <Input
                  list="annot-xvals"
                  value={a.xValue}
                  onChange={(e) => patchOne(i, { xValue: e.target.value })}
                  className="h-7 font-mono text-xs"
                  placeholder="2025-Q1"
                />
              </div>
              <div className="grid gap-0.5">
                <Label className="text-[10px]">Label</Label>
                <Input
                  value={a.label}
                  onChange={(e) => patchOne(i, { label: e.target.value })}
                  className="h-7 text-xs"
                  placeholder="Campaign launch"
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => remove(i)}
              title="Remove annotation"
              className="flex h-7 w-7 items-center justify-center rounded-md text-destructive/70 hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <VariantChips
            size="sm"
            value={a.variant}
            onChange={(v) => patchOne(i, { variant: v })}
          />
          <div className="grid gap-1">
            <Label className="text-[10px] text-muted-foreground">Icon</Label>
            <IconKindGrid
              value={a.iconKind}
              variant={a.variant}
              onChange={(k) => patchOne(i, { iconKind: k })}
            />
          </div>
        </div>
      ))}

      <Button size="sm" variant="outline" onClick={add} type="button" className="w-full">
        <Plus className="mr-1.5 h-3.5 w-3.5" /> Add annotation
      </Button>
    </div>
  );
}
