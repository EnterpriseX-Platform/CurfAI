"use client";
/**
 * EmbedButton — "Embed this block" entry in the BlockActions menu.
 *
 * Opens a small dialog that:
 *   - Shows TTL options (7d / 90d / 1y / never expires-ish via 10y)
 *   - Mints a signed token via /api/reports/[id]/embed-token
 *   - Surfaces the iframe snippet + a copy button
 *   - Notes that data updates live (no caching) and ?p.* params can be
 *     overridden by the consumer if the embed was minted without frozen
 *     params
 */
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Code2, Loader2, Copy, X, Check, ExternalLink } from "lucide-react";
import { useEscapeAndFocusTrap } from "@/hooks/useEscapeAndFocusTrap";

export function EmbedButton({ reportId, blockId }: { reportId: string; blockId: string }) {
  const [open, setOpen] = useState(false);
  const [ttlDays, setTtlDays] = useState<number>(365);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; iframe: string } | null>(null);
  const [copied, setCopied] = useState<"" | "iframe" | "url">("");
  const modalRef = useRef<HTMLDivElement>(null);
  useEscapeAndFocusTrap(open, () => setOpen(false), modalRef);

  async function mint() {
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await fetch(`/api/reports/${reportId}/embed-token`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blockId, ttlDays }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);
      setResult({ url: j.url, iframe: j.iframe });
    } catch (e: any) {
      setError(e?.message ?? "Mint failed");
    } finally {
      setBusy(false);
    }
  }

  function copy(value: string, kind: "iframe" | "url") {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(kind);
      setTimeout(() => setCopied(""), 1500);
    }).catch(() => setError("Clipboard write blocked"));
  }

  return (
    <>
      <button
        type="button"
        onClick={() => { setOpen(true); setResult(null); setError(null); }}
        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="Embed this block on another site"
      >
        <Code2 className="h-3.5 w-3.5" />
      </button>

      {open && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => !busy && setOpen(false)}>
          <div
            ref={modalRef}
            style={{ backgroundColor: "hsl(var(--background, 0 0% 100%))" }}
            className="flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg flex-col overflow-hidden rounded-xl border border-border text-foreground shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <header className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-4 pr-12">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-border">
                <Code2 className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold leading-tight">Embed this block</h2>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  Drop a chrome-less iframe into any page. Data updates live; revoke by rotating the embed secret.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Close"
                disabled={busy}
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
              <fieldset className="rounded-md border border-border p-2">
                <legend className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Token validity
                </legend>
                <div className="grid grid-cols-4 gap-1.5">
                  {[
                    { d: 7, l: "7 days" },
                    { d: 90, l: "90 days" },
                    { d: 365, l: "1 year" },
                    { d: 3650, l: "10 years" },
                  ].map((o) => (
                    <button
                      key={o.d}
                      type="button"
                      onClick={() => setTtlDays(o.d)}
                      className={
                        "rounded-md border px-2 py-1.5 text-[11px] transition-colors " +
                        (ttlDays === o.d
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:bg-muted")
                      }
                    >
                      {o.l}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-[10px] text-muted-foreground">
                  Tokens are stateless — to revoke before expiry, rotate <code>CURF_EMBED_SECRET</code>.
                </p>
              </fieldset>

              {!result && (
                <button
                  type="button"
                  onClick={mint}
                  disabled={busy}
                  className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-primary text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Code2 className="h-3 w-3" />}
                  Mint embed token
                </button>
              )}

              {result && (
                <div className="space-y-3">
                  <SnippetField
                    label="iframe snippet"
                    value={result.iframe}
                    copied={copied === "iframe"}
                    onCopy={() => copy(result.iframe, "iframe")}
                  />
                  <SnippetField
                    label="raw URL (for redirects, OG previews)"
                    value={result.url}
                    copied={copied === "url"}
                    onCopy={() => copy(result.url, "url")}
                  />
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <a
                      href={result.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      Preview the embed <ExternalLink className="h-3 w-3" />
                    </a>
                    <button
                      type="button"
                      onClick={() => { setResult(null); setError(null); }}
                      className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      Mint another
                    </button>
                  </div>
                </div>
              )}

              {error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function SnippetField({ label, value, copied, onCopy }: {
  label: string; value: string; copied: boolean; onCopy: () => void;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="relative mt-1">
        <textarea
          value={value}
          readOnly
          rows={3}
          className="block w-full resize-none rounded-md border border-border bg-muted/30 p-2 pr-9 font-mono text-[11px] leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="button"
          onClick={onCopy}
          className="absolute right-1.5 top-1.5 inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
          title="Copy"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
    </label>
  );
}
