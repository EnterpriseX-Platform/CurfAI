"use client";
/**
 * Data Sources drawer — live inside the Report Builder.
 *
 * Two tabs:
 *   - Connections: list of DataSource rows (shared across reports). Admins can
 *     add new sqlite or REST connections; a "Test" button pings REST base URLs.
 *   - Queries: the named queries on THIS report (report.dataSources). Each
 *     query picks an existing connection, then gets SQL or REST config
 *     depending on the connection kind. Changes flow through the Zustand
 *     store; save happens via the toolbar Save button.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, Database, Globe, RefreshCw, Play, Pencil, X as CloseIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/lib/toast";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useDesignerStore } from "@/lib/reporting/store";
import type { DataSourceDef } from "@/lib/reporting/schema";
import { InsertSnippetButton } from "./InsertSnippetButton";
import { ConnectionForm } from "@/components/connections/ConnectionForm";
import type { DataSourceListItem, EditingConnection } from "@/components/connections/types";

export function DataDrawer() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Database className="mr-1.5 h-4 w-4" /> Data
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[90vh] max-w-4xl flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0">
          <DialogTitle>Data Sources</DialogTitle>
          <DialogDescription>
            Manage connections (shared) and queries (specific to this report).
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <Tabs defaultValue="queries" className="flex min-h-0 flex-col">
            <TabsList className="mb-3 self-start">
              <TabsTrigger value="queries">Queries</TabsTrigger>
              <TabsTrigger value="connections">Connections</TabsTrigger>
            </TabsList>
            <TabsContent value="queries"><QueriesTab /></TabsContent>
            <TabsContent value="connections"><ConnectionsTab /></TabsContent>
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ==============================================================
// Queries tab
// ==============================================================

function QueriesTab() {
  const report = useDesignerStore((s) => s.report);
  const setReport = useDesignerStore((s) => s.setReport);
  const [connections, setConnections] = useState<DataSourceListItem[]>([]);
  const [selected, setSelected] = useState<string | null>(report.dataSources[0]?.id ?? null);

  useEffect(() => {
    fetch("/api/data-sources").then((r) => r.json()).then((j) => setConnections(j.items ?? []));
  }, []);

  const activeQuery = report.dataSources.find((q) => q.id === selected);

  function updateQueries(next: DataSourceDef[]) {
    setReport({ ...report, dataSources: next });
  }

  function addQuery() {
    const id = "ds_" + Math.random().toString(36).slice(2, 8);
    const q: DataSourceDef = {
      id,
      name: "New query",
      dataSourceId: connections[0]?.id ?? "",
      sql: "SELECT 1",
    };
    updateQueries([...report.dataSources, q]);
    setSelected(id);
  }

  function removeQuery(id: string) {
    updateQueries(report.dataSources.filter((q) => q.id !== id));
    if (selected === id) setSelected(report.dataSources[0]?.id ?? null);
  }

  function patchQuery(id: string, patch: Partial<DataSourceDef>) {
    updateQueries(report.dataSources.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  }

  const activeConnection = connections.find((c) => c.id === activeQuery?.dataSourceId);

  return (
    <div className="grid grid-cols-[240px_1fr] gap-4 min-h-[420px]">
      <aside className="flex flex-col gap-1 overflow-auto rounded-md border p-2">
        <div className="flex items-center justify-between px-1 pb-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Queries</span>
          <Button size="icon" variant="ghost" onClick={addQuery} title="Add query">
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        {report.dataSources.length === 0 && (
          <p className="p-2 text-xs text-muted-foreground">No queries yet. Click + to add one.</p>
        )}
        {report.dataSources.map((q) => (
          <button
            key={q.id}
            onClick={() => setSelected(q.id)}
            className={`flex items-center justify-between rounded px-2 py-1.5 text-left text-sm ${
              selected === q.id ? "bg-accent" : "hover:bg-accent/50"
            }`}
          >
            <span className="truncate">{q.name}</span>
            <span className="ml-2 font-mono text-[10px] text-muted-foreground">{q.id}</span>
          </button>
        ))}
      </aside>

      {activeQuery ? (
        <div className="flex flex-col gap-3 overflow-auto">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">{activeQuery.name}</h3>
            <Button size="sm" variant="ghost" onClick={() => removeQuery(activeQuery.id)}>
              <Trash2 className="mr-1.5 h-4 w-4" /> Remove
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <Input
                value={activeQuery.name}
                onChange={(e) => patchQuery(activeQuery.id, { name: e.target.value })}
              />
            </Field>
            <Field label="ID (stable key; used in block config)">
              <Input
                value={activeQuery.id}
                onChange={(e) => patchQuery(activeQuery.id, { id: e.target.value })}
              />
            </Field>
          </div>

          <Field label="Connection">
            <Select
              value={activeQuery.dataSourceId}
              onValueChange={(v) => patchQuery(activeQuery.id, { dataSourceId: v })}
            >
              <SelectTrigger><SelectValue placeholder="Pick a connection" /></SelectTrigger>
              <SelectContent>
                {connections.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.kind === "rest" ? "🌐 " : "🗄 "}{c.name}
                    {c.kind === "rest" && c.baseUrl ? ` — ${c.baseUrl}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {activeConnection?.kind === "rest" ? (
            <RestQueryEditor q={activeQuery} onChange={(p) => patchQuery(activeQuery.id, p)} />
          ) : (
            <SqlQueryEditor q={activeQuery} onChange={(p) => patchQuery(activeQuery.id, p)} />
          )}
          {activeConnection && (activeConnection.kind === "sqlite" || activeConnection.kind === "excel") && (
            <AttachesEditor
              q={activeQuery}
              connections={connections}
              onChange={(p) => patchQuery(activeQuery.id, p)}
            />
          )}
          {/* Tier 2 cross-source: works for any kind, including REST/Postgres
              primaries that can't use SQLite ATTACH. */}
          <JoinsEditor
            q={activeQuery}
            siblings={report.dataSources.filter((q) => q.id !== activeQuery.id)}
            onChange={(p) => patchQuery(activeQuery.id, p)}
          />
          <QueryPreview
            query={activeQuery}
            reportParams={(report.parameters ?? []).reduce<Record<string, unknown>>((acc, p) => {
              if (p.default !== undefined) acc[p.name] = p.default;
              return acc;
            }, {})}
          />
        </div>
      ) : (
        <div className="flex items-center justify-center rounded-md border border-dashed p-12 text-sm text-muted-foreground">
          Select or add a query on the left.
        </div>
      )}
    </div>
  );
}

function SqlQueryEditor({
  q, onChange,
}: { q: DataSourceDef; onChange: (patch: Partial<DataSourceDef>) => void }) {
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between">
        <Label>SQL (use :name for parameters)</Label>
        <InsertSnippetButton
          kind="sql"
          // Replace when the field is empty, append on a new line otherwise.
          // Keeps the common "drop in a saved query" flow one click; iteration
          // doesn't lose existing context.
          onInsert={(body) => {
            const cur = (q.sql ?? "").trim();
            onChange({ sql: cur ? `${cur}\n\n${body}` : body });
          }}
        />
      </div>
      <textarea
        className="min-h-[160px] rounded-md border border-input bg-background p-2 font-mono text-xs"
        value={q.sql ?? ""}
        onChange={(e) => onChange({ sql: e.target.value })}
        placeholder="SELECT region, SUM(revenue) AS revenue FROM sales WHERE sale_date BETWEEN :from AND :to GROUP BY region"
      />
    </div>
  );
}

function RestQueryEditor({
  q, onChange,
}: { q: DataSourceDef; onChange: (patch: Partial<DataSourceDef>) => void }) {
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-[120px_1fr] gap-3">
        <Field label="Method">
          <Select
            value={q.method ?? "GET"}
            onValueChange={(v) => onChange({ method: v as any })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Path (use :name for path params; other params become querystring on GET)">
          <Input
            value={q.path ?? ""}
            onChange={(e) => onChange({ path: e.target.value })}
            placeholder="/orders/:customerId"
          />
        </Field>
      </div>
      <Field label="JSON path (dotted path to the rows array; blank = root)">
        <Input
          value={q.jsonPath ?? ""}
          onChange={(e) => onChange({ jsonPath: e.target.value })}
          placeholder="$.data.items"
        />
      </Field>
      {["POST", "PUT", "PATCH"].includes(q.method ?? "GET") && (
        <Field label="Body (JSON; {{param.x}} tokens are substituted)">
          <textarea
            className="min-h-[120px] rounded-md border border-input bg-background p-2 font-mono text-xs"
            value={q.body ?? ""}
            onChange={(e) => onChange({ body: e.target.value })}
            placeholder='{"from":"{{param.from}}","to":"{{param.to}}"}'
          />
        </Field>
      )}
    </div>
  );
}

// ==============================================================
// Connections tab
// ==============================================================

function ConnectionsTab() {
  const { push } = useToast();
  const [items, setItems] = useState<DataSourceListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<EditingConnection | null>(null);
  const formRef = useRef<HTMLDivElement | null>(null);
  const report = useDesignerStore((s) => s.report);
  const setReport = useDesignerStore((s) => s.setReport);

  function handleSaveAsQuery(spec: { connectionId: string; method: string; path: string; body: string }) {
    const id = "ds_" + Math.random().toString(36).slice(2, 8);
    const q: DataSourceDef = {
      id,
      name: `Query from ${items.find((c) => c.id === spec.connectionId)?.name ?? "connection"}`,
      dataSourceId: spec.connectionId,
      method: spec.method as any,
      path: spec.path,
      body: spec.body,
    };
    setReport({ ...report, dataSources: [...report.dataSources, q] });
    push({
      variant: "success",
      title: "Query saved",
      description: "Switch to the Queries tab to tweak it and bind blocks.",
    });
  }

  async function refresh() {
    setBusy(true);
    const r = await fetch("/api/data-sources").then((r) => r.json());
    setItems(r.items ?? []);
    setBusy(false);
  }
  useEffect(() => { refresh(); }, []);

  async function startEdit(id: string) {
    const r = await fetch(`/api/data-sources/${id}`);
    if (!r.ok) {
      push({ variant: "destructive", title: "Could not load connection", description: await r.text() });
      return;
    }
    const data = await r.json();
    setEditing(data);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  async function removeConnection(id: string) {
    if (!confirm("Delete this connection? Reports that reference it will break.")) return;
    const r = await fetch(`/api/data-sources/${id}`, { method: "DELETE" });
    if (!r.ok) push({ variant: "destructive", title: "Delete failed", description: await r.text() });
    if (editing?.id === id) setEditing(null);
    refresh();
  }

  return (
    <div className="grid gap-4">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium">Existing connections</h3>
          <Button size="sm" variant="ghost" onClick={refresh} disabled={busy}>
            <RefreshCw className={`mr-1.5 h-4 w-4 ${busy ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">Kind</th>
                <th className="px-3 py-2 text-left">Endpoint</th>
                <th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className={`border-t ${editing?.id === it.id ? "bg-primary/5" : ""}`}>
                  <td className="px-3 py-2">{it.name}</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1">
                      {it.kind === "rest" ? <Globe className="h-3.5 w-3.5" /> : <Database className="h-3.5 w-3.5" />}
                      {it.kind}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {it.kind === "rest" ? (it.baseUrl ?? "—") : "(local file)"}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center justify-end gap-0.5">
                      <Button size="icon" variant="ghost" onClick={() => startEdit(it.id)} title="Edit">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => removeConnection(it.id)} title="Delete">
                        <Trash2 className="h-4 w-4 text-destructive/80" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr><td colSpan={4} className="p-8 text-center text-muted-foreground">No connections yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section ref={formRef}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium">{editing ? `Edit "${editing.name}"` : "Add connection"}</h3>
          {editing && (
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              <CloseIcon className="mr-1.5 h-4 w-4" /> Cancel
            </Button>
          )}
        </div>
        <ConnectionForm
          editing={editing}
          onSaved={() => { setEditing(null); refresh(); }}
          onSaveAsQuery={handleSaveAsQuery}
          allowedKinds={["rest", "sqlite"]}
        />
      </section>
    </div>
  );
}

// ==============================================================
// Attaches editor — cross-source JOIN authoring
// ==============================================================

/**
 * Per-query "Attach foreign sources" panel. Lets the author bind extra
 * sqlite/excel connections to this query under a SQL alias so the SQL can
 * reference `<alias>.<table>` for cross-source JOINs.
 *
 * Restricts foreign options to file-backed kinds (sqlite, excel) — REST
 * connections can't be ATTACHed by SQLite. Excludes the primary itself
 * (no self-attach), and prevents alias collisions client-side.
 */
function AttachesEditor({
  q, connections, onChange,
}: {
  q: DataSourceDef;
  connections: DataSourceListItem[];
  onChange: (patch: Partial<DataSourceDef>) => void;
}) {
  const attaches = q.attaches ?? [];
  const usedAliases = new Set(attaches.map((a) => a.alias.toLowerCase()));

  // Foreign sources eligible to attach: file-backed kinds, excluding the
  // primary itself.
  const candidates = connections.filter(
    (c) => (c.kind === "sqlite" || c.kind === "excel") && c.id !== q.dataSourceId,
  );

  // Local "draft" state for the next attach being added — committed when
  // the user clicks Add. Keeps the alias and source picks separate from
  // the saved attaches[] so accidental clicks don't pollute the report.
  const [draftDsId, setDraftDsId] = useState<string>("");
  const [draftAlias, setDraftAlias] = useState<string>("");

  const aliasOk = /^(?!main$|temp$)[a-z_][a-z0-9_]*$/i.test(draftAlias);
  const aliasFree = !usedAliases.has(draftAlias.toLowerCase());
  const canAdd = !!draftDsId && !!draftAlias && aliasOk && aliasFree;

  function add() {
    if (!canAdd) return;
    onChange({ attaches: [...attaches, { dataSourceId: draftDsId, alias: draftAlias }] });
    setDraftDsId("");
    setDraftAlias("");
  }

  function remove(idx: number) {
    onChange({ attaches: attaches.filter((_, i) => i !== idx) });
  }

  function nameFor(id: string) {
    return connections.find((c) => c.id === id)?.name ?? id;
  }

  return (
    <div className="grid gap-2 rounded-md border border-dashed border-border/80 p-3">
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Attach foreign sources
        </p>
        <p className="text-[11px] text-muted-foreground">
          Cross-source JOIN. SQL references <span className="font-mono">{`<alias>.<table>`}</span>.
        </p>
      </div>

      {attaches.length > 0 && (
        <div className="grid gap-1">
          {attaches.map((a, idx) => (
            <div key={idx} className="flex items-center justify-between rounded-md border bg-card px-2 py-1.5 text-xs">
              <div className="flex items-center gap-2">
                <span className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px]">
                  {a.alias}
                </span>
                <span className="text-muted-foreground">→</span>
                <span className="font-medium">{nameFor(a.dataSourceId)}</span>
              </div>
              <Button size="icon" variant="ghost" onClick={() => remove(idx)} title="Remove attach">
                <CloseIcon className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No other sqlite/excel connections to attach. (REST connections can't be ATTACHed.)
        </p>
      ) : (
        <div className="grid grid-cols-[1fr_140px_auto] gap-2 text-xs">
          <Select value={draftDsId} onValueChange={setDraftDsId}>
            <SelectTrigger><SelectValue placeholder="Pick a source…" /></SelectTrigger>
            <SelectContent>
              {candidates.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.kind === "excel" ? "📊 " : "🗄 "}{c.name}
                  {c.kind === "excel" && c.originalFilename ? ` — ${c.originalFilename}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={draftAlias}
            onChange={(e) => setDraftAlias(e.target.value)}
            placeholder="alias e.g. m"
            className="font-mono text-xs"
          />
          <Button size="sm" onClick={add} disabled={!canAdd}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add
          </Button>
        </div>
      )}
      {draftAlias && !aliasOk && (
        <p className="text-[11px] text-destructive">
          Alias must be a SQL identifier (letters/digits/underscore, can't start with a digit, can't be "main" or "temp").
        </p>
      )}
      {draftAlias && aliasOk && !aliasFree && (
        <p className="text-[11px] text-destructive">Alias already used for another attach on this query.</p>
      )}
    </div>
  );
}

// ==============================================================
// Joins editor — cross-source hash JOIN authoring (Tier 2)
// ==============================================================

/**
 * Per-query "Cross-source joins" panel. Lets the author bind another query
 * (any kind) onto this one via an in-runner hash join. Distinct from
 * AttachesEditor which uses SQLite ATTACH (file-backed only).
 *
 * Each row picks a sibling query (must already exist in the report's
 * dataSources[]), a join type (Left | Inner), the column names to join on
 * (free-text — users copy them from the Run query preview above), and an
 * alias used to prefix joined columns in the merged output.
 */
function JoinsEditor({
  q, siblings, onChange,
}: {
  q: DataSourceDef;
  siblings: DataSourceDef[];
  onChange: (patch: Partial<DataSourceDef>) => void;
}) {
  const joins = q.joins ?? [];
  const usedAliases = new Set([
    ...joins.map((j) => j.alias.toLowerCase()),
    // Don't collide with attaches[] aliases — they share the column-prefix
    // namespace in the merged output.
    ...(q.attaches ?? []).map((a) => a.alias.toLowerCase()),
  ]);

  const [draftQueryId, setDraftQueryId] = useState<string>("");
  const [draftType, setDraftType] = useState<"left" | "inner">("left");
  const [draftLeftKey, setDraftLeftKey] = useState<string>("");
  const [draftRightKey, setDraftRightKey] = useState<string>("");
  const [draftAlias, setDraftAlias] = useState<string>("");

  const aliasOk = !draftAlias || /^(?!main$|temp$)[a-z_][a-z0-9_]*$/i.test(draftAlias);
  const aliasFree = !usedAliases.has(draftAlias.toLowerCase());
  const canAdd = !!draftQueryId && !!draftLeftKey && !!draftRightKey && !!draftAlias && aliasOk && aliasFree;

  function add() {
    if (!canAdd) return;
    onChange({
      joins: [
        ...joins,
        {
          type: draftType,
          queryId: draftQueryId,
          on: { left: draftLeftKey, right: draftRightKey },
          alias: draftAlias,
        },
      ],
    });
    setDraftQueryId("");
    setDraftType("left");
    setDraftLeftKey("");
    setDraftRightKey("");
    setDraftAlias("");
  }
  function remove(idx: number) {
    onChange({ joins: joins.filter((_, i) => i !== idx) });
  }
  function nameFor(id: string) {
    return siblings.find((s) => s.id === id)?.name ?? id;
  }

  return (
    <div className="grid gap-2 rounded-md border border-dashed border-border/80 p-3">
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Cross-source joins
        </p>
        <p className="text-[11px] text-muted-foreground">
          Hash join over another query's rows. Works across any source kinds.
        </p>
      </div>

      {joins.length > 0 && (
        <div className="grid gap-1">
          {joins.map((j, idx) => (
            <div key={idx} className="flex items-center justify-between rounded-md border bg-card px-2 py-1.5 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] uppercase">
                  {j.type}
                </span>
                <span className="font-medium">{nameFor(j.queryId)}</span>
                <span className="text-muted-foreground">on</span>
                <span className="rounded border border-border bg-muted/30 px-1.5 py-0.5 font-mono text-[10px]">
                  primary.{j.on.left}
                </span>
                <span className="text-muted-foreground">=</span>
                <span className="rounded border border-border bg-muted/30 px-1.5 py-0.5 font-mono text-[10px]">
                  {j.alias}.{j.on.right}
                </span>
              </div>
              <Button size="icon" variant="ghost" onClick={() => remove(idx)} title="Remove join">
                <CloseIcon className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {siblings.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No other queries in this report yet. Add a second query first, then come back here to join them.
        </p>
      ) : (
        <div className="grid gap-2">
          <div className="grid grid-cols-[120px_1fr_140px] gap-2 text-xs">
            <Select value={draftType} onValueChange={(v) => setDraftType(v as "left" | "inner")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="left">Left join</SelectItem>
                <SelectItem value="inner">Inner join</SelectItem>
              </SelectContent>
            </Select>
            <Select value={draftQueryId} onValueChange={setDraftQueryId}>
              <SelectTrigger><SelectValue placeholder="Pick a sibling query…" /></SelectTrigger>
              <SelectContent>
                {siblings.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={draftAlias}
              onChange={(e) => setDraftAlias(e.target.value)}
              placeholder="alias e.g. c"
              className="font-mono text-xs"
            />
          </div>
          <div className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2 text-xs">
            <div className="grid gap-1">
              <span className="text-[10px] uppercase text-muted-foreground">primary column</span>
              <Input
                value={draftLeftKey}
                onChange={(e) => setDraftLeftKey(e.target.value)}
                placeholder="e.g. customer_id"
                className="font-mono text-xs"
              />
            </div>
            <span className="pt-4 text-muted-foreground">=</span>
            <div className="grid gap-1">
              <span className="text-[10px] uppercase text-muted-foreground">joined column</span>
              <Input
                value={draftRightKey}
                onChange={(e) => setDraftRightKey(e.target.value)}
                placeholder="e.g. id"
                className="font-mono text-xs"
              />
            </div>
            <Button size="sm" onClick={add} disabled={!canAdd} className="self-end">
              <Plus className="mr-1 h-3.5 w-3.5" /> Add
            </Button>
          </div>
          {draftAlias && !aliasOk && (
            <p className="text-[11px] text-destructive">
              Alias must be a SQL identifier (letters/digits/underscore, can't start with a digit, can't be "main" or "temp").
            </p>
          )}
          {draftAlias && aliasOk && !aliasFree && (
            <p className="text-[11px] text-destructive">Alias collides with another join or attach on this query.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ==============================================================
// Tiny form helper
// ==============================================================

function Field({ label, children }: { label: string; children: import("react").ReactNode }) {
  return (
    <div className="grid gap-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}


function QueryPreview({ query, reportParams }: { query: DataSourceDef; reportParams: Record<string, unknown> }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<null | {
    rows?: any[];
    columns?: string[];
    totalRows?: number;
    truncated?: boolean;
    durationMs?: number;
    error?: string;
  }>(null);

  async function run() {
    setBusy(true);
    try {
      const r = await fetch("/api/reports/preview-query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, params: reportParams }),
      });
      setResult(await r.json());
    } catch (e: any) {
      setResult({ error: e?.message ?? "Request failed" });
    } finally {
      setBusy(false);
    }
  }

  const missingBinding = !query.dataSourceId
    || (query.sql == null && query.path == null);

  return (
    <div className="grid gap-2 rounded-md border border-dashed border-border/80 p-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Run query
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={run}
          disabled={busy || missingBinding}
          type="button"
          title={missingBinding ? "Pick a connection and define the query first" : undefined}
        >
          {busy
            ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Running…</>
            : <><Play className="mr-1.5 h-4 w-4" /> Run with current params</>}
        </Button>
      </div>

      {result && (
        result.error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
            <div className="mb-1 font-medium">Query failed</div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-foreground/80">{result.error}</pre>
          </div>
        ) : (
          <div className="rounded-md border border-success/40 bg-success/5 p-2 text-xs">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-medium">
                {result.totalRows ?? 0} row{(result.totalRows ?? 0) === 1 ? "" : "s"}
                {result.truncated ? ` (showing ${result.rows?.length ?? 0})` : ""}
                {" · "}{result.durationMs ?? 0}ms
              </span>
              <span className="text-[10px] text-muted-foreground">{(result.columns ?? []).length} columns</span>
            </div>
            {result.rows && result.rows.length > 0 ? (
              <div className="max-h-64 overflow-auto rounded border border-border bg-background">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted text-muted-foreground">
                    <tr>
                      {(result.columns ?? []).map((c) => (
                        <th key={c} className="border-b border-border px-2 py-1.5 text-left font-medium">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i} className={i % 2 === 1 ? "bg-muted/30" : ""}>
                        {(result.columns ?? []).map((c) => (
                          <td key={c} className="max-w-[200px] truncate border-b border-border/50 px-2 py-1 font-mono">
                            {renderCell(row[c])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="py-4 text-center text-xs text-muted-foreground">Query returned 0 rows.</div>
            )}
          </div>
        )
      )}
    </div>
  );
}


function renderCell(v: unknown): any {
  if (v == null) return <span className="text-muted-foreground italic">null</span>;
  if (typeof v === "object") {
    let json: string;
    try { json = JSON.stringify(v); } catch { json = String(v); }
    const truncated = json.length > 120 ? json.slice(0, 120) + "…" : json;
    return <span title={json} className="text-foreground/80">{truncated}</span>;
  }
  return String(v);
}
