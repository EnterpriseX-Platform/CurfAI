"use client";
import { useState } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2, Sigma } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import type { TableColumn, ConditionalFormat } from "@/lib/reporting/schema";
import { ConditionalEditor } from "./ConditionalEditor";
import { cn } from "@/lib/utils";

/**
 * Structured editor for a table block's columns[]. Replaces the JSON textarea
 * with a list of rows where each column has real inputs for key, label, type,
 * alignment, and totals aggregation.
 *
 * Reorder is index-based (Up/Down buttons) rather than drag-and-drop to keep
 * the keyboard story simple and avoid fighting with the canvas's dnd layer.
 */
export function ColumnsEditor({
  value, onChange,
}: {
  value: TableColumn[];
  onChange: (next: TableColumn[]) => void;
}) {
  function update(i: number, patch: Partial<TableColumn>) {
    onChange(value.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }
  function remove(i: number) { onChange(value.filter((_, idx) => idx !== i)); }
  function add() {
    onChange([
      ...value,
      { key: `col_${value.length + 1}`, label: `Column ${value.length + 1}`, type: "string", total: "none" },
    ]);
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = value.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }

  return (
    <div className="space-y-2">
      {value.length === 0 && (
        <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          No columns. Add one to show data in the table.
        </div>
      )}
      {value.map((col, i) => (
        <ColumnRow
          key={i}
          col={col}
          isFirst={i === 0}
          isLast={i === value.length - 1}
          onUpdate={(p) => update(i, p)}
          onRemove={() => remove(i)}
          onMove={(dir) => move(i, dir)}
        />
      ))}

      <Button size="sm" variant="outline" onClick={add} type="button" className="w-full">
        <Plus className="mr-1.5 h-3.5 w-3.5" /> Add column
      </Button>
    </div>
  );
}

function FieldTiny({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <Label className="text-[10px]">{label}</Label>
      {children}
    </div>
  );
}

/**
 * Single column row + collapsible "Conditional formatting" disclosure.
 *
 * Refactored out of the inline map() so the disclosure state lives per-row
 * without forcing the parent to track a Set<index>. The conditional
 * editor itself is the bespoke ConditionalEditor — replaces the previous
 * JSON-textarea with structured pickers for heatmap / bar / rules.
 */
function ColumnRow({
  col, isFirst, isLast, onUpdate, onRemove, onMove,
}: {
  col: TableColumn;
  isFirst: boolean;
  isLast: boolean;
  onUpdate: (patch: Partial<TableColumn>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const [open, setOpen] = useState(false);
  const isNumeric =
    col.type === "number" || col.type === "currency" || col.type === "percent" ||
    (col.type === "formula" && ((col as any).formulaFormat ?? "number") !== "string");
  const cf = col.conditional;
  const cfActive = !!cf && (
    (cf.heatmap && cf.heatmap !== "off") || cf.bar || (cf.rules ?? []).length > 0
  );

  return (
    <div className="rounded-md border border-border bg-background p-2.5">
      <div className="flex items-start gap-2">
        {/* reorder handle */}
        <div className="flex flex-col pt-0.5">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={isFirst}
            title="Move up"
            className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-accent disabled:opacity-30"
          >
            ▲
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={isLast}
            title="Move down"
            className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-accent disabled:opacity-30"
          >
            ▼
          </button>
        </div>

        <div className="grid flex-1 gap-2">
          <div className="grid grid-cols-2 gap-2">
            <FieldTiny label="Key (column in query result)">
              <Input
                className="h-7 font-mono text-xs"
                value={col.key}
                onChange={(e) => onUpdate({ key: e.target.value })}
              />
            </FieldTiny>
            <FieldTiny label="Label">
              <Input
                className="h-7 text-xs"
                value={col.label}
                onChange={(e) => onUpdate({ label: e.target.value })}
              />
            </FieldTiny>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <FieldTiny label="Type">
              <Select value={col.type} onValueChange={(v) => onUpdate({ type: v as TableColumn["type"] })}>
                <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["string", "number", "currency", "percent", "date", "datetime", "formula"].map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldTiny>
            <FieldTiny label="Align">
              <Select
                value={col.align ?? ""}
                onValueChange={(v) => onUpdate({ align: (v || undefined) as TableColumn["align"] })}
              >
                <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="auto" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="left">left</SelectItem>
                  <SelectItem value="center">center</SelectItem>
                  <SelectItem value="right">right</SelectItem>
                </SelectContent>
              </Select>
            </FieldTiny>
            <FieldTiny label="Total">
              <Select value={col.total ?? "none"} onValueChange={(v) => onUpdate({ total: v as TableColumn["total"] })}>
                <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["none", "sum", "avg", "count", "min", "max"].map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldTiny>
          </div>

          {/* Formula editor — only visible when the type is "formula".
              Three controls: the expression itself, the result format, and
              an inline hint about available helper functions. We don't
              live-preview the result here (would need the dataset), but
              the renderer shows #SYNTAX! / #ERROR! cells with a tooltip
              if the formula doesn't compile or evaluate. */}
          {col.type === "formula" && (
            <div className="space-y-2 rounded-md border border-border bg-muted/30 p-2.5">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <Sigma className="h-3 w-3" /> Formula
              </div>
              <textarea
                value={col.formula ?? ""}
                onChange={(e) => onUpdate({ formula: e.target.value })}
                className="min-h-[64px] w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
                placeholder="=spend / leads"
              />
              <FieldTiny label="Result format">
                <Select
                  value={(col as any).formulaFormat ?? "number"}
                  onValueChange={(v) => onUpdate({ formulaFormat: v as any } as any)}
                >
                  <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["number", "currency", "percent", "string"].map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldTiny>
              <p className="text-[10px] leading-snug text-muted-foreground">
                Reference column names directly (e.g. <code className="font-mono">spend</code>). Helpers:{" "}
                <code className="font-mono">SUM(col)</code>, <code className="font-mono">AVG(col)</code>,{" "}
                <code className="font-mono">MIN/MAX/COUNT</code>, <code className="font-mono">IF(cond, a, b)</code>,{" "}
                <code className="font-mono">ROUND(x, d)</code>, <code className="font-mono">ABS</code>,{" "}
                <code className="font-mono">LEN/UPPER/LOWER/CONCAT</code>. Sandboxed — no JS access.
              </p>
            </div>
          )}

          {/* Conditional formatting disclosure (numeric columns only — the
              heatmap/bar/rules system is value-driven and doesn't apply to
              string columns. The disclosure stays available so authors can
              enable it after switching the column type). */}
          {isNumeric && (
            <div>
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className={cn(
                  "flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors",
                  cfActive ? "text-primary" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                Conditional formatting
                {cfActive && (
                  <span className="ml-1 rounded-full bg-primary/10 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wider text-primary">
                    on
                  </span>
                )}
              </button>
              {open && (
                <div className="mt-1.5">
                  <ConditionalEditor
                    value={col.conditional}
                    onChange={(next: ConditionalFormat | undefined) => onUpdate({ conditional: next })}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onRemove}
          title="Remove column"
          className="flex h-7 w-7 items-center justify-center rounded-md text-destructive/80 hover:bg-destructive/10"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
