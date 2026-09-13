"use client";
/**
 * AutoCurfPublishedBanner — celebratory toast that appears once after an
 * Auto-Curf with publish=true. The button hand-off uses sessionStorage to
 * pass the public URL into the new report's first render; we surface it
 * as a soft top-of-page banner with a copy button + an "Open" link, then
 * remove the storage key so refreshing doesn't show it again.
 *
 * Why sessionStorage instead of a query param: keeping the URL out of
 * the address bar means a copy/paste of the report's URL doesn't carry
 * the public link reveal forward to colleagues who shouldn't see it
 * without having generated the report themselves.
 */
import { useEffect, useState } from "react";
import { Globe, Copy, Check, ExternalLink, X, Sparkles } from "lucide-react";

export function AutoCurfPublishedBanner() {
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const v = window.sessionStorage.getItem("curf.autoCurf.lastPublicUrl");
    if (!v) return;
    setUrl(v);
    // One-shot — clear immediately so a refresh doesn't re-show.
    window.sessionStorage.removeItem("curf.autoCurf.lastPublicUrl");
  }, []);

  function copy() {
    if (!url) return;
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (!url) return null;

  return (
    <div className="no-print border-b border-success/30 bg-success/10 px-4 py-2 ">
      <div className="flex items-start gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success/20 text-success">
          <Sparkles className="h-3 w-3" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-success ">
            Curf built this dashboard from your table — and a public link is ready to share.
          </p>
          <div className="mt-1 flex items-center gap-2">
            <code className="block flex-1 truncate rounded border border-success/30 bg-background px-2 py-1 font-mono text-[11px]">
              {url}
            </code>
            <button
              type="button"
              onClick={copy}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-success/20 px-2 text-[11px] font-semibold text-success hover:bg-success/30"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? "Copied" : "Copy"}
            </button>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-7 items-center gap-1 rounded-md border border-success/40 bg-background px-2 text-[11px] font-medium text-success hover:bg-success/10"
            >
              <Globe className="h-3 w-3" /> Open <ExternalLink className="h-2.5 w-2.5 opacity-60" />
            </a>
          </div>
          <p className="mt-1 text-[10px] text-success/80 ">
            Anyone with the link can view — no Curf account required. Manage / unpublish in <a href="/admin/apps" className="underline">Admin → Public Apps</a>.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setUrl(null)}
          className="rounded p-1 text-success/60 hover:bg-success/20"
          aria-label="Dismiss"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
