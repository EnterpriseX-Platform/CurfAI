"use client";
import { useMemo, useState, useTransition } from "react";
import { Calendar, RotateCcw, Sliders, Check } from "lucide-react";
import type { Parameter } from "@/lib/reporting/schema";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { SavedViewsPicker } from "./SavedViewsPicker";

/**
 * Dashboard-style shared filter bar shown on the viewer above the report content.
 *
 * Reads from `report.parameters` (already part of the report schema) and renders
 * a polished pill row: date-range presets, select dropdowns, date pickers,
 * boolean toggles, free text. On every change it calls `onApply()` so all
 * blocks re-fetch in lock-step. The same viewer-side state still feeds export
 * URLs so a downloaded PDF/XLSX honours the current filters.
 *
 * Designer-side (the existing `ParameterBar`) is left untouched — that one
 * is a Run-on-submit form for live-preview during editing.
 */

type Props = {
  parameters: Parameter[];
  values: Record<string, unknown>;
  defaults: Record<string, unknown>;
  loading?: boolean;
  onApply: (next: Record<string, unknown>) => void;
  /** Optional Saved Views integration. Omit to hide the chip. */
  reportId?: string;
  activeViewId?: string | null;
  onSelectView?: (id: string | null) => void;
};

export function FilterBar({
  parameters, values, defaults, loading, onApply,
  reportId, activeViewId, onSelectView,
}: Props) {
  // Even when there are zero parameters, the Views picker is still a useful
  // affordance — it lets viewers bookmark "the current state" of any future
  // additions. So we render the bar whenever the picker is wired even if
  // the parameter list is empty.
  const hasViewsPicker = !!(reportId && onSelectView);

  const [, startTransition] = useTransition();

  // Track which parameters have non-default values so we can show a "Reset" affordance.
  const dirtyCount = useMemo(() => {
    return parameters.filter((p) => {
      const v = values[p.name];
      const d = defaults[p.name];
      return v !== undefined && v !== "" && String(v) !== String(d ?? "");
    }).length;
  }, [parameters, values, defaults]);

  if (parameters.length === 0 && !hasViewsPicker) return null;

  function update(name: string, val: unknown) {
    const next = { ...values, [name]: val };
    startTransition(() => onApply(next));
  }

  function reset() {
    onApply({ ...defaults });
  }

  return (
    // A row of parameter pills under the report header — no band, no
    // "Filters" caption; the pills say what they are.
    <div data-filter-bar className="no-print flex flex-wrap items-center gap-2">
      {parameters.length === 0 && (
        <span className="flex items-center gap-1.5 text-xs text-faint"><Sliders className="h-3 w-3" /></span>
      )}
      {parameters.map((p) => (
        <FilterControl
          key={p.name}
          param={p}
          value={values[p.name]}
          isDefault={String(values[p.name] ?? "") === String(defaults[p.name] ?? "")}
          onChange={(v) => update(p.name, v)}
        />
      ))}
      {hasViewsPicker && (
        <SavedViewsPicker
          reportId={reportId!}
          activeViewId={activeViewId ?? null}
          currentParams={values}
          onSelectView={onSelectView!}
          onApply={(p) => onApply(p)}
        />
      )}
      {dirtyCount > 0 && (
        <Button
          size="sm" variant="ghost"
          onClick={reset}
          disabled={loading}
          className="ml-auto h-7 text-xs"
          title="Reset to defaults"
        >
          <RotateCcw className="mr-1 h-3 w-3" /> Reset
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-parameter controls
// ---------------------------------------------------------------------------

function FilterControl({
  param, value, isDefault, onChange,
}: {
  param: Parameter;
  value: unknown;
  isDefault: boolean;
  onChange: (v: unknown) => void;
}) {
  // Pill: "Label  Value ▾" — label in the muted ink, value in the full ink;
  // a non-default value tints the pill with the accent's soft tone.
  const baseChip =
    "inline-flex h-[30px] items-center gap-1.5 rounded-md border px-2.5 text-[13px] transition-colors [&>span:nth-child(2)]:font-medium";
  const activeChip = isDefault
    ? baseChip + " border-border bg-card text-foreground hover:border-input"
    : baseChip + " border-primary/40 bg-primary-soft text-primary-ink";

  switch (param.type) {
    case "dateRange":
      return <DateRangeChip param={param} value={value} chipClass={activeChip} onChange={onChange} />;

    case "select":
      return <SelectChip param={param} value={value} chipClass={activeChip} onChange={onChange} />;

    case "boolean":
      return (
        <button
          type="button"
          onClick={() => onChange(!(value === true || value === "true"))}
          className={activeChip}
          title={param.label}
        >
          <span className="text-muted-foreground">{param.label}:</span>
          <span>{value === true || value === "true" ? "on" : "off"}</span>
        </button>
      );

    case "date":
      return (
        <label className={activeChip + " cursor-pointer"} title={param.label}>
          <Calendar className="h-3 w-3 opacity-60" />
          <span className="text-muted-foreground">{param.label}:</span>
          <input
            type="date"
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
            className="bg-transparent text-current outline-none"
          />
        </label>
      );

    case "number":
      return (
        <label className={activeChip + " cursor-text"} title={param.label}>
          <span className="text-muted-foreground">{param.label}:</span>
          <input
            type="number"
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
            className="w-16 bg-transparent text-current outline-none"
          />
        </label>
      );

    case "string":
    default:
      return (
        <label className={activeChip + " cursor-text"} title={param.label}>
          <span className="text-muted-foreground">{param.label}:</span>
          <input
            type="text"
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
            placeholder="—"
            className="w-24 bg-transparent text-current placeholder:text-muted-foreground/50 outline-none"
          />
        </label>
      );
  }
}

// ---------------------------------------------------------------------------
// Date-range with preset chips
// ---------------------------------------------------------------------------

const DATE_PRESETS = [
  { value: "7d",   label: "Last 7 days" },
  { value: "30d",  label: "Last 30 days" },
  { value: "90d",  label: "Last 90 days" },
  { value: "qtd",  label: "Quarter to date" },
  { value: "ytd",  label: "Year to date" },
  { value: "all",  label: "All time" },
];

function DateRangeChip({
  param, value, chipClass, onChange,
}: {
  param: Parameter;
  value: unknown;
  chipClass: string;
  onChange: (v: unknown) => void;
}) {
  const current = String(value ?? "");
  const matched = DATE_PRESETS.find((p) => p.value === current);
  const display = matched?.label
    ?? (current.includes("..") ? "Custom range" : current || "—");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={chipClass} title={param.label}>
          <Calendar className="h-3 w-3 opacity-60" />
          <span className="text-muted-foreground">{param.label}:</span>
          <span>{display}</span>
          <span className="text-[10px] opacity-50">▾</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Presets
        </DropdownMenuLabel>
        {DATE_PRESETS.map((p) => (
          <DropdownMenuItem
            key={p.value}
            onSelect={() => onChange(p.value)}
            className="flex items-center justify-between"
          >
            <span>{p.label}</span>
            {current === p.value && <Check className="ml-2 h-3.5 w-3.5 text-primary" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Custom range
        </DropdownMenuLabel>
        <CustomRangePicker value={current} onChange={onChange} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CustomRangePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  // Custom ranges are encoded as "YYYY-MM-DD..YYYY-MM-DD" so a single param
  // string carries both ends. Queries can split on ".." or use it via a
  // DATE() check depending on the source.
  const [from, to] = value.includes("..") ? value.split("..") : ["", ""];
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);

  return (
    <div className="grid gap-1.5 px-2 py-1.5">
      <label className="grid gap-0.5 text-[11px] text-muted-foreground">
        From
        <input
          type="date" value={f} onChange={(e) => setF(e.target.value)}
          className="h-7 rounded border border-border bg-background px-2 text-xs"
        />
      </label>
      <label className="grid gap-0.5 text-[11px] text-muted-foreground">
        To
        <input
          type="date" value={t} onChange={(e) => setT(e.target.value)}
          className="h-7 rounded border border-border bg-background px-2 text-xs"
        />
      </label>
      <Button
        size="sm" variant="default"
        disabled={!f || !t}
        onClick={() => onChange(f + ".." + t)}
        className="mt-1 h-7 text-xs"
      >
        Apply custom range
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Select dropdown chip
// ---------------------------------------------------------------------------

function SelectChip({
  param, value, chipClass, onChange,
}: {
  param: Parameter;
  value: unknown;
  chipClass: string;
  onChange: (v: unknown) => void;
}) {
  const opts = param.options ?? [];
  const current = String(value ?? "");
  const matched = opts.find((o) => o.value === current);
  const display = matched?.label ?? current ?? "—";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={chipClass} title={param.label}>
          <span className="text-muted-foreground">{param.label}:</span>
          <span>{display || "—"}</span>
          <span className="text-[10px] opacity-50">▾</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {opts.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">No options.</div>
        )}
        {opts.map((o) => (
          <DropdownMenuItem
            key={o.value}
            onSelect={() => onChange(o.value)}
            className="flex items-center justify-between"
          >
            <span>{o.label}</span>
            {current === o.value && <Check className="ml-2 h-3.5 w-3.5 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
