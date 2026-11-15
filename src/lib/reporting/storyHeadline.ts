/**
 * One plain sentence for a Story slide, written from the rows the slide shows, so its figures are the slide's own: a KPI says
 * what it is, a ranking says what leads, a series says where it went. Pure; it returns a sentence key and its parts, and the
 * viewer words it in the reader's language (client code cannot import the dictionaries).
 */
import type { Block } from "./schema";
import { computeKpiValue } from "./kpi";
import { formatMetricCompact } from "./format";

export type Headline = { key: "kpi" | "top" | "up" | "down" | "flat"; vars: Record<string, string>; rows: number };

type Rows = ReadonlyArray<Record<string, unknown>>;
const num = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** A series reads left to right: a line or area chart, or an x that is a date or a month. */
const isSeries = (chartType: string, x: unknown[]) =>
  chartType === "line" || chartType === "area" || chartType === "streamgraph" || x.every((v) => /^\d{4}-\d{2}(-\d{2})?/.test(String(v)));

export function headlineFor(block: Block, dataset: Record<string, Rows | undefined>, opts: { currency?: string; locale?: string } = {}): Headline | null {
  const cfg = (block.config ?? {}) as Record<string, any>;
  const rows = typeof cfg.queryId === "string" ? dataset[cfg.queryId] ?? [] : [];
  if (rows.length === 0) return null;
  const fmt = (n: number, f?: string) => formatMetricCompact(n, f === "currency" || f === "percent" || f === "number" ? f : undefined, opts.currency, opts.locale);

  if (block.type === "kpi") {
    const value = computeKpiValue({ valueField: cfg.valueField, aggregate: cfg.aggregate }, rows as any);
    const label = typeof cfg.label === "string" ? cfg.label.trim() : "";
    if (!Number.isFinite(value) || !label) return null;
    return { key: "kpi", vars: { label, value: fmt(value, cfg.format) }, rows: rows.length };
  }

  if (block.type === "chart") {
    const y = Array.isArray(cfg.yFields) ? cfg.yFields[0] : undefined;
    const x = cfg.xField;
    if (typeof x !== "string" || typeof y !== "string" || rows.length < 2) return null;
    const points = rows.map((r) => ({ x: r[x], y: num(r[y]) })).filter((p): p is { x: unknown; y: number } => p.y !== null);
    if (points.length < 2) return null;
    const title = typeof cfg.title === "string" && cfg.title.trim() ? cfg.title.trim() : y;
    if (isSeries(String(cfg.chartType ?? ""), points.map((p) => p.x))) {
      const first = points[0]!, last = points[points.length - 1]!;
      if (first.y === 0) return null;
      const pct = ((last.y - first.y) / Math.abs(first.y)) * 100;
      const key = Math.abs(pct) < 0.5 ? "flat" : pct > 0 ? "up" : "down";
      return { key, vars: { title, from: String(first.x), to: String(last.x), pct: `${Math.abs(pct) >= 10 ? Math.abs(pct).toFixed(0) : Math.abs(pct).toFixed(1)}%` }, rows: rows.length };
    }
    const top = points.reduce((a, b) => (b.y > a.y ? b : a));
    return { key: "top", vars: { title, name: String(top.x), value: fmt(top.y, cfg.valueFormat === "currency" || cfg.format === "currency" ? "currency" : undefined) }, rows: rows.length };
  }
  return null;
}
