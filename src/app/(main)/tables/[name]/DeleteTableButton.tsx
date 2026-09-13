"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";

export function DeleteTableButton({ name }: { name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function go() {
    if (!confirm(`Delete table "${name}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/lake/tables/${encodeURIComponent(name)}`, {
        method: "DELETE", credentials: "include",
      });
      if (r.ok) router.push("/tables");
    } finally { setBusy(false); }
  }

  return (
    <button
      type="button"
      onClick={go}
      disabled={busy}
      className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-background px-3 text-xs text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
      Delete
    </button>
  );
}
