"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Database, Loader2, Lock, LockOpen, Pencil, Plus, ShieldAlert, Table2, Trash2, Zap } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogIcon, DialogTitle } from "@/components/ui/dialog";
import { fill } from "@/lib/engine/fill";
import { adminList, type ConnectionTestResult, type EngineConnection, type EngineProblem, type EngineView } from "@/lib/engine/adminClient";
import {
  describeTarget, emptyConnectionForm, fromConnection, kindLabel, summariseNames, testVerdict, viewsUsingConnection,
} from "@/lib/engine/connectionForm";
import { Chip, Notice, problemText, useAdminCall } from "./adminUi";
import { ConnectionBrowser } from "./ConnectionBrowser";
import { ConnectionDialog } from "./ConnectionDialog";
import type { EngineAdminPanelProps } from "./types";

type TestState = { pending: true } | { pending: false; result: ConnectionTestResult } | { pending: false; problem: EngineProblem };

/** The databases the engine reads: add one, check it, see what is in it, and start a view from a table. */
export function DatabasesPanel({ dataSourceId, name }: EngineAdminPanelProps) {
  const { t } = useT();
  const call = useAdminCall(dataSourceId);
  const [connections, setConnections] = useState<EngineConnection[] | null>(null);
  const [views, setViews] = useState<EngineView[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EngineConnection | "new" | null>(null);
  const [browsing, setBrowsing] = useState<EngineConnection | null>(null);
  const [deleting, setDeleting] = useState<EngineConnection | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    const [c, v] = await Promise.all([
      adminList<EngineConnection>(dataSourceId, "/connections"),
      adminList<EngineView>(dataSourceId, "/views"),
    ]);
    if (!c.ok) { setLoadError(problemText(c.problem, t("engineAdmin.databases.err.loadFailed"), t("engineAdmin.databases.err.unreachable"))); setConnections([]); return; }
    setConnections(c.data);
    // The views only say what uses a connection; a failure to read them must not hide the connections.
    setViews(v.ok ? v.data : []);
  }, [dataSourceId, t]);

  useEffect(() => { void load(); }, [load]);

  const runTest = useCallback(async (c: EngineConnection) => {
    setTests((s) => ({ ...s, [c.id]: { pending: true } }));
    const res = await call<ConnectionTestResult>("POST", `/connections/${c.id}/test`);
    setTests((s) => ({ ...s, [c.id]: res.ok ? { pending: false, result: res.data } : { pending: false, problem: res.problem } }));
    // The test is what sets "read-only verified", so show the list's new value.
    if (res.ok) void load();
  }, [call, load]);

  const saved = (c: EngineConnection) => {
    const wasNew = editing === "new";
    setEditing(null);
    setNotice(fill(t(wasNew ? "engineAdmin.databases.notice.created" : "engineAdmin.databases.notice.saved"), { name: c.name }));
    void load();
    // A new connection has never been checked; checking it now says at once whether the account is safe.
    void runTest(c);
  };

  return (
    <section aria-labelledby="databases-title" className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 id="databases-title" className="text-lg font-semibold tracking-tight">{t("engineAdmin.databases.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{fill(t("engineAdmin.databases.intro"), { name })}</p>
        </div>
        <Button type="button" onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" aria-hidden="true" /> {t("engineAdmin.databases.add")}
        </Button>
      </div>

      <Notice tone="info" title={t("engineAdmin.databases.advice.title")}>
        <p>{t("engineAdmin.databases.advice.body")}</p>
      </Notice>

      {notice && (
        <div role="status" className="flex items-center justify-between gap-3 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm">
          <span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />{notice}</span>
          <button type="button" className="text-xs text-muted-foreground underline hover:text-foreground" onClick={() => setNotice(null)}>{t("engineAdmin.databases.dismiss")}</button>
        </div>
      )}

      {loadError && (
        <Notice tone="danger" title={t("engineAdmin.databases.err.loadTitle")}>
          <p>{loadError}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void load()}>{t("engineAdmin.databases.retry")}</Button>
        </Notice>
      )}

      {connections === null && !loadError && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {t("engineAdmin.databases.loading")}
        </p>
      )}

      {connections && connections.length === 0 && !loadError && (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <Database className="mx-auto h-8 w-8 text-faint" aria-hidden="true" />
          <h3 className="mt-3 text-sm font-medium">{t("engineAdmin.databases.empty.title")}</h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{t("engineAdmin.databases.empty.body")}</p>
          <Button type="button" className="mt-4" onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" aria-hidden="true" /> {t("engineAdmin.databases.add")}
          </Button>
        </div>
      )}

      {connections && connections.length > 0 && (
        <ul className="space-y-3">
          {connections.map((c) => {
            const using = viewsUsingConnection(views, c.id);
            const test = tests[c.id];
            return (
              <li key={c.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold">{c.name}</h3>
                      <Chip>{kindLabel(c.kind)}</Chip>
                    </div>
                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{describeTarget(c)}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {c.tlsMode === "VERIFY" && <Chip tone="success"><Lock className="h-3 w-3" aria-hidden="true" />{t("engineAdmin.databases.chip.tlsVerify")}</Chip>}
                      {c.tlsMode === "REQUIRE" && <Chip tone="warning"><Lock className="h-3 w-3" aria-hidden="true" />{t("engineAdmin.databases.chip.tlsRequire")}</Chip>}
                      {c.tlsMode === "DISABLE" && <Chip tone="danger"><LockOpen className="h-3 w-3" aria-hidden="true" />{t("engineAdmin.databases.chip.tlsDisable")}</Chip>}
                      {c.readOnlyVerified
                        ? <Chip tone="success"><CheckCircle2 className="h-3 w-3" aria-hidden="true" />{t("engineAdmin.databases.chip.readOnly")}</Chip>
                        : <Chip tone="warning"><ShieldAlert className="h-3 w-3" aria-hidden="true" />{t("engineAdmin.databases.chip.notVerified")}</Chip>}
                      {c.allowRawSql && <Chip tone="warning"><Zap className="h-3 w-3" aria-hidden="true" />{t("engineAdmin.databases.chip.rawSql")}</Chip>}
                      <Chip>{using.length ? fill(t("engineAdmin.databases.chip.usedBy"), { n: using.length }) : t("engineAdmin.databases.chip.unused")}</Chip>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => void runTest(c)} disabled={test?.pending === true}>
                      {test?.pending === true ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Zap className="h-3.5 w-3.5" aria-hidden="true" />}
                      {t("engineAdmin.databases.action.test")}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => setBrowsing(c)}>
                      <Table2 className="h-3.5 w-3.5" aria-hidden="true" /> {t("engineAdmin.databases.action.browse")}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(c)} aria-label={fill(t("engineAdmin.databases.action.editFor"), { name: c.name })}>
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> {t("engineAdmin.databases.action.edit")}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setDeleting(c)} aria-label={fill(t("engineAdmin.databases.action.deleteFor"), { name: c.name })}>
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> {t("engineAdmin.databases.action.delete")}
                    </Button>
                  </div>
                </div>
                {test && !test.pending && <TestOutcome test={test} />}
              </li>
            );
          })}
        </ul>
      )}

      {editing && (
        <ConnectionDialog
          dataSourceId={dataSourceId}
          initial={editing === "new" ? emptyConnectionForm() : fromConnection(editing)}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
      )}
      {browsing && <ConnectionBrowser dataSourceId={dataSourceId} connection={browsing} onClose={() => setBrowsing(null)} />}
      {deleting && (
        <DeleteConnection
          dataSourceId={dataSourceId}
          connection={deleting}
          usedBy={viewsUsingConnection(views, deleting.id)}
          onClose={() => setDeleting(null)}
          onDeleted={() => { setNotice(fill(t("engineAdmin.databases.notice.deleted"), { name: deleting.name })); setDeleting(null); void load(); }}
        />
      )}
    </section>
  );
}

function TestOutcome({ test }: { test: Exclude<TestState, { pending: true }> }) {
  const { t } = useT();
  if ("problem" in test) {
    return (
      <Notice tone="danger" title={t("engineAdmin.databases.test.failedTitle")} className="mt-3">
        <p>{problemText(test.problem, t("engineAdmin.databases.test.failed"), t("engineAdmin.databases.err.unreachable"))}</p>
        <p>{t("engineAdmin.databases.test.failedHelp")}</p>
      </Notice>
    );
  }
  const r = test.result;
  const verdict = testVerdict(r);
  return (
    <div className="mt-3 space-y-2">
      {verdict === "readOnly" && (
        <Notice tone="success" title={t("engineAdmin.databases.test.okTitle")}>
          <p>{fill(t("engineAdmin.databases.test.okBody"), { ms: r.latencyMs, version: r.serverVersion || "?" })}</p>
          <p>{t("engineAdmin.databases.test.readOnly")}</p>
        </Notice>
      )}
      {verdict === "canWrite" && (
        <Notice tone="danger" title={t("engineAdmin.databases.test.writeTitle")}>
          <p>{fill(t("engineAdmin.databases.test.okBody"), { ms: r.latencyMs, version: r.serverVersion || "?" })}</p>
          <p className="font-medium text-foreground">{t("engineAdmin.databases.test.writeBody")}</p>
          <p>{t("engineAdmin.databases.test.writeFix")}</p>
        </Notice>
      )}
      {verdict === "failed" && (
        <Notice tone="danger" title={t("engineAdmin.databases.test.failedTitle")}>
          <p>{t("engineAdmin.databases.test.failedHelp")}</p>
        </Notice>
      )}
      {r.warnings.length > 0 && (
        <Notice tone="warning" title={t("engineAdmin.databases.test.warnings")}>
          <ul className="list-disc space-y-0.5 pl-4">{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </Notice>
      )}
    </div>
  );
}

function DeleteConnection({ dataSourceId, connection, usedBy, onClose, onDeleted }: {
  dataSourceId: string; connection: EngineConnection; usedBy: { id: string; name: string }[]; onClose: () => void; onDeleted: () => void;
}) {
  const { t } = useT();
  const call = useAdminCall(dataSourceId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = summariseNames(usedBy.map((v) => v.name));

  const remove = async () => {
    setBusy(true);
    setError(null);
    const res = await call("DELETE", `/connections/${connection.id}`);
    setBusy(false);
    // Already gone counts as done.
    if (res.ok || res.problem.status === 404) { onDeleted(); return; }
    setError(problemText(res.problem, t("engineAdmin.databases.delete.failed"), t("engineAdmin.databases.err.unreachable")));
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogIcon variant="danger"><Trash2 className="h-4 w-4" aria-hidden="true" /></DialogIcon>
          <div>
            <DialogTitle>{fill(t("engineAdmin.databases.delete.title"), { name: connection.name })}</DialogTitle>
            <DialogDescription>{t("engineAdmin.databases.delete.body")}</DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody>
          {usedBy.length > 0 ? (
            <Notice tone="warning" title={fill(t("engineAdmin.databases.delete.usedTitle"), { n: usedBy.length })}>
              <p>{t("engineAdmin.databases.delete.usedBody")}</p>
              <ul className="list-disc pl-4">
                {names.shown.map((n, i) => <li key={i}>{n}</li>)}
                {names.more > 0 && <li>{fill(t("engineAdmin.databases.delete.more"), { n: names.more })}</li>}
              </ul>
            </Notice>
          ) : (
            <p className="text-sm text-muted-foreground">{t("engineAdmin.databases.delete.unused")}</p>
          )}
          {error && <Notice tone="danger">{error}</Notice>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>{t("engineAdmin.databases.dialog.cancel")}</Button>
          <Button type="button" variant="destructive" onClick={remove} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {t("engineAdmin.databases.delete.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
