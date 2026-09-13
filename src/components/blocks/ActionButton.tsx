"use client";

/**
 * Per-row action button for table blocks (Executable / Intelligence Layer).
 * Confirms, dispatches via /api/reports/:id/actions/dispatch, toasts the result.
 */
import { useState } from "react";
import { Send, Loader2, Check, AlertTriangle } from "lucide-react";
import type { TableAction } from "@/lib/reporting/schema";
import type { Row } from "@/lib/reporting/interpolate";

export function ActionButton({
  reportId,
  blockId,
  action,
  row,
  params,
}: {
  reportId: string;
  blockId: string;
  action: TableAction;
  row: Row;
  params?: Record<string, unknown>;
}) {
  const [state, setState] = useState<"idle" | "busy" | "ok" | "error">("idle");
  const [message, setMessage] = useState<string>("");

  async function run(e: React.MouseEvent) {
    e.stopPropagation();
    if (state === "busy") return;
    if (action.confirm !== false) {
      const label = action.confirmLabel ?? `${action.label}?`;
      if (!window.confirm(label)) return;
    }
    setState("busy"); setMessage("");
    try {
      const res = await fetch(`/api/reports/${reportId}/actions/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blockId, actionId: action.id, row, params: params ?? {} }),
      });
      const json = await res.json();
      setMessage(json.response ?? "");
      setState(json.ok ? "ok" : "error");
      setTimeout(() => setState("idle"), 2000);
    } catch (e: any) {
      setMessage(e?.message ?? String(e));
      setState("error");
      setTimeout(() => setState("idle"), 2500);
    }
  }

  return (
    <button
      type="button"
      onClick={run}
      disabled={state === "busy"}
      title={state === "idle" ? action.label : message || action.label}
      className={`no-drag inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
        state === "ok"
          ? "bg-success/10 text-success"
          : state === "error"
            ? "bg-destructive/10 text-destructive"
            : "bg-primary/10 text-primary hover:bg-primary/15"
      } disabled:cursor-wait`}
    >
      {state === "busy" ? <Loader2 className="h-3 w-3 animate-spin" /> :
       state === "ok"   ? <Check className="h-3 w-3" /> :
       state === "error"? <AlertTriangle className="h-3 w-3" /> :
                          <Send className="h-3 w-3" />}
      {state === "ok" ? "Done" : state === "error" ? "Failed" : action.label}
    </button>
  );
}
