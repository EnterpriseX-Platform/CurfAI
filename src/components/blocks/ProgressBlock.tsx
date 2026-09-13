import type { BlockRenderContext } from "./types";
import { BlockEmptyState } from "./BlockEmptyState";

const COLORS: Record<string, { bar: string; track: string; text: string }> = {
  primary: { bar: "bg-gradient-to-r from-[hsl(var(--primary))] to-[hsl(var(--primary))]/70", track: "bg-primary/10",    text: "text-primary"    },
  emerald: { bar: "bg-gradient-to-r from-success to-success",                        track: "bg-success/10", text: "text-success" },
  amber:   { bar: "bg-gradient-to-r from-warning to-warning",                            track: "bg-warning/10",   text: "text-warning"   },
  rose:    { bar: "bg-gradient-to-r from-destructive to-destructive",                              track: "bg-destructive/10",    text: "text-destructive"    },
  sky:     { bar: "bg-gradient-to-r from-primary to-primary",                                track: "bg-primary-soft",     text: "text-primary-ink"     },
};

/** Clamps anything a query might hand back into a drawable 0-100. */
function toPct(raw: unknown, fallback: number): number {
  const n = Number(raw ?? fallback);
  return Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));
}

function Bar({ pct, c }: { pct: number; c: (typeof COLORS)[string] }) {
  return (
    <div className={`h-2.5 w-full overflow-hidden rounded-full ${c.track}`}>
      <div
        className={`h-full rounded-full transition-all duration-500 ${c.bar}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function ProgressBlock({ block, dataset, bare }: BlockRenderContext) {
  if (block.type !== "progress") return null;
  const { label, queryId, valueField, labelField, descriptionField, maxRows, value, showPercent, color } =
    block.config;

  if (queryId && (!dataset[queryId] || dataset[queryId].length === 0)) {
    return <BlockEmptyState type="progress" blockId={block.id} title={label} />;
  }
  const c = COLORS[color] ?? COLORS.primary;

  // List mode — one bar per result row. Only when the author named a column
  // to title each row with; otherwise there is nothing to distinguish them.
  if (queryId && labelField) {
    const rows = (dataset[queryId] ?? []).slice(0, maxRows ?? 10);
    return (
      <div className="flex h-full flex-col gap-3 overflow-auto rounded-lg border border-border bg-card p-4">
        {label && <div className="text-xs font-medium text-muted-foreground">{label}</div>}
        {rows.map((row, i) => {
          const pct = toPct(valueField ? row[valueField] : undefined, 0);
          const description = descriptionField ? row[descriptionField] : null;
          return (
            <div key={i} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-sm font-semibold text-foreground">{String(row[labelField] ?? "")}</span>
                {showPercent && (
                  <span className={`shrink-0 text-sm font-semibold tabular-nums ${c.text}`}>{pct.toFixed(0)}%</span>
                )}
              </div>
              {description != null && description !== "" && (
                <div className="truncate text-xs text-muted-foreground">{String(description)}</div>
              )}
              <Bar pct={pct} c={c} />
            </div>
          );
        })}
      </div>
    );
  }

  // Single-bar mode — the original behaviour. Bound to a query it reads the
  // first row; otherwise it draws the literal configured value.
  const pct = toPct(queryId && valueField ? ((dataset[queryId] ?? [])[0] ?? {})[valueField] : undefined, value);
  return (
    <div className={"flex h-full flex-col justify-center gap-2 " + (bare ? "p-1" : "rounded-lg border border-border bg-card p-4")}>
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {showPercent && <span className={`text-sm font-semibold tabular-nums ${c.text}`}>{pct.toFixed(0)}%</span>}
      </div>
      <Bar pct={pct} c={c} />
    </div>
  );
}
