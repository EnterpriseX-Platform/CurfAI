"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2, Eye, EyeOff, Globe, History, Layers, Loader2, Pencil, Plus, Search, Send, Trash2,
} from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { intlLocale } from "@/lib/i18n/formatDate";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogIcon, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { fill } from "@/lib/engine/fill";
import { adminList, type EngineConnection, type EngineView, type QueryResult, type ViewVersion } from "@/lib/engine/adminClient";
import { PUBLIC_ROLE, filterViews, formatCell, readHandoff, viewStatus, withoutHandoff } from "@/lib/engine/viewForm";
import { Chip, Notice, ResultTable, problemText, useAdminCall } from "./adminUi";
import { ViewWizard, type WizardStart } from "./ViewWizard";
import type { EngineAdminPanelProps } from "./types";

type Confirm = { kind: "unpublish" | "delete" | "publishPublic"; view: EngineView };
type Role = { slug: string; label?: string };

/** The views reports are built on: what each is, who sees it, whether it is live; create, change, publish, withdraw. */
export function ViewsPanel({ dataSourceId, name }: EngineAdminPanelProps) {
  const { t, locale, era } = useT();
  const call = useAdminCall(dataSourceId);
  const [views, setViews] = useState<EngineView[] | null>(null);
  const [connections, setConnections] = useState<EngineConnection[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [wizard, setWizard] = useState<WizardStart | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [previewing, setPreviewing] = useState<EngineView | null>(null);
  const [versionsOf, setVersionsOf] = useState<EngineView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [attributeNames, setAttributeNames] = useState<string[]>([]);
  const handoffRead = useRef(false);

  const load = useCallback(async () => {
    setLoadError(null);
    const [v, c] = await Promise.all([
      adminList<EngineView>(dataSourceId, "/views"),
      adminList<EngineConnection>(dataSourceId, "/connections"),
    ]);
    if (!v.ok) { setLoadError(problemText(v.problem, t("engineAdmin.views.err.loadFailed"), t("engineAdmin.views.err.unreachable"))); setViews([]); return; }
    setViews(v.data);
    setConnections(c.ok ? c.data : []);
  }, [dataSourceId, t]);

  useEffect(() => { void load(); }, [load]);

  // Suggestions for the roles and attribute names; the dialog works without them.
  useEffect(() => {
    let live = true;
    void fetch("/api/roles").then((r) => (r.ok ? r.json() : null)).then((j) => { if (live && Array.isArray(j?.items)) setRoles(j.items); }).catch(() => {});
    void fetch("/api/engine/attributes").then((r) => (r.ok ? r.json() : null)).then((j) => { if (live && Array.isArray(j?.names)) setAttributeNames(j.names); }).catch(() => {});
    return () => { live = false; };
  }, []);

  // "Create a view from this table" on the Databases tab lands here with the connection and table in the address.
  useEffect(() => {
    if (handoffRead.current || views === null) return;
    handoffRead.current = true;
    const handoff = readHandoff(window.location.search);
    if (!handoff) return;
    try { window.history.replaceState(null, "", withoutHandoff(window.location.href)); } catch { /* the address keeps its parameters; harmless */ }
    setWizard({ connectionId: handoff.connectionId, table: handoff.table });
  }, [views]);

  const connectionName = useCallback((id: string) => connections.find((c) => c.id === id)?.name ?? t("engineAdmin.views.unknownConnection"), [connections, t]);
  const shown = useMemo(() => filterViews(views ?? [], query, connectionName), [views, query, connectionName]);
  const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(intlLocale(locale, era)) : "");

  const publish = async (view: EngineView) => {
    setActionError(null);
    const res = await call<EngineView>("POST", `/views/${view.id}/publish`);
    if (!res.ok) { setActionError(problemText(res.problem, t("engineAdmin.views.err.publishFailed"), t("engineAdmin.views.err.unreachable"))); return false; }
    setNotice(fill(t("engineAdmin.views.notice.published"), { name: view.name }));
    void load();
    return true;
  };

  const onPublishClick = (view: EngineView) => {
    setActionError(null);
    // Going live to anonymous visitors gets one more, explicit question.
    if ((view.allowedRoles ?? []).includes(PUBLIC_ROLE)) setConfirm({ kind: "publishPublic", view });
    else void publish(view);
  };

  const runConfirm = async (c: Confirm): Promise<string | null> => {
    if (c.kind === "publishPublic") return (await publish(c.view)) ? null : t("engineAdmin.views.err.publishFailed");
    const res = c.kind === "unpublish" ? await call("POST", `/views/${c.view.id}/unpublish`) : await call("DELETE", `/views/${c.view.id}`);
    // Already gone counts as done.
    if (!res.ok && res.problem.status !== 404) return problemText(res.problem, t("engineAdmin.views.err.actionFailed"), t("engineAdmin.views.err.unreachable"));
    setNotice(fill(t(c.kind === "unpublish" ? "engineAdmin.views.notice.unpublished" : "engineAdmin.views.notice.deleted"), { name: c.view.name }));
    void load();
    return null;
  };

  return (
    <section aria-labelledby="views-title" className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 id="views-title" className="text-lg font-semibold tracking-tight">{t("engineAdmin.views.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{fill(t("engineAdmin.views.intro"), { name })}</p>
        </div>
        <Button type="button" onClick={() => setWizard({})}>
          <Plus className="h-4 w-4" aria-hidden="true" /> {t("engineAdmin.views.add")}
        </Button>
      </div>

      {notice && (
        <div role="status" className="flex items-center justify-between gap-3 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm">
          <span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />{notice}</span>
          <button type="button" className="text-xs text-muted-foreground underline hover:text-foreground" onClick={() => setNotice(null)}>{t("engineAdmin.views.dismiss")}</button>
        </div>
      )}
      {actionError && <Notice tone="danger">{actionError}</Notice>}
      {loadError && (
        <Notice tone="danger" title={t("engineAdmin.views.err.loadTitle")}>
          <p>{loadError}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void load()}>{t("engineAdmin.views.retry")}</Button>
        </Notice>
      )}

      {views === null && !loadError && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {t("engineAdmin.views.loading")}
        </p>
      )}

      {views && views.length === 0 && !loadError && (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <Layers className="mx-auto h-8 w-8 text-faint" aria-hidden="true" />
          <h3 className="mt-3 text-sm font-medium">{t("engineAdmin.views.empty.title")}</h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{t("engineAdmin.views.empty.body")}</p>
          <Button type="button" className="mt-4" onClick={() => setWizard({})}>
            <Plus className="h-4 w-4" aria-hidden="true" /> {t("engineAdmin.views.add")}
          </Button>
        </div>
      )}

      {views && views.length > 0 && (
        <>
          <div className="relative max-w-sm">
            <label htmlFor="views-search" className="sr-only">{t("engineAdmin.views.search")}</label>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden="true" />
            <Input id="views-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("engineAdmin.views.search")} className="pl-9" />
          </div>
          <p className="text-xs text-muted-foreground" aria-live="polite">{fill(t("engineAdmin.views.count"), { n: shown.length, total: views.length })}</p>
          {shown.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t("engineAdmin.views.noMatch")}</p>
          ) : (
            <ul className="space-y-3">
              {shown.map((v) => {
                const s = viewStatus(v);
                return (
                  <li key={v.id} className="rounded-xl border border-border bg-card p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-semibold">{v.name}</h3>
                          {s.published === null
                            ? <Chip>{t("engineAdmin.views.status.draft")}</Chip>
                            : <Chip tone="success">{fill(t("engineAdmin.views.status.published"), { v: s.published })}</Chip>}
                          {s.draftChanges && <Chip tone="warning">{t("engineAdmin.views.status.changes")}</Chip>}
                          {s.publicLive && <Chip tone="danger"><Globe className="h-3 w-3" aria-hidden="true" />{t("engineAdmin.views.status.public")}</Chip>}
                          {s.publicPending && <Chip tone="warning"><Globe className="h-3 w-3" aria-hidden="true" />{t("engineAdmin.views.status.publicPending")}</Chip>}
                        </div>
                        {v.description && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{v.description}</p>}
                        <p className="mt-1 text-xs text-faint">
                          {fill(t("engineAdmin.views.meta"), { connection: connectionName(v.connectionId), columns: v.columns.length })}
                          {v.updatedAt && ` · ${fill(t("engineAdmin.views.updated"), { when: when(v.updatedAt), by: v.updatedBy ?? "—" })}`}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button type="button" size="sm" variant="outline" onClick={() => setWizard({ view: v })} aria-label={fill(t("engineAdmin.views.action.editFor"), { name: v.name })}>
                          <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> {t("engineAdmin.views.action.edit")}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setPreviewing(v)} aria-label={fill(t("engineAdmin.views.action.previewFor"), { name: v.name })}>
                          <Eye className="h-3.5 w-3.5" aria-hidden="true" /> {t("engineAdmin.views.action.preview")}
                        </Button>
                        {(s.published === null || s.draftChanges) && (
                          <Button type="button" size="sm" variant="ghost" onClick={() => onPublishClick(v)} aria-label={fill(t("engineAdmin.views.action.publishFor"), { name: v.name })}>
                            <Send className="h-3.5 w-3.5" aria-hidden="true" /> {t("engineAdmin.views.action.publish")}
                          </Button>
                        )}
                        {s.published !== null && (
                          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm({ kind: "unpublish", view: v })} aria-label={fill(t("engineAdmin.views.action.unpublishFor"), { name: v.name })}>
                            <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> {t("engineAdmin.views.action.unpublish")}
                          </Button>
                        )}
                        <Button type="button" size="sm" variant="ghost" onClick={() => setVersionsOf(v)} aria-label={fill(t("engineAdmin.views.action.versionsFor"), { name: v.name })}>
                          <History className="h-3.5 w-3.5" aria-hidden="true" /> {t("engineAdmin.views.action.versions")}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm({ kind: "delete", view: v })} aria-label={fill(t("engineAdmin.views.action.deleteFor"), { name: v.name })}>
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> {t("engineAdmin.views.action.delete")}
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {wizard && (
        <ViewWizard
          key={wizard.view?.id ?? "new"}
          dataSourceId={dataSourceId}
          connections={connections}
          start={wizard}
          roles={roles}
          attributeNames={attributeNames}
          onClose={(changed) => { setWizard(null); if (changed) void load(); }}
          onDone={(message) => { setWizard(null); setNotice(message); void load(); }}
        />
      )}
      {confirm && <ConfirmView confirm={confirm} onClose={() => setConfirm(null)} onConfirm={runConfirm} />}
      {previewing && <PreviewDialog dataSourceId={dataSourceId} view={previewing} onClose={() => setPreviewing(null)} />}
      {versionsOf && <VersionsDialog dataSourceId={dataSourceId} view={versionsOf} when={when} onClose={() => setVersionsOf(null)} />}
    </section>
  );
}

function ConfirmView({ confirm, onClose, onConfirm }: { confirm: Confirm; onClose: () => void; onConfirm: (c: Confirm) => Promise<string | null> }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const k = confirm.kind;
  const danger = k !== "publishPublic";

  const run = async () => {
    setBusy(true);
    setError(null);
    const problem = await onConfirm(confirm);
    setBusy(false);
    if (problem) setError(problem);
    else onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogIcon variant={danger ? "danger" : "warning"}>{k === "delete" ? <Trash2 className="h-4 w-4" aria-hidden="true" /> : k === "unpublish" ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Globe className="h-4 w-4" aria-hidden="true" />}</DialogIcon>
          <div>
            <DialogTitle>{fill(t(`engineAdmin.views.confirm.${k}.title`), { name: confirm.view.name })}</DialogTitle>
            <DialogDescription>{t(`engineAdmin.views.confirm.${k}.body`)}</DialogDescription>
          </div>
        </DialogHeader>
        {error && <DialogBody><Notice tone="danger">{error}</Notice></DialogBody>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>{t("engineAdmin.views.wizard.cancel")}</Button>
          <Button type="button" variant={danger ? "destructive" : "default"} onClick={run} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {t(`engineAdmin.views.confirm.${k}.confirm`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewDialog({ dataSourceId, view, onClose }: { dataSourceId: string; view: EngineView; onClose: () => void }) {
  const { t } = useT();
  const call = useAdminCall(dataSourceId);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void call<QueryResult>("POST", `/views/${view.id}/preview`, { body: {} }).then((res) => {
      if (!live) return;
      if (res.ok) setResult(res.data);
      else setError(problemText(res.problem, t("engineAdmin.views.review.previewFailed"), t("engineAdmin.views.err.unreachable")));
    });
    return () => { live = false; };
  }, [call, view.id, t]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-4xl" aria-describedby="preview-desc">
        <DialogHeader>
          <DialogIcon><Eye className="h-4 w-4" aria-hidden="true" /></DialogIcon>
          <div>
            <DialogTitle>{fill(t("engineAdmin.views.preview.title"), { name: view.name })}</DialogTitle>
            <DialogDescription id="preview-desc">{t("engineAdmin.views.review.previewNote")}</DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody>
          {!result && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t("engineAdmin.views.preview.loading")}</p>}
          {error && <Notice tone="danger">{error}</Notice>}
          {result && (
            <div className="space-y-2" aria-live="polite">
              <p className="text-xs text-muted-foreground">
                {fill(t("engineAdmin.views.review.previewRows"), { n: result.rowCount, shown: Math.min(result.rows.length, 50), ms: result.durationMs })}
                {result.truncated && ` ${t("engineAdmin.views.review.previewTruncated")}`}
              </p>
              <ResultTable columns={result.columns} rows={result.rows} format={formatCell} />
            </div>
          )}
        </DialogBody>
        <DialogFooter><Button type="button" variant="ghost" onClick={onClose}>{t("engineAdmin.views.close")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VersionsDialog({ dataSourceId, view, when, onClose }: { dataSourceId: string; view: EngineView; when: (iso?: string) => string; onClose: () => void }) {
  const { t } = useT();
  const call = useAdminCall(dataSourceId);
  const [versions, setVersions] = useState<ViewVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void call<ViewVersion[]>("GET", `/views/${view.id}/versions`).then((res) => {
      if (!live) return;
      if (res.ok) setVersions(Array.isArray(res.data) ? res.data : []);
      else setError(problemText(res.problem, t("engineAdmin.views.versions.failed"), t("engineAdmin.views.err.unreachable")));
    });
    return () => { live = false; };
  }, [call, view.id, t]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent aria-describedby="versions-desc">
        <DialogHeader>
          <DialogIcon><History className="h-4 w-4" aria-hidden="true" /></DialogIcon>
          <div>
            <DialogTitle>{fill(t("engineAdmin.views.versions.title"), { name: view.name })}</DialogTitle>
            <DialogDescription id="versions-desc">{t("engineAdmin.views.versions.intro")}</DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody>
          {!versions && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t("engineAdmin.views.versions.loading")}</p>}
          {error && <Notice tone="danger">{error}</Notice>}
          {versions && versions.length === 0 && <p className="text-sm text-muted-foreground">{t("engineAdmin.views.versions.none")}</p>}
          {versions && versions.length > 0 && (
            <ul className="divide-y divide-border rounded-md border border-border">
              {versions.map((v) => (
                <li key={v.version} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="font-mono text-xs font-medium">{fill(t("engineAdmin.views.status.published"), { v: v.version })}</span>
                  <span className="text-xs text-muted-foreground">{fill(t("engineAdmin.views.versions.by"), { when: when(v.publishedAt), by: v.publishedBy })}</span>
                  {view.publishedVersion === v.version && <Chip tone="success">{t("engineAdmin.views.versions.live")}</Chip>}
                </li>
              ))}
            </ul>
          )}
        </DialogBody>
        <DialogFooter><Button type="button" variant="ghost" onClick={onClose}>{t("engineAdmin.views.close")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
