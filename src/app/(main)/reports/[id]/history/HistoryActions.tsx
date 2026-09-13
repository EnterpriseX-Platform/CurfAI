"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { RotateCcw, FileDown, Loader2 } from "lucide-react";
import { useToast } from "@/lib/toast";
import { useRouter } from "next/navigation";

export function HistoryActions({
  kind, reportId, version, format, runParams,
}: {
  kind: "restore" | "redownload";
  reportId: string;
  version?: number;
  format?: string;
  runParams?: Record<string, unknown>;
}) {
  const { push } = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function restore() {
    if (!confirm(`Restore this report to version ${version}? The current state will be snapshotted first.`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/reports/${reportId}/versions/${version}/restore`, { method: "POST" });
      if (!r.ok) {
        push({ variant: "destructive", title: "Restore failed", description: await r.text() });
        return;
      }
      push({ variant: "success", title: `Restored to v${version}` });
      router.refresh();
    } finally { setBusy(false); }
  }

  async function redownload() {
    setBusy(true);
    try {
      const u = new URL(`/api/reports/${reportId}/export/${format}`, window.location.origin);
      for (const [k, v] of Object.entries(runParams ?? {})) {
        if (v != null && v !== "") u.searchParams.set(`p.${k}`, String(v));
      }
      const a = document.createElement("a");
      a.href = u.toString();
      a.click();
    } finally { setBusy(false); }
  }

  if (kind === "restore") {
    return (
      <Button size="sm" variant="ghost" onClick={restore} disabled={busy} className="h-7 px-2 text-xs">
        {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1 h-3.5 w-3.5" />}
        Restore
      </Button>
    );
  }
  return (
    <Button size="sm" variant="ghost" onClick={redownload} disabled={busy} className="h-7 px-2 text-xs">
      {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <FileDown className="mr-1 h-3.5 w-3.5" />}
      Re-download
    </Button>
  );
}
