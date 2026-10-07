"use client";

/**
 * Small pieces the Views and Databases panels share: a labelled field with its hint and error, a status chip,
 * a notice, a native select in the app's input style. They carry no words of their own; the panels pass them.
 */
import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { adminCall, type AdminCallOptions, type AdminResult, type EngineProblem } from "@/lib/engine/adminClient";

/** The call helper bound to one engine data source. */
export function useAdminCall(dataSourceId: string) {
  return React.useCallback(
    <T,>(method: string, path: string, opts?: AdminCallOptions): Promise<AdminResult<T>> => adminCall<T>(dataSourceId, method, path, opts),
    [dataSourceId],
  );
}

/** One sentence for a problem: the engine's own words when it gave any, else the fallback; unreachable has its own. */
export function problemText(problem: EngineProblem, fallback: string, unreachable: string): string {
  if (problem.unreachable) return problem.message ? `${unreachable} ${problem.message}` : unreachable;
  return problem.message ?? fallback;
}

type FieldProps = {
  id: string;
  label: string;
  hint?: React.ReactNode;
  error?: string | string[];
  required?: boolean;
  children: (aria: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => React.ReactNode;
  className?: string;
};

export function Field({ id, label, hint, error, required, children, className }: FieldProps) {
  const errors = Array.isArray(error) ? error : error ? [error] : [];
  const describedBy = [hint ? `${id}-hint` : null, errors.length ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {label}
        {required && <span aria-hidden="true" className="text-destructive"> *</span>}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": errors.length ? true : undefined })}
      {hint && <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      {errors.length > 0 && (
        <div id={`${id}-error`} role="alert" className="space-y-0.5 text-xs text-destructive">
          {errors.map((e, i) => <p key={i}>{e}</p>)}
        </div>
      )}
    </div>
  );
}

export const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive";

export const NativeSelect = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => <select ref={ref} className={cn(selectClass, className)} {...props} />,
);
NativeSelect.displayName = "NativeSelect";

export type Tone = "success" | "warning" | "danger" | "primary" | "muted";

const chipTone: Record<Tone, string> = {
  success: "bg-success/10 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-destructive/10 text-destructive",
  primary: "bg-primary-soft text-primary",
  muted: "bg-muted text-muted-foreground",
};

export function Chip({ tone = "muted", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-2 py-0.5 text-xs font-medium", chipTone[tone], className)}>
      {children}
    </span>
  );
}

const noticeTone: Record<Exclude<Tone, "primary" | "muted"> | "info", { box: string; icon: React.ComponentType<{ className?: string }> }> = {
  success: { box: "border-success/30 bg-success/10", icon: CheckCircle2 },
  warning: { box: "border-warning/40 bg-warning/10", icon: AlertTriangle },
  danger: { box: "border-destructive/30 bg-destructive/10", icon: XCircle },
  info: { box: "border-border bg-muted", icon: Info },
};

const noticeIconTone = { success: "text-success", warning: "text-warning", danger: "text-destructive", info: "text-muted-foreground" } as const;

/** A boxed message. Errors and warnings are announced; plain information is not. */
export function Notice({ tone = "info", title, children, className }: {
  tone?: keyof typeof noticeTone; title?: string; children?: React.ReactNode; className?: string;
}) {
  const { box, icon: Icon } = noticeTone[tone];
  return (
    <div role={tone === "danger" || tone === "warning" ? "alert" : "status"} className={cn("flex gap-3 rounded-md border p-3 text-sm", box, className)}>
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", noticeIconTone[tone])} aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        {title && <p className="font-medium text-foreground">{title}</p>}
        {children && <div className="space-y-1 text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
}

/** A result table for a preview: text only, never markup. */
export function ResultTable({ columns, rows, format, maxRows = 50 }: {
  columns: { name: string }[]; rows: unknown[][]; format: (v: unknown) => string; maxRows?: number;
}) {
  return (
    <div className="max-h-80 overflow-auto rounded-md border border-border">
      <table className="w-full min-w-max text-left text-xs">
        <thead className="sticky top-0 bg-muted">
          <tr>{columns.map((c) => <th key={c.name} scope="col" className="px-3 py-2 font-medium text-foreground">{c.name}</th>)}</tr>
        </thead>
        <tbody>
          {rows.slice(0, maxRows).map((row, i) => (
            <tr key={i} className="border-t border-border">
              {columns.map((c, j) => <td key={c.name} className="max-w-[16rem] truncate px-3 py-1.5 font-mono text-muted-foreground" title={format(row[j])}>{format(row[j])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
