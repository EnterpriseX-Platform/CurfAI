"use client";
/**
 * ConnectorRecipeButton — modal that collects an API key, then materialises
 * a REST DataSource with the recipe's pre-baked baseUrl + auth headers.
 *
 * On success we redirect to /data-sources?focus=<id> so the user lands on
 * the new connection's row in the manage list.
 */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Key, Plus, X, ExternalLink } from "lucide-react";
import { findRecipe, buildRestConnectionFromRecipe } from "@/lib/connectors/registry";
import { useEscapeAndFocusTrap } from "@/hooks/useEscapeAndFocusTrap";
import { useT } from "@/lib/i18n/LocaleContext";

export function ConnectorRecipeButton({ recipeId }: { recipeId: string }) {
  const { t } = useT();
  const router = useRouter();
  const recipe = findRecipe(recipeId);
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [username, setUsername] = useState(""); // for basic auth
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useEscapeAndFocusTrap(open, () => setOpen(false), modalRef);

  if (!recipe) return null;

  async function connect() {
    if (!apiKey.trim()) { setErr(t("connectors.apiKeyRequiredError")); return; }
    setBusy(true); setErr(null);
    try {
      const built = buildRestConnectionFromRecipe(recipe!, apiKey.trim(), { username: username.trim() });
      const r = await fetch("/api/data-sources", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || `${recipe!.label} (${new Date().toLocaleDateString()})`,
          kind: "rest",
          // Storage shape mirrors what /data-sources POST already accepts
          // for REST connections — baseUrl + headers + auth.
          connection: JSON.stringify({
            baseUrl: built.baseUrl,
            headers: built.headers,
            auth: built.auth,
            // Sample endpoints from the recipe — surfaced in the query
            // editor as a "Try one of these" picker.
            recipeId: recipe!.id,
            exampleEndpoints: recipe!.exampleEndpoints,
          }),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);
      // Land on the manage page with the new row focused.
      router.push(`/data-sources?focus=${j?.dataSource?.id ?? ""}`);
    } catch (e: any) {
      setErr(e?.message ?? t("connectors.connectFailedFallback"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => { setOpen(true); setErr(null); }}
        className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[10px] font-semibold text-primary-foreground hover:bg-primary/90"
      >
        <Plus className="h-2.5 w-2.5" /> {t("action.connect")}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => !busy && setOpen(false)}>
          <div
            ref={modalRef}
            style={{ backgroundColor: "hsl(var(--background, 0 0% 100%))" }}
            className="flex max-h-[90vh] w-[calc(100%-2rem)] max-w-md flex-col overflow-hidden rounded-xl border border-border text-foreground shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <header className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-4 pr-12">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Key className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold leading-tight">{t("connectors.connectToTitle").replace("{label}", recipe.label)}</h2>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{recipe.credentialHowTo}</p>
                <a
                  href={recipe.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-[10px] font-medium text-primary hover:underline"
                >
                  {t("connectors.vendorDocsLink")} <ExternalLink className="h-2.5 w-2.5" />
                </a>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t("action.close")}
                disabled={busy}
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
              <label className="block">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("connectors.connectionNameLabel")}</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={`${recipe.label} (${t("connectors.productionSuffix")})`}
                  className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>

              {recipe.auth.kind === "basic" && (
                <label className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("connectors.usernameLabel")}</span>
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={t("connectors.serviceAccountPlaceholder")}
                    className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
              )}

              <label className="block">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {recipe.auth.kind === "basic" ? t("connectors.secretPasswordLabel") : t("connectors.apiKeyLabel")}
                </span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={t("connectors.pasteHerePlaceholder")}
                  className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onKeyDown={(e) => { if (e.key === "Enter") void connect(); }}
                />
              </label>

              <div className="rounded-md border border-dashed border-border bg-muted/20 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t("connectors.sampleEndpointsHeading")}
                </p>
                <ul className="mt-1.5 space-y-1 text-[11px] text-muted-foreground">
                  {recipe.exampleEndpoints.slice(0, 3).map((e, i) => (
                    <li key={i} className="flex flex-col gap-0.5">
                      <code className="text-foreground">{e.path}</code>
                      <span className="text-[10px]">{e.description}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {err && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{err}</div>
              )}
            </div>

            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                className="h-8 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {t("action.cancel")}
              </button>
              <button
                type="button"
                onClick={connect}
                disabled={busy || !apiKey.trim()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                {t("action.connect")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
