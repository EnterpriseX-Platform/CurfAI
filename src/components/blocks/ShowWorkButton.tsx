"use client";

/**
 * Show-your-work panel.
 *
 * Sits next to the proof shield on every data-bound block. Click it to unfold
 * the actual SQL (or REST request) that produced the block's data, which
 * parameters were bound, and a preview of the first few rows. Makes every
 * number in a report explainable in place — no separate dev-tools dance.
 */
import * as React from "react";
import * as Popover from "@radix-ui/react-popover";
import { Code2 } from "lucide-react";
import type { DataSourceDef } from "@/lib/reporting/schema";
import type { Row } from "@/lib/reporting/interpolate";

export function ShowWorkButton({
  ds,
  rows,
  params,
}: {
  ds: DataSourceDef | null;
  rows: Row[];
  params: Record<string, unknown>;
}) {
  if (!ds) return null;

  const isSql = !!ds.sql;
  const bound = collectBoundParams(ds, params);

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Show the query and raw data"
          title="Show your work — unfold the SQL and data"
          className="no-print inline-flex h-5 w-5 items-center justify-center rounded-md text-primary/70 opacity-0 transition-all hover:bg-primary/10 hover:text-primary hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Code2 className="h-3.5 w-3.5" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 w-[32rem] max-w-[90vw] overflow-hidden rounded-lg border border-border p-0 text-foreground shadow-xl outline-none"
          style={{ backgroundColor: "hsl(var(--popover, 0 0% 100%))" }}
        >
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Code2 className="h-4 w-4 text-primary" />
            <div className="flex-1 text-sm font-medium">{ds.name}</div>
            <div className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary-ink">
              {isSql ? "SQL" : (ds.method ?? "GET")}
            </div>
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {isSql ? (
              <CodeBlock label="Query" code={ds.sql ?? ""} />
            ) : (
              <RestDetails ds={ds} />
            )}

            {bound.length > 0 && (
              <div className="border-t border-border px-3 py-2">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Bound parameters
                </div>
                <dl className="space-y-1 text-xs">
                  {bound.map(([k, v]) => (
                    <div key={k} className="flex items-baseline justify-between gap-3">
                      <dt className="font-mono text-muted-foreground">:{k}</dt>
                      <dd className="min-w-0 truncate">
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{formatValue(v)}</code>
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            <div className="border-t border-border px-3 py-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Raw preview
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {rows.length.toLocaleString()} row{rows.length === 1 ? "" : "s"}
                </span>
              </div>
              <RowsPreview rows={rows} max={5} />
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div className="px-3 py-2">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <pre className="whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
        {code}
      </pre>
    </div>
  );
}

function RestDetails({ ds }: { ds: DataSourceDef }) {
  return (
    <div className="space-y-2 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Request</div>
      <div className="rounded-md bg-muted px-3 py-2 font-mono text-[11px]">
        <span className="font-semibold text-primary-ink">{ds.method ?? "GET"}</span>{" "}
        <span className="text-foreground">{ds.path ?? "/"}</span>
      </div>
      {ds.body && (
        <>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Body template</div>
          <pre className="whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 font-mono text-[11px]">{ds.body}</pre>
        </>
      )}
      {ds.jsonPath && (
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="text-muted-foreground">JSON path</span>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{ds.jsonPath}</code>
        </div>
      )}
    </div>
  );
}

function RowsPreview({ rows, max }: { rows: Row[]; max: number }) {
  const preview = rows.slice(0, max);
  if (preview.length === 0) {
    return <p className="py-3 text-center text-xs text-muted-foreground">No rows.</p>;
  }
  const cols = Object.keys(preview[0]);
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-[11px]">
        <thead className="bg-muted text-muted-foreground">
          <tr>
            {cols.map((c) => (
              <th key={c} className="border-b border-border px-2 py-1 text-left font-medium">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.map((r, i) => (
            <tr key={i} className="border-b border-border/60 last:border-0">
              {cols.map((c) => (
                <td key={c} className="px-2 py-1 font-mono text-foreground">
                  <span className="block max-w-[180px] truncate">{formatValue(r[c])}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > max && (
        <div className="border-t border-border/60 bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
          {(rows.length - max).toLocaleString()} more row{rows.length - max === 1 ? "" : "s"} not shown.
        </div>
      )}
    </div>
  );
}

function collectBoundParams(ds: DataSourceDef, params: Record<string, unknown>): Array<[string, unknown]> {
  const keys = new Set<string>();
  const hay = [ds.sql ?? "", ds.path ?? "", ds.body ?? ""].join(" ");
  hay.replace(/[:{]([a-zA-Z_][a-zA-Z0-9_]*)\}?/g, (_m, k) => {
    if (k in params) keys.add(k);
    return _m;
  });
  return [...keys].map((k) => [k, params[k]] as [string, unknown]);
}

function formatValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
