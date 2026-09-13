"use client";

/**
 * Proof-carrying badge.
 *
 * Rendered in the corner of every data-bound block (KPI, Table, Chart). Shows
 * a small shield; click it to see the query hash, data hash, run timestamp,
 * data source, and row count.
 *
 * The badge is how Curf makes reports auditable: any number on screen can be
 * traced back to the exact query that produced it, and the exact data it ran
 * against, with a tamper-evident fingerprint.
 */
import * as React from "react";
import * as Popover from "@radix-ui/react-popover";
import { ShieldCheck, Copy, Check } from "lucide-react";
import type { ProvenanceRecord } from "@/lib/reporting/provenance";

export function ProvenanceBadge({
  record,
  align = "end",
  variant = "icon",
  title,
}: {
  record: ProvenanceRecord;
  align?: "start" | "end" | "center";
  /**
   * "icon" — the small shield that lives in a block's ⋯ action row.
   * "seal" — the always-visible verified seal (tick in a ring) a KPI card
   * wears in its header; it prints, the icon variant does not.
   */
  variant?: "icon" | "seal";
  title?: string;
}) {
  const seal = variant === "seal";
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-proof-badge
          aria-label="View provenance"
          title={title ?? "Proof-carrying — click for query fingerprint and run details"}
          className={
            seal
              ? "inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-success text-success transition-colors hover:bg-success/10"
              : "no-print inline-flex h-5 w-5 items-center justify-center rounded-md text-success/70 opacity-0 transition-all hover:bg-success/10 hover:text-success hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
          }
        >
          {seal ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : <ShieldCheck className="h-3.5 w-3.5" />}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align={align}
          sideOffset={6}
          className="z-50 w-80 rounded-lg border border-border p-0 text-foreground shadow-xl outline-none"
          style={{ backgroundColor: "hsl(var(--popover, 0 0% 100%))" }}
        >
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <ShieldCheck className="h-4 w-4 text-success" />
            <div className="flex-1 text-sm font-medium">Proof of provenance</div>
            <div className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-success">
              Verified
            </div>
          </div>
          <div className="space-y-2 px-3 py-3 text-xs">
            <Row label="Query">
              <span className="font-medium text-foreground">{record.queryName}</span>
            </Row>
            <Row label="Source">
              <span>
                {record.dataSourceName}{" "}
                <span className="text-muted-foreground">({record.dataSourceKind})</span>
              </span>
            </Row>
            {record.attachedSources && record.attachedSources.length > 0 && (
              <Row label="Joined">
                <span className="space-y-0.5">
                  {record.attachedSources.map((a) => (
                    <span key={a.alias} className="block">
                      {a.name} <span className="text-muted-foreground">({a.kind})</span>{" "}
                      <span className="rounded border border-border bg-muted/40 px-1 font-mono text-[10px]">as {a.alias}</span>
                    </span>
                  ))}
                </span>
              </Row>
            )}
            <Row label="Run at">
              <span className="tabular-nums">{new Date(record.runAt).toLocaleString()}</span>
            </Row>
            <Row label="Duration">
              <span className="tabular-nums">{record.durationMs} ms</span>
            </Row>
            <Row label="Rows">
              <span className="tabular-nums">{record.rowCount.toLocaleString()}</span>
            </Row>
            <Divider />
            <HashRow label="Query hash" value={record.queryHash} />
            <HashRow label="Data hash" value={record.dataHash} />
          </div>
          <div className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
            Hashes are SHA-256 fingerprints. If either changes between runs, the number above was produced by a different query or different data.
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0 text-right">{children}</div>
    </div>
  );
}

function Divider() {
  return <div className="-mx-3 border-t border-border/60" />;
}

function HashRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = React.useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* ignore */ }
  };
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-1.5">
        <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{value}</code>
        <button
          type="button"
          onClick={onCopy}
          aria-label={`Copy ${label}`}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>
    </div>
  );
}
