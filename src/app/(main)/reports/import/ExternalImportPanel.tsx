"use client";
/**
 * ExternalImportPanel — wiring + import flow for the URL-import path.
 *
 * Same shape as the marketplace ImportPanel but POSTs to
 * /api/reports/import (which doesn't bump a downloads counter — there
 * isn't one for external sources). The import body carries the full
 * sanitized definition because we don't have a server-side handle on it
 * the way marketplace does.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Download, Database, AlertTriangle, Check, ExternalLink } from "lucide-react";
import Link from "next/link";

type WiringRequirement = {
  placeholder: string;
  label: string;
  kind: string;
  previewQuery?: string;
};

type Connection = { id: string; name: string; kind: string };

export function ExternalImportPanel({
  sanitizedDefinition,
  sourceName,
  sourceUrl,
  wiringRequired,
}: {
  sanitizedDefinition: any;
  sourceName: string;
  sourceUrl: string;
  wiringRequired: WiringRequirement[];
}) {
  const router = useRouter();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [wiring, setWiring] = useState<Record<string, string>>({});
  const [name, setName] = useState(sourceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/data-sources", { credentials: "include", cache: "no-store" })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => {
        const items = (j?.items ?? j ?? []) as Connection[];
        setConnections(items);
        const auto: Record<string, string> = {};
        for (const w of wiringRequired) {
          const match = items.find((c) => c.kind === w.kind);
          if (match) auto[w.placeholder] = match.id;
        }
        setWiring(auto);
      })
      .catch(() => setConnections([]));
  }, [wiringRequired]);

  async function doImport() {
    setBusy(true); setError(null); setSuccess(null);
    try {
      const r = await fetch("/api/reports/import", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          definition: sanitizedDefinition,
          wiring,
          name: name.trim() || sourceName,
          sourceUrl,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);
      setSuccess(`Imported as "${j.name}". Redirecting…`);
      setTimeout(() => router.push(j.redirectTo ?? `/reports/${j.id}/edit`), 600);
    } catch (e: any) {
      setError(e?.message ?? "Import failed");
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-5">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Step 1 — Name</p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          className="h-9 w-full rounded border border-border bg-background px-3 text-sm"
        />
      </div>

      {wiringRequired.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-5">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Step 2 — Wire {wiringRequired.length} connection{wiringRequired.length === 1 ? "" : "s"}
          </p>

          {connections === null ? (
            <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
          ) : connections.length === 0 ? (
            <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning  ">
              <AlertTriangle className="mr-1 inline h-3 w-3" />
              No connections in your workspace yet — the import will land with empty queries.
              <Link href="/data-sources" className="ml-1 inline-flex items-center gap-0.5 text-primary underline">
                Connect one <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          ) : (
            <ul className="space-y-2">
              {wiringRequired.map((w) => {
                const matching = connections.filter((c) => c.kind === w.kind);
                const others = connections.filter((c) => c.kind !== w.kind);
                return (
                  <li key={w.placeholder} className="rounded-md border border-border bg-background p-2.5">
                    <div className="mb-1.5 flex items-center gap-1.5 text-xs">
                      <Database className="h-3 w-3 text-muted-foreground" />
                      <span className="font-medium">{w.label}</span>
                      <span className="ml-auto rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{w.kind}</span>
                    </div>
                    <select
                      value={wiring[w.placeholder] ?? ""}
                      onChange={(e) => setWiring((m) => ({ ...m, [w.placeholder]: e.target.value }))}
                      className="h-7 w-full rounded border border-border bg-background px-1.5 text-xs"
                    >
                      <option value="">Leave unwired (fix later)</option>
                      {matching.length > 0 && (
                        <optgroup label="Matching kind">
                          {matching.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
                        </optgroup>
                      )}
                      {others.length > 0 && (
                        <optgroup label="Other connections">
                          {others.map((c) => (<option key={c.id} value={c.id}>{c.name} ({c.kind})</option>))}
                        </optgroup>
                      )}
                    </select>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {success && (
        <div className="flex items-start gap-1.5 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-xs text-success ">
          <Check className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{success}</span>
        </div>
      )}
      {error && (
        <div className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <button
        type="button"
        onClick={doImport}
        disabled={busy}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        {busy ? "Importing…" : "Import to my workspace"}
      </button>
    </div>
  );
}
