"use client";
/**
 * BackupsPanel — collapsible section under /tables that shows the
 * tenant's lake snapshot history + lets admins take/restore/delete.
 *
 * Mounted alongside the existing TablesManager so the user has one
 * place for everything related to their managed table store.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Loader2, Plus, RotateCcw, Trash2, AlertTriangle, Check, Clock, X } from "lucide-react";

type Backup = {
  id: string;
  sizeBytes: number;
  tableCountAtSnapshot: number;
  kind: "auto" | "manual";
  restoredFromId?: string | null;
  createdAt: string;
};

export function BackupsPanel({ canAdmin }: { canAdmin: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Backup[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch("/api/lake/backups", { cache: "no-store", credentials: "include" });
      if (!r.ok) return;
      const j = await r.json();
      setItems(j.items ?? []);
    } catch { /* silent */ }
  }

  useEffect(() => { if (open && items === null) void load(); }, [open, items]);

  async function snapshotNow() {
    setBusy("snapshot"); setError(null); setSuccess(null);
    try {
      const r = await fetch("/api/lake/backups", { method: "POST", credentials: "include" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);
      setSuccess(`Snapshot saved (${(j.backup?.sizeBytes / 1024).toFixed(1)} KB).`);
      setItems(null); void load();
    } catch (e: any) {
      setError(e?.message ?? "Snapshot failed");
    } finally {
      setBusy(null);
    }
  }

  async function restore(id: string) {
    if (!confirm("Restore this snapshot? It will REPLACE your current lake data. A safety snapshot is taken first so you can roll back.")) return;
    setBusy(`restore-${id}`); setError(null); setSuccess(null);
    try {
      const r = await fetch(`/api/lake/backups/${id}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "restore" }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);
      setSuccess(`Restored. A pre-restore safety snapshot was saved as ${j.preRestoreBackupId}. Refresh /tables to see the restored data.`);
      setItems(null); void load();
      // Refresh the parent route so the table catalog rerenders against
      // the now-restored lake.
      router.refresh();
    } catch (e: any) {
      setError(e?.message ?? "Restore failed");
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this snapshot permanently? Cannot be recovered.")) return;
    setBusy(`del-${id}`);
    try {
      const r = await fetch(`/api/lake/backups/${id}`, { method: "DELETE", credentials: "include" });
      if (r.ok) {
        setItems((xs) => (xs ?? []).filter((b) => b.id !== id));
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-5 shadow-xs">
      <header className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 text-left"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Archive className="h-3.5 w-3.5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Backups & restore</h2>
            <p className="text-[11px] text-muted-foreground">
              Nightly snapshots of your lake. Restore any point-in-time. Free 30 days · Team 90 · Business 365.
            </p>
          </div>
        </button>
        <span className="text-muted-foreground">{open ? "▲" : "▼"}</span>
      </header>

      {open && (
        <div className="mt-4 space-y-3">
          {canAdmin && (
            <button
              type="button"
              onClick={snapshotNow}
              disabled={busy === "snapshot"}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy === "snapshot" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
              Snapshot now
            </button>
          )}
          {success && (
            <div className="flex items-start gap-1.5 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-xs text-success ">
              <Check className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{success}</span>
              <button type="button" onClick={() => setSuccess(null)} className="ml-auto rounded p-0.5 hover:bg-success/20"><X className="h-3 w-3" /></button>
            </div>
          )}
          {error && (
            <div className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {items === null && <p className="text-xs text-muted-foreground">Loading…</p>}
          {items !== null && items.length === 0 && (
            <p className="rounded-md border border-dashed border-border bg-muted/10 px-3 py-3 text-center text-[11px] text-muted-foreground">
              No snapshots yet. The first nightly snapshot runs at 02:00 UTC, or hit "Snapshot now" to take one immediately.
            </p>
          )}
          {items !== null && items.length > 0 && (
            <ul className="divide-y divide-border rounded-md border border-border bg-background">
              {items.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs">
                      <Clock className="h-3 w-3 text-muted-foreground" />
                      <span className="font-medium">{new Date(b.createdAt).toLocaleString()}</span>
                      <span className={
                        "rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider " +
                        (b.kind === "manual"
                          ? "bg-primary/10 text-primary"
                          : "bg-muted text-muted-foreground")
                      }>
                        {b.kind}
                      </span>
                      {b.restoredFromId && (
                        <span className="rounded-full bg-warning/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-warning">
                          pre-restore
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      {(b.sizeBytes / 1024).toFixed(1)} KB · {b.tableCountAtSnapshot} table{b.tableCountAtSnapshot === 1 ? "" : "s"}
                    </div>
                  </div>
                  {canAdmin && (
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => restore(b.id)}
                        disabled={!!busy}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] hover:bg-muted disabled:opacity-50"
                        title="Replace current lake with this snapshot"
                      >
                        {busy === `restore-${b.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                        Restore
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(b.id)}
                        disabled={!!busy}
                        className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                        title="Delete snapshot"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
