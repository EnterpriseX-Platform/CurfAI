"use client";
/**
 * ConditionalEditor — bespoke UI for a TableColumn's `conditional` field.
 *
 * Replaces the auto-generated JSON textarea with three layered controls:
 *
 *   1. Heatmap mode: pill picker with a mini swatch preview of each ramp.
 *   2. Data bar toggle: single switch for inline mini-bars behind the cell.
 *   3. Rules list: ordered set of {op, value, value2?, variant, iconKind}.
 *      Each row exposes the operator + threshold + variant + icon picker.
 *      First-match-wins ordering is preserved with up/down arrows.
 *
 * Author UX intent: every gated tier-1.6 feature now ships as a designed
 * editor — no JSON-paste required. The renderer's existing precedence
 * still applies (heatmap shading layers under threshold paint).
 */
import { ChevronUp, ChevronDown, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ConditionalFormat, ConditionalRule } from "@/lib/reporting/schema";
import { VariantChips, IconKindGrid } from "./VariantPicker";

const HEATMAP_OPTIONS: { slug: NonNullable<ConditionalFormat["heatmap"]>; label: string; preview: string }[] = [
  { slug: "off",       label: "Off",        preview: "linear-gradient(90deg, transparent, transparent)" },
  { slug: "primary",   label: "Theme",      preview: "linear-gradient(90deg, rgba(99,102,241,0.05), rgba(99,102,241,0.5))" },
  { slug: "diverging", label: "Diverging",  preview: "linear-gradient(90deg, rgba(244,63,94,0.4), transparent, rgba(16,185,129,0.4))" },
  { slug: "good-bad",  label: "More = bad", preview: "linear-gradient(90deg, rgba(16,185,129,0.4), rgba(244,63,94,0.4))" },
  { slug: "bad-good",  label: "More = good",preview: "linear-gradient(90deg, rgba(244,63,94,0.4), rgba(16,185,129,0.4))" },
];

const OP_OPTIONS: { slug: ConditionalRule["op"]; label: string }[] = [
  { slug: "gt",      label: ">"  },
  { slug: "gte",     label: "≥"  },
  { slug: "lt",      label: "<"  },
  { slug: "lte",     label: "≤"  },
  { slug: "eq",      label: "="  },
  { slug: "between", label: "between" },
];

export function ConditionalEditor({
  value, onChange,
}: {
  value: ConditionalFormat | undefined;
  onChange: (next: ConditionalFormat | undefined) => void;
}) {
  const cf: ConditionalFormat = value ?? { heatmap: "off", bar: false, rules: [] };

  function patch(p: Partial<ConditionalFormat>) {
    const next: ConditionalFormat = { ...cf, ...p };
    // Clean up: if heatmap=off + bar=false + no rules, return undefined to
    // remove the field from the column so the saved JSON stays small.
    if (next.heatmap === "off" && !next.bar && (next.rules ?? []).length === 0) {
      onChange(undefined);
      return;
    }
    onChange(next);
  }

  function patchRule(i: number, p: Partial<ConditionalRule>) {
    const rules = (cf.rules ?? []).map((r, idx) => (idx === i ? { ...r, ...p } : r));
    patch({ rules });
  }
  function addRule() {
    const rules = [
      ...(cf.rules ?? []),
      { op: "gte" as const, value: 0, variant: "info" as const, iconKind: "auto" as const },
    ];
    patch({ rules });
  }
  function removeRule(i: number) {
    patch({ rules: (cf.rules ?? []).filter((_, idx) => idx !== i) });
  }
  function moveRule(i: number, dir: -1 | 1) {
    const j = i + dir;
    const rules = (cf.rules ?? []).slice();
    if (j < 0 || j >= rules.length) return;
    [rules[i], rules[j]] = [rules[j], rules[i]];
    patch({ rules });
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-2.5">
      {/* Heatmap ramp picker */}
      <div className="grid gap-1">
        <Label className="text-[10px]">Heatmap shading</Label>
        <div className="flex flex-wrap gap-1">
          {HEATMAP_OPTIONS.map((opt) => {
            const active = (cf.heatmap ?? "off") === opt.slug;
            return (
              <button
                key={opt.slug}
                type="button"
                onClick={() => patch({ heatmap: opt.slug })}
                className={cn(
                  "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] transition-colors",
                  active ? "border-primary bg-primary/5 text-foreground" : "border-border bg-background text-muted-foreground hover:bg-muted",
                )}
              >
                <span
                  aria-hidden
                  className="h-2.5 w-6 rounded"
                  style={{ background: opt.preview, border: "1px solid rgba(15,23,42,0.05)" }}
                />
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Data bar toggle */}
      <div className="flex items-center justify-between rounded-md border border-border bg-background px-2.5 py-1.5">
        <div>
          <Label className="text-[11px]">Inline data bar</Label>
          <p className="text-[10px] text-muted-foreground">Mini bar behind the cell, sized to the column max.</p>
        </div>
        <input
          type="checkbox"
          checked={!!cf.bar}
          onChange={(e) => patch({ bar: e.target.checked })}
          className="h-4 w-4 accent-[hsl(var(--primary))]"
        />
      </div>

      {/* Rules list */}
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-[10px]">Threshold rules <span className="text-muted-foreground/70">(first match wins)</span></Label>
        </div>
        {(cf.rules ?? []).length === 0 && (
          <p className="rounded-md border border-dashed border-border/60 bg-background px-2.5 py-2 text-[11px] text-muted-foreground">
            No rules. Add one to color cells based on their value.
          </p>
        )}
        {(cf.rules ?? []).map((r, i) => (
          <div key={i} className="space-y-2 rounded-md border border-border bg-background p-2">
            {/* Row 1: reorder + op + value(s) + delete */}
            <div className="flex items-center gap-1.5">
              <div className="flex flex-col">
                <button
                  type="button"
                  onClick={() => moveRule(i, -1)}
                  disabled={i === 0}
                  title="Move up"
                  className="flex h-4 w-4 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  <ChevronUp className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => moveRule(i, 1)}
                  disabled={i === (cf.rules ?? []).length - 1}
                  title="Move down"
                  className="flex h-4 w-4 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  <ChevronDown className="h-3 w-3" />
                </button>
              </div>
              <Select value={r.op} onValueChange={(v) => patchRule(i, { op: v as ConditionalRule["op"] })}>
                <SelectTrigger className="h-7 w-[88px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {OP_OPTIONS.map((o) => <SelectItem key={o.slug} value={o.slug}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input
                type="number"
                value={r.value}
                onChange={(e) => patchRule(i, { value: Number(e.target.value) })}
                className="h-7 w-24 text-xs"
              />
              {r.op === "between" && (
                <>
                  <span className="text-[10px] text-muted-foreground">…</span>
                  <Input
                    type="number"
                    value={r.value2 ?? ""}
                    onChange={(e) => patchRule(i, { value2: e.target.value === "" ? undefined : Number(e.target.value) })}
                    className="h-7 w-24 text-xs"
                  />
                </>
              )}
              <button
                type="button"
                onClick={() => removeRule(i)}
                title="Remove rule"
                className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-destructive/70 hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {/* Row 2: variant chip picker */}
            <VariantChips
              size="sm"
              value={r.variant}
              onChange={(v) => patchRule(i, { variant: v })}
            />
            {/* Row 3: icon kind grid */}
            <div className="grid gap-1">
              <Label className="text-[10px] text-muted-foreground">Icon</Label>
              <IconKindGrid
                value={r.iconKind}
                variant={r.variant}
                onChange={(k) => patchRule(i, { iconKind: k })}
              />
            </div>
          </div>
        ))}
        <Button size="sm" variant="outline" onClick={addRule} type="button" className="w-full">
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add rule
        </Button>
      </div>
    </div>
  );
}
