"use client";
/**
 * Zod-driven property panel (polished). Still auto-generates a form from each
 * block type's Zod schema, but with grouped sections, nicer inputs, and icons.
 */
import { Fragment, useEffect, useState } from "react";
import { z } from "zod";
import { Trash2, Copy, LayoutGrid, Settings2, ChevronDown, ShieldCheck } from "lucide-react";
import { BlockConfigSchemas } from "@/lib/reporting/schema";
import { useDesignerStore } from "@/lib/reporting/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { BLOCK_META as BlockRegistry } from "@/components/blocks/registryMeta";
import { ColumnsEditor } from "./ColumnsEditor";
import { AnnotationsEditor } from "./AnnotationsEditor";
import { GaugeZonesEditor } from "./GaugeZonesEditor";
import { ForecastEditor } from "./ForecastEditor";
import { ChartTypeField } from "./ChartTypeField";
import { BlockGuide } from "./BlockGuide";
import { InlineTagManager } from "@/components/common/InlineTagManager";
import type { Dataset } from "@/lib/reporting/interpolate";
import { eeClient } from "@/ee/client";

type MetricOpt = { slug: string; label: string };

export function PropertyPanel({ dataset }: { dataset?: Dataset }) {
  // Published metrics — offered alongside the report's own queries in the
  // queryId picker (Roadmap Phase 2.3) so binding a KPI to a governed
  // metric is a dropdown pick, not hand-typing "metric:<slug>" into a
  // field that (until now) only ever listed local query ids.
  const [metrics, setMetrics] = useState<MetricOpt[]>([]);
  useEffect(() => {
    if (!eeClient.designer?.metricsPicker) return;
    fetch("/api/metrics").then((r) => r.ok ? r.json() : null)
      .then((j) => {
        const published = (j?.items ?? []).filter((m: any) => m.status === "published");
        setMetrics(published.map((m: any) => ({ slug: m.slug, label: m.label })));
      })
      .catch(() => {});
  }, []);

  const selectedId = useDesignerStore((s) => s.selectedBlockId);
  const report = useDesignerStore((s) => s.report);
  const activePageId = useDesignerStore((s) => s.activePageId);
  const update = useDesignerStore((s) => s.updateBlockConfig);
  const updateLayout = useDesignerStore((s) => s.updateBlockLayout);
  const updateMeta = useDesignerStore((s) => (s as any).updateBlockMeta);
  const remove = useDesignerStore((s) => s.removeBlock);
  const duplicate = useDesignerStore((s) => s.duplicateBlock);

  const block = report.pages.find((p) => p.id === activePageId)?.blocks.find((b) => b.id === selectedId);
  if (!block) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <div>
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
            <Settings2 className="h-4 w-4 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium">No block selected</p>
          <p className="mt-1 text-xs text-muted-foreground">Click a block on the canvas to edit its properties.</p>
        </div>
      </div>
    );
  }

  const meta = BlockRegistry[block.type];
  const MetaIcon = meta.icon;
  const schema = BlockConfigSchemas[block.type] as z.ZodObject<any>;
  const shape = schema.shape ?? {};

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary">
            <MetaIcon className="h-3.5 w-3.5" />
          </span>
          <span className="text-sm font-medium">{meta.label}</span>
        </div>
        <div className="flex items-center gap-1">
          <BlockGuide blockType={block.type} />
          <Button size="icon" variant="ghost" onClick={() => duplicate(block.id)} title="Duplicate">
            <Copy className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={() => remove(block.id)} title="Delete">
            <Trash2 className="h-4 w-4 text-destructive/80" />
          </Button>
        </div>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {/* Layout section */}
        <Section icon={LayoutGrid} label="Layout">
          <div className="grid grid-cols-4 gap-2">
            <NumberField label="X"      value={block.x} onChange={(v) => updateLayout(block.id, { ...block, x: clamp(v, 0, 11) })} />
            <NumberField label="Y"      value={block.y} onChange={(v) => updateLayout(block.id, { ...block, y: Math.max(0, v) })} />
            <NumberField label="Width"  value={block.w} onChange={(v) => updateLayout(block.id, { ...block, w: clamp(v, 1, 12) })} />
            <NumberField label="Height" value={block.h} onChange={(v) => updateLayout(block.id, { ...block, h: Math.max(1, v) })} />
          </div>
          <MmReadout block={block} report={report} />
        </Section>

        <Section icon={Settings2} label="Content">
          <div className="grid gap-3">
            {Object.entries(shape).map(([key, field]) => (
              <Fragment key={key}>
                <Field
                  name={key}
                  field={field as z.ZodTypeAny}
                  value={(block.config as any)[key]}
                  onChange={(val) => update(block.id, { [key]: val })}
                  dataSourceIds={report.dataSources.map((d) => d.id)}
                  metrics={metrics}
                  parentConfig={block.config as Record<string, unknown>}
                  rows={dataset?.[String((block.config as any)?.queryId ?? "")] ?? []}
                />
              </Fragment>
            ))}
          </div>
        </Section>

        <VisibilitySection
          value={(block as any).visibleToRoles ?? []}
          onChange={(next) => updateMeta(block.id, { visibleToRoles: next.length === 0 ? undefined : next })}
        />
      </div>
    </div>
  );
}

function VisibilitySection({
  value, onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [roles, setRoles] = useState<Array<{ slug: string; label: string }>>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/roles")
      .then((r) => r.ok ? r.json() : { items: [] })
      .then((j) => { setRoles(j.items ?? []); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);

  function toggle(slug: string) {
    const set = new Set(value);
    if (set.has(slug)) set.delete(slug); else set.add(slug);
    onChange([...set]);
  }

  return (
    <Section icon={ShieldCheck} label="Visibility (RBAC)">
      <p className="mb-2 text-xs text-muted-foreground">
        Gate this block to specific reader roles. Empty = visible to everyone.
        Admins always see all blocks.
      </p>
      {!loaded && <p className="text-xs text-muted-foreground">Loading roles...</p>}
      {loaded && (
        <InlineTagManager options={roles} selected={value} onToggle={toggle} onOptionsChange={setRoles} />
      )}
      {value.length > 0 && (
        <p className="mt-2 text-[10px] text-muted-foreground">
          Showing for: <span className="font-mono">{value.join(", ")}</span>
        </p>
      )}
    </Section>
  );
}

function Section({
  icon: Icon, label, children, defaultOpen = true,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="space-y-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        <Icon className="h-3 w-3" />
        <span>{label}</span>
        <ChevronDown className={`ml-auto h-3 w-3 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && <div className="space-y-2.5">{children}</div>}
    </div>
  );
}

function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }

/**
 * Per-field helper copy for config fields that benefit from a one-liner.
 * Module scope rather than inline in the boolean branch, because number
 * fields want the same treatment (emphasisTop is meaningless without it).
 * Could move into the schema as `.describe(...)` later.
 */
const FIELD_HINT: Record<string, string> = {
  aiCaption: "Asks the AI for a one-line summary under this chart. Business plan.",
  stacked: "Stack series instead of grouping side-by-side.",
  showLegend: "Show the colored series labels under the chart.",
  showDataLabels: "Print each value at the end of its bar/point.",
  categoricalColor: "Color each bar with a different palette hue. Single-series bar charts only — turns category comparisons from monotone to polychrome.",
  emphasisTop: "Highlight the first N rows and grey out the rest, so the chart argues a point instead of listing values. Sort the query descending first. Single-series bar and pie only.",
};

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="grid gap-1">
      <Label>{label}</Label>
      <Input
        type="number" value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-8 px-2 text-xs"
      />
    </div>
  );
}

function unwrap(field: z.ZodTypeAny): z.ZodTypeAny {
  let f = field;
  while (
    f instanceof z.ZodOptional ||
    f instanceof z.ZodDefault ||
    f instanceof z.ZodNullable
  ) {
    f = (f as any)._def.innerType ?? (f as any)._def.schema;
  }
  return f;
}

function Field({
  name, field, value, onChange, dataSourceIds, metrics, parentConfig, rows,
}: {
  name: string;
  field: z.ZodTypeAny;
  value: any;
  onChange: (v: any) => void;
  dataSourceIds: string[];
  metrics: MetricOpt[];
  /** Sibling fields on the same block config — needed by editors that have
   *  cross-field dependencies (gaugeZones reads gaugeMin/gaugeMax, etc). */
  parentConfig?: Record<string, unknown>;
  /** This block's query result rows, for chartType's compatibility check. */
  rows?: Array<Record<string, unknown>>;
}) {
  const inner = unwrap(field);
  const label = humanize(name);

  if (name === "columns") {
    return (
      <div className="grid gap-1">
        <Label>{label}</Label>
        <ColumnsEditor value={(value ?? []) as any} onChange={onChange} />
      </div>
    );
  }

  // ---- Bespoke editors for the new gated viz features ----
  // These replace the auto-generated JSON-textarea fallback so authors can
  // configure conditional rules / gauge zones / chart annotations through
  // structured pickers instead of pasting JSON.
  if (name === "annotations") {
    return (
      <div className="grid gap-1">
        <Label>{label}</Label>
        <AnnotationsEditor value={value as any} onChange={onChange} xValueOptions={[]} />
      </div>
    );
  }
  if (name === "gaugeZones") {
    const min = Number(parentConfig?.gaugeMin ?? 0);
    const max = Number(parentConfig?.gaugeMax ?? 100);
    return (
      <div className="grid gap-1">
        <Label>{label}</Label>
        <GaugeZonesEditor value={value as any} onChange={onChange} min={min} max={max} />
      </div>
    );
  }
  if (name === "forecast") {
    return (
      <div className="grid gap-1">
        <Label>{label}</Label>
        <ForecastEditor value={value as any} onChange={onChange} />
      </div>
    );
  }
  if (name === "chartType") {
    return (
      <div className="grid gap-1">
        <Label>{label}</Label>
        <ChartTypeField
          value={String(value ?? "bar")}
          onChange={onChange}
          xField={parentConfig?.xField as string | undefined}
          yFields={parentConfig?.yFields as string[] | undefined}
          sizeField={parentConfig?.sizeField as string | undefined}
          rows={rows ?? []}
        />
      </div>
    );
  }

  if (name === "queryId") {
    return (
      <div className="grid gap-1">
        <Label>{label}</Label>
        <Select value={String(value ?? "")} onValueChange={onChange}>
          <SelectTrigger><SelectValue placeholder="Select a query" /></SelectTrigger>
          <SelectContent>
            {dataSourceIds.length === 0 && metrics.length === 0 ? (
              <SelectItem value="__none__" disabled>No queries defined — add one via the Data button</SelectItem>
            ) : (
              <>
                {dataSourceIds.map((id) => <SelectItem key={id} value={id}>{id}</SelectItem>)}
                {/*
                  Governed metrics — Roadmap Phase 2.3. Same "metric:<slug>"
                  sentinel convention every renderer already understands
                  (lib/metrics/resolve.ts), now pickable instead of only
                  settable by hand-typing the prefix into the report JSON.
                  Prefixed visually since this flat list has no group/
                  separator primitive to lean on.
                */}
                {metrics.map((m) => (
                  <SelectItem key={`metric:${m.slug}`} value={`metric:${m.slug}`}>★ Metric: {m.label}</SelectItem>
                ))}
              </>
            )}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (inner instanceof z.ZodEnum) {
    const opts = inner.options as string[];
    return (
      <div className="grid gap-1">
        <Label>{label}</Label>
        <Select value={String(value ?? "")} onValueChange={onChange}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {opts.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (inner instanceof z.ZodBoolean) {
    // Per-field helper copy for booleans that benefit from a one-liner.
    // We could push this into the schema as `.describe(...)` later, but for
    // now a tiny lookup keeps the UX hint near the UX.
    const hint = FIELD_HINT[name];
    return (
      <div className="rounded-md border border-border bg-background px-3 py-2">
        <div className="flex items-center justify-between">
          <Label htmlFor={name}>{label}</Label>
          <input
            id={name}
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            className="h-4 w-4 accent-[hsl(var(--primary))]"
          />
        </div>
        {hint && <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{hint}</p>}
      </div>
    );
  }

  if (inner instanceof z.ZodNumber) {
    const hint = FIELD_HINT[name];
    return (
      <div className="grid gap-1">
        <Label>{label}</Label>
        <Input
          type="number"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
        {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
      </div>
    );
  }

  if (inner instanceof z.ZodArray) {
    return (
      <div className="grid gap-1">
        <Label>{label} <span className="text-[10px] text-muted-foreground">(JSON)</span></Label>
        <textarea
          className="min-h-[96px] rounded-md border border-input bg-background p-2 font-mono text-xs shadow-xs focus:outline-none focus:ring-1 focus:ring-ring"
          value={JSON.stringify(value ?? [], null, 2)}
          onChange={(e) => {
            try { onChange(JSON.parse(e.target.value)); } catch { /* ignore until valid */ }
          }}
        />
      </div>
    );
  }

  return (
    <div className="grid gap-1">
      <Label>{label}</Label>
      <Input
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function humanize(key: string) {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim()
    // Common acronyms — the camelCase split + initial-cap leaves "Ai", "Sso",
    // "Api", "Url" etc as Title Case which reads cheap. Restore them.
    .replace(/\bAi\b/g, "AI")
    .replace(/\bSso\b/g, "SSO")
    .replace(/\bApi\b/g, "API")
    .replace(/\bUrl\b/g, "URL")
    .replace(/\bUi\b/g, "UI")
    .replace(/\bId\b/g, "ID")
    .replace(/\bJson\b/g, "JSON")
    .replace(/\bRbac\b/g, "RBAC")
    .replace(/\bKpi\b/g, "KPI")
    .replace(/\bRest\b/g, "REST");
}


/** Shows the selected block's physical dimensions in millimeters, computed
 *  from the grid (12 cols × 40px rows) against the active page's mm size. */
function MmReadout({ block, report }: { block: { x: number; y: number; w: number; h: number }; report: any }) {
  const page = report.pages[0];
  const PAGE_MM: Record<string, { w: number; h: number }> = {
    A4: { w: 210, h: 297 }, Letter: { w: 216, h: 279 }, Legal: { w: 216, h: 356 },
  };
  const size = PAGE_MM[page?.size ?? "A4"];
  const pageMm = page?.orientation === "landscape" ? { w: size.h, h: size.w } : size;
  const mmPerCol = pageMm.w / 12;
  // Row height in the grid is fixed 40px; convert via px→mm ratio using paper width
  // Since 1 col ≈ mmPerCol mm wide visually, and a cell is square-ish on the grid,
  // we approximate row mm using the same aspect.
  const mmPerRow = mmPerCol * (40 / 61); // ~matches 40px rows in the visual layout
  const xMm = (block.x * mmPerCol).toFixed(0);
  const yMm = (block.y * mmPerRow).toFixed(0);
  const wMm = (block.w * mmPerCol).toFixed(0);
  const hMm = (block.h * mmPerRow).toFixed(0);
  return (
    <div className="mt-1 flex items-center justify-between rounded-md border border-dashed border-border/70 bg-muted/30 px-2 py-1 font-mono text-[10px] text-muted-foreground">
      <span>x: {xMm}mm · y: {yMm}mm</span>
      <span>w: {wMm}mm · h: {hMm}mm</span>
    </div>
  );
}
