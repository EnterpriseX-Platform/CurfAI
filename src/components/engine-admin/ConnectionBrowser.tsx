"use client";

import { useCallback, useEffect, useState } from "react";
import { EyeOff, Loader2, ShieldAlert, Table2 } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogIcon, DialogTitle } from "@/components/ui/dialog";
import { fill } from "@/lib/engine/fill";
import type { EngineConnection, Introspection, PiiMode } from "@/lib/engine/adminClient";
import { findTable, tableRef, viewsHandoffUrl } from "@/lib/engine/viewForm";
import { Chip, Notice, problemText, useAdminCall } from "./adminUi";
import { SchemaTablePicker } from "./SchemaTablePicker";

/** The database's tables and columns, with the engine's guess at which hold personal data, and a way to start a view from one. */
export function ConnectionBrowser({ dataSourceId, connection, onClose }: {
  dataSourceId: string; connection: EngineConnection; onClose: () => void;
}) {
  const { t } = useT();
  const call = useAdminCall(dataSourceId);
  const [intro, setIntro] = useState<Introspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setIntro(null);
    const res = await call<Introspection>("POST", `/connections/${connection.id}/introspect`);
    if (res.ok) setIntro(res.data);
    else setError(problemText(res.problem, t("engineAdmin.databases.browse.failed"), t("engineAdmin.databases.err.unreachable")));
  }, [call, connection.id, t]);

  useEffect(() => { void load(); }, [load]);

  const table = intro && selected ? findTable(intro, selected) : null;

  const pii: Record<PiiMode, { tone: "muted" | "warning" | "danger"; label: string }> = {
    NONE: { tone: "muted", label: t("engineAdmin.databases.browse.piiNone") },
    MASK: { tone: "warning", label: t("engineAdmin.databases.browse.piiMask") },
    HIDE: { tone: "danger", label: t("engineAdmin.databases.browse.piiHide") },
  };

  const createView = () => {
    if (!selected) return;
    window.location.assign(viewsHandoffUrl(window.location.href, connection.id, selected));
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-3xl" aria-describedby="browse-desc">
        <DialogHeader>
          <DialogIcon><Table2 className="h-4 w-4" aria-hidden="true" /></DialogIcon>
          <div>
            <DialogTitle>{fill(t("engineAdmin.databases.browse.title"), { name: connection.name })}</DialogTitle>
            <DialogDescription id="browse-desc">{t("engineAdmin.databases.browse.intro")}</DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody>
          {error && (
            <Notice tone="danger" title={t("engineAdmin.databases.browse.failedTitle")}>
              <p>{error}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => void load()}>{t("engineAdmin.databases.retry")}</Button>
            </Notice>
          )}
          {!intro && !error && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {t("engineAdmin.databases.browse.loading")}
            </p>
          )}
          {intro && (
            <div className="grid gap-4 md:grid-cols-2">
              <SchemaTablePicker intro={intro} selected={selected} onSelect={(s, tb) => setSelected(tableRef(s, tb))} idPrefix="browse" />
              <div aria-live="polite">
                {table ? (
                  <div className="space-y-2">
                    <h3 className="font-mono text-sm font-medium">{selected}</h3>
                    <ul className="max-h-72 divide-y divide-border overflow-auto rounded-md border border-border">
                      {table.table.columns.map((c) => (
                        <li key={c.name} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                          <span className="min-w-0 flex-1 truncate font-mono">{c.name}</span>
                          <span className="shrink-0 text-faint">{c.type}</span>
                          {c.piiSuggestion !== "NONE" && (
                            <Chip tone={pii[c.piiSuggestion].tone}>
                              {c.piiSuggestion === "HIDE" ? <EyeOff className="h-3 w-3" aria-hidden="true" /> : <ShieldAlert className="h-3 w-3" aria-hidden="true" />}
                              {pii[c.piiSuggestion].label}
                            </Chip>
                          )}
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-muted-foreground">{t("engineAdmin.databases.browse.piiNote")}</p>
                  </div>
                ) : (
                  <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t("engineAdmin.databases.browse.pick")}</p>
                )}
              </div>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>{t("engineAdmin.databases.browse.close")}</Button>
          <Button type="button" disabled={!table} onClick={createView}>{t("engineAdmin.databases.browse.createView")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
