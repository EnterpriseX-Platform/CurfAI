"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Plus } from "lucide-react";

export type SuggestedCheckItem = {
  key: string;
  /** What the check says, in the reader's language. */
  label: string;
  /** The check as /api/admin/dq takes it. */
  body: { name: string; kind: string; tableName: string; configJson: string };
};

export function SuggestedChecks({ items, addLabel, addedLabel, errorLabel }: {
  items: SuggestedCheckItem[]; addLabel: string; addedLabel: string; errorLabel: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<string | null>(null);

  async function add(it: SuggestedCheckItem) {
    setBusy(it.key);
    setFailed(null);
    try {
      const r = await fetch("/api/admin/dq", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(it.body),
      });
      if (r.ok) { setDone((d) => new Set(d).add(it.key)); router.refresh(); } else setFailed(it.key);
    } catch { setFailed(it.key); } finally { setBusy(null); }
  }

  return (
    <ul className="divide-y divide-border" data-testid="suggested-checks">
      {items.map((it) => (
        <li key={it.key} className="flex items-center justify-between gap-3 py-2 text-sm">
          <span>
            {it.label}
            {failed === it.key && <span className="ml-2 text-xs text-destructive">{errorLabel}</span>}
          </span>
          {done.has(it.key) ? (
            <span className="inline-flex items-center gap-1 text-xs text-success"><Check className="h-3 w-3" />{addedLabel}</span>
          ) : (
            <button
              type="button"
              onClick={() => add(it)}
              disabled={busy !== null}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-accent disabled:opacity-50"
            >
              {busy === it.key ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
              {addLabel}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
