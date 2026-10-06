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
 *
 * It only says "Verified" for a query that actually ran. A query that failed
 * (or that the viewer isn't allowed to see) comes back from the runner as an
 * empty result with the reason in the record; hashing that empty result and
 * wearing a green seal over a "$0.00" is a proof of nothing, so those get an
 * honest state and the reason instead of hashes.
 */
import * as React from "react";
import * as Popover from "@radix-ui/react-popover";
import { ShieldCheck, Copy, Check, AlertTriangle } from "lucide-react";
import type { ProvenanceRecord } from "@/lib/reporting/provenance";
import { queryRunState } from "@/lib/reporting/queryRunState";

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
  const state = queryRunState(record);
  const verified = state.kind === "ran";
  const tone = state.kind === "failed" ? "destructive" : "warning";
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-proof-badge
          aria-label={verified ? "View provenance" : state.kind === "failed" ? "This query didn't run — view details" : "This query is restricted — view details"}
          title={
            verified
              ? title ?? "Proof-carrying — click for query fingerprint and run details"
              : state.kind === "failed"
                ? "This query didn't run — the figure shown is not data. Click for the reason."
                : "You don't have access to this query's source. Click for details."
          }
          className={
            !verified
              // Not a verified run: always visible (the icon variant is hover-only for a
              // verified badge, which is fine for a tick and wrong for a warning), and it prints.
              ? `inline-flex shrink-0 items-center justify-center transition-colors ${
                  seal ? "h-[18px] w-[18px] rounded-full border-[1.5px]" : "h-5 w-5 rounded-md"
                } ${tone === "destructive" ? "border-destructive text-destructive hover:bg-destructive/10" : "border-warning text-warning hover:bg-warning/10"}`
              : seal
                ? "inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-success text-success transition-colors hover:bg-success/10"
                : "no-print inline-flex h-5 w-5 items-center justify-center rounded-md text-success/70 opacity-0 transition-all hover:bg-success/10 hover:text-success hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
          }
        >
          {!verified
            ? <AlertTriangle className={seal ? "h-2.5 w-2.5" : "h-3.5 w-3.5"} strokeWidth={seal ? 3 : 2} />
            : seal ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : <ShieldCheck className="h-3.5 w-3.5" />}
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
            {verified
              ? <ShieldCheck className="h-4 w-4 text-success" />
              : <AlertTriangle className={`h-4 w-4 ${tone === "destructive" ? "text-destructive" : "text-warning"}`} />}
            <div className="flex-1 text-sm font-medium">{verified ? "Proof of provenance" : state.kind === "failed" ? "This query didn't run" : "Query restricted"}</div>
            <div
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                verified ? "bg-success/10 text-success" : tone === "destructive" ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-warning"
              }`}
            >
              {verified ? "Verified" : state.kind === "failed" ? "Failed" : "No access"}
            </div>
          </div>
          <div className="space-y-2 px-3 py-3 text-xs">
            {!verified && (
              <div
                role="alert"
                className={`rounded-md border px-2 py-1.5 leading-snug ${
                  tone === "destructive" ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-warning/30 bg-warning/5 text-warning"
                }`}
              >
                <div className="break-words font-mono text-[11px]">{state.reason}</div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {state.kind === "failed"
                    ? "Any number shown for this block is a placeholder, not a result."
                    : "Nothing was read from this source for you."}
                </div>
              </div>
            )}
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
            {verified && (
              <>
                <Row label="Rows">
                  <span className="tabular-nums">{record.rowCount.toLocaleString()}</span>
                </Row>
                <Divider />
                <HashRow label="Query hash" value={record.queryHash} />
                <HashRow label="Data hash" value={record.dataHash} />
              </>
            )}
          </div>
          {verified && (
            <div className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
              Hashes are SHA-256 fingerprints. If either changes between runs, the number above was produced by a different query or different data.
            </div>
          )}
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
