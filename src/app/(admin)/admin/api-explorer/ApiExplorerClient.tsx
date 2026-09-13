"use client";
/**
 * Swagger-style live tester for /api/v1. Loads the endpoint catalog from
 * GET /api/v1/docs (the same contract external developers read) and lets
 * an admin fire real requests at it — either using their own session
 * (default) or a specific curf_... API key pasted into "Authorize", to
 * reproduce exactly what a third-party integration would see.
 */
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Lock, LockOpen, Play, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n/LocaleContext";

type DocEndpoint = {
  method: string;
  path: string;
  description: string;
  params?: Record<string, string>;
  roleRequired?: string;
};

type Docs = {
  version: string;
  auth: { header: string; keyFormat: string; mintAt: string; docsUrl: string };
  endpoints: DocEndpoint[];
  rateLimits: Record<string, string>;
};

const METHOD_STYLE: Record<string, string> = {
  GET: "bg-primary/10 text-primary-ink border-primary/30 ",
  POST: "bg-success/10 text-success border-success/30 ",
  PUT: "bg-warning/10 text-warning border-warning/30 ",
  PATCH: "bg-warning/10 text-warning border-warning/30 ",
  DELETE: "bg-destructive/10 text-destructive border-destructive/30 ",
};

// Fixed display order — same rationale as the /api/v1/docs source ordering,
// just given human group names instead of code-comment banners.
const GROUP_ORDER = [
  "Reports", "Lake", "Dashboards", "Watchers", "Notebooks",
  "Agent", "Catalog & Search", "Workspace Templates", "Other",
];

function classify(path: string): string {
  if (path.startsWith("/api/v1/reports")) return "Reports";
  if (path.startsWith("/api/v1/lake")) return "Lake";
  if (path.startsWith("/api/v1/dashboards")) return "Dashboards";
  if (path.startsWith("/api/v1/watchers")) return "Watchers";
  if (path.startsWith("/api/v1/notebooks")) return "Notebooks";
  if (path.startsWith("/api/v1/agent")) return "Agent";
  if (path.startsWith("/api/v1/catalog") || path.startsWith("/api/v1/search")) return "Catalog & Search";
  if (path.startsWith("/api/v1/workspace-templates")) return "Workspace Templates";
  return "Other";
}

function pathParamsOf(path: string): string[] {
  return Array.from(path.matchAll(/\{(\w+)\}/g)).map((m) => m[1]);
}

function exampleBody(params?: Record<string, string>, pathParams: string[] = []): string {
  if (!params) return "{}";
  const obj: Record<string, string> = {};
  for (const [key, desc] of Object.entries(params)) {
    if (pathParams.includes(key)) continue;
    obj[key] = desc.split(",")[0].trim();
  }
  return Object.keys(obj).length ? JSON.stringify(obj, null, 2) : "{}";
}

type RowState = {
  open: boolean;
  pathValues: Record<string, string>;
  queryValues: Record<string, string>;
  bodyText: string;
  running: boolean;
  result: { status: number; statusText: string; durationMs: number; body: string } | null;
  execError: string | null;
};

function rowKey(ep: DocEndpoint) {
  return `${ep.method} ${ep.path}`;
}

export function ApiExplorerClient() {
  const { t } = useT();
  const [docs, setDocs] = useState<Docs | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [rows, setRows] = useState<Record<string, RowState>>({});

  useEffect(() => {
    fetch("/api/v1/docs")
      .then((r) => r.json())
      .then((j: Docs) => {
        setDocs(j);
        const initial: Record<string, RowState> = {};
        for (const ep of j.endpoints) {
          const pp = pathParamsOf(ep.path);
          const qp = Object.keys(ep.params ?? {}).filter((k) => !pp.includes(k));
          initial[rowKey(ep)] = {
            open: false,
            pathValues: Object.fromEntries(pp.map((p) => [p, ""])),
            queryValues: ep.method === "GET" ? Object.fromEntries(qp.map((q) => [q, ""])) : {},
            bodyText: ep.method !== "GET" ? exampleBody(ep.params, pp) : "",
            running: false,
            result: null,
            execError: null,
          };
        }
        setRows(initial);
      })
      .catch(() => setLoadError(t("apiExplorer.loadFailed")));
  }, [t]);

  function toggle(ep: DocEndpoint) {
    setRows((prev) => ({ ...prev, [rowKey(ep)]: { ...prev[rowKey(ep)], open: !prev[rowKey(ep)].open } }));
  }

  function updateRow(ep: DocEndpoint, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [rowKey(ep)]: { ...prev[rowKey(ep)], ...patch } }));
  }

  async function execute(ep: DocEndpoint) {
    const key = rowKey(ep);
    const row = rows[key];
    if (!row) return;

    let path = ep.path;
    for (const [name, val] of Object.entries(row.pathValues)) {
      path = path.replace(`{${name}}`, encodeURIComponent(val || `{${name}}`));
    }
    const qs = Object.entries(row.queryValues)
      .filter(([, v]) => v.trim() !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const url = qs ? `${path}?${qs}` : path;

    let body: string | undefined;
    if (ep.method !== "GET" && row.bodyText.trim()) {
      try {
        JSON.parse(row.bodyText);
        body = row.bodyText;
      } catch {
        updateRow(ep, { execError: t("apiExplorer.invalidJson") });
        return;
      }
    }

    updateRow(ep, { running: true, execError: null, result: null });
    const started = performance.now();
    try {
      const headers: Record<string, string> = {};
      if (body) headers["Content-Type"] = "application/json";
      if (apiKey.trim()) headers["Authorization"] = `Bearer ${apiKey.trim()}`;

      const res = await fetch(url, {
        method: ep.method,
        headers,
        body,
        credentials: apiKey.trim() ? "omit" : "include",
      });
      const durationMs = Math.round(performance.now() - started);
      const text = await res.text();
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON, show raw */ }
      updateRow(ep, {
        running: false,
        result: { status: res.status, statusText: res.statusText, durationMs, body: pretty },
      });
    } catch (e: any) {
      updateRow(ep, { running: false, execError: e?.message ?? t("apiExplorer.requestFailed") });
    }
  }

  if (loadError) {
    return <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">{loadError}</div>;
  }
  if (!docs) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t("apiExplorer.loading")}</div>;
  }

  const groups = GROUP_ORDER
    .map((g) => ({ name: g, endpoints: docs.endpoints.filter((e) => classify(e.path) === g) }))
    .filter((g) => g.endpoints.length > 0);

  return (
    <div className="space-y-6">
      {/* Authorize bar — mirrors Swagger's "Authorize" button, but inline
          since this is a single-purpose admin page, not a multi-scheme
          spec. Empty = use your own session (the default, no key needed). */}
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-dashed border-border/80 bg-muted/20 p-4">
        <div className="flex-1 min-w-[260px]">
          <Label className="text-xs">{t("apiExplorer.authorizeLabel")}</Label>
          <Input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="curf_..."
            className="mt-1 font-mono text-xs"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            {apiKey.trim() ? t("apiExplorer.authorizeHintKey") : t("apiExplorer.authorizeHintSession")}
          </p>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${apiKey.trim() ? "border-success/40 bg-success/10 text-success " : "border-border bg-background text-muted-foreground"}`}>
          {apiKey.trim() ? <LockOpen className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
          {apiKey.trim() ? t("apiExplorer.usingKey") : t("apiExplorer.usingSession")}
        </span>
      </div>

      {groups.map((group) => (
        <div key={group.name}>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{group.name}</h2>
          <div className="overflow-hidden rounded-md border border-border">
            {group.endpoints.map((ep, i) => {
              const key = rowKey(ep);
              const row = rows[key];
              if (!row) return null;
              const pp = pathParamsOf(ep.path);
              const qp = Object.keys(ep.params ?? {}).filter((k) => !pp.includes(k));
              return (
                <div key={key} className={i > 0 ? "border-t border-border" : ""}>
                  <button
                    type="button"
                    onClick={() => toggle(ep)}
                    className="flex w-full items-center gap-3 bg-card px-4 py-3 text-left hover:bg-accent/30"
                  >
                    {row.open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    <span className={`inline-flex w-16 shrink-0 items-center justify-center rounded border px-2 py-0.5 font-mono text-[11px] font-bold ${METHOD_STYLE[ep.method] ?? "bg-muted text-muted-foreground border-border"}`}>
                      {ep.method}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-foreground">{ep.path}</span>
                    <span className="truncate text-xs text-muted-foreground">{ep.description}</span>
                  </button>

                  {row.open && (
                    <div className="space-y-3 border-t border-border/60 bg-muted/10 p-4">
                      <p className="text-xs text-muted-foreground">{ep.description}</p>
                      {ep.roleRequired && (
                        <p className="text-[11px] text-muted-foreground">{t("apiExplorer.roleRequired")}: <span className="font-mono">{ep.roleRequired}</span></p>
                      )}

                      {pp.length > 0 && (
                        <div className="grid gap-2 sm:grid-cols-2">
                          {pp.map((name) => (
                            <div key={name}>
                              <Label className="text-[11px]">{`{${name}}`} <span className="text-muted-foreground">({t("apiExplorer.pathParam")})</span></Label>
                              <Input
                                className="mt-1 h-8 font-mono text-xs"
                                value={row.pathValues[name] ?? ""}
                                onChange={(e) => updateRow(ep, { pathValues: { ...row.pathValues, [name]: e.target.value } })}
                              />
                            </div>
                          ))}
                        </div>
                      )}

                      {ep.method === "GET" && qp.length > 0 && (
                        <div className="grid gap-2 sm:grid-cols-2">
                          {qp.map((name) => (
                            <div key={name}>
                              <Label className="text-[11px]">{name} <span className="text-muted-foreground">({t("apiExplorer.queryParam")})</span></Label>
                              <Input
                                className="mt-1 h-8 font-mono text-xs"
                                placeholder={ep.params?.[name]}
                                value={row.queryValues[name] ?? ""}
                                onChange={(e) => updateRow(ep, { queryValues: { ...row.queryValues, [name]: e.target.value } })}
                              />
                            </div>
                          ))}
                        </div>
                      )}

                      {ep.method !== "GET" && (
                        <div>
                          <Label className="text-[11px]">{t("apiExplorer.requestBody")}</Label>
                          <textarea
                            className="mt-1 h-28 w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
                            value={row.bodyText}
                            onChange={(e) => updateRow(ep, { bodyText: e.target.value })}
                            spellCheck={false}
                          />
                        </div>
                      )}

                      <Button size="sm" onClick={() => execute(ep)} disabled={row.running}>
                        {row.running ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
                        {t("apiExplorer.execute")}
                      </Button>

                      {row.execError && (
                        <p className="text-xs text-destructive">{row.execError}</p>
                      )}

                      {row.result && (
                        <div className="rounded-md border border-border bg-background">
                          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${row.result.status < 300 ? "bg-success/10 text-success " : row.result.status < 500 ? "bg-warning/10 text-warning " : "bg-destructive/10 text-destructive "}`}>
                              {row.result.status} {row.result.statusText}
                            </span>
                            <span className="text-[11px] text-muted-foreground">{row.result.durationMs} ms</span>
                          </div>
                          <pre className="max-h-80 overflow-auto p-3 font-mono text-[11px] leading-relaxed">{row.result.body}</pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
