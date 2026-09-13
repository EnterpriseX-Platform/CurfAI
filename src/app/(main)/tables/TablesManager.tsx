"use client";
import { useT } from "@/lib/i18n/LocaleContext";

/**
 * TablesManager — client component that owns the Tables browser UI.
 *
 * Sections:
 *   1. Upload box (always at top — first-timer friendly)
 *   2. Tables grid: each card → preview, schema, source badge, row count
 *   3. Ingest tokens panel (collapsible) for webhook + scheduled-pull producers
 *
 * State is initialized from server-side data (via initialTables /
 * initialTokens props). Mutations re-fetch the relevant slice.
 */
import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Database, Upload, Globe, Webhook, FileSpreadsheet, Trash2, Loader2, Plus,
  KeyRound, Copy, Check, X, ExternalLink, AlertTriangle, ArrowRight, Sparkles,
  Search, Eye,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogIcon, DialogBody, DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Schema = Array<{ name: string; type: string }>;

type TableRow = {
  id: string;
  name: string;
  sourceKind: "upload" | "webhook" | "rest_pull" | "manual";
  schema: Schema;
  rowCount: number;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
};

type TokenRow = {
  id: string;
  label: string;
  tableName: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
};

const SOURCE_ICONS = {
  upload:    FileSpreadsheet,
  webhook:   Webhook,
  rest_pull: Globe,
  manual:    Database,
} as const;

const SOURCE_LABEL_KEYS = {
  upload:    "tables.source.upload",
  webhook:   "tables.source.webhook",
  rest_pull: "tables.source.restPull",
  manual:    "tables.source.manual",
} as const;

export function TablesManager({
  initialTables, initialTokens,
}: {
  initialTables: TableRow[];
  initialTokens: TokenRow[];
}) {
  const { t } = useT();
  const router = useRouter();
  const [tables, setTables] = useState<TableRow[]>(initialTables);
  const [tokens, setTokens] = useState<TokenRow[]>(initialTokens);
  const [showTokens, setShowTokens] = useState(false);

  async function refreshTables() {
    const r = await fetch("/api/lake/tables", { cache: "no-store", credentials: "include" });
    if (r.ok) {
      const j = await r.json();
      setTables(j.items ?? []);
    }
  }

  async function deleteTable(name: string) {
    if (!confirm(t("tables.card.deleteConfirm").replace("{name}", name))) return;
    const r = await fetch(`/api/lake/tables/${encodeURIComponent(name)}`, {
      method: "DELETE", credentials: "include",
    });
    if (r.ok) {
      setTables((xs) => xs.filter((row) => row.name !== name));
      router.refresh();
    }
  }

  return (
    <div className="space-y-6">
      <UploadCard onUploaded={async () => { await refreshTables(); router.refresh(); }} />

      {/* Vector DB — "Find by meaning". Renders only when the user has at
          least one table (otherwise there's nothing to search). The panel
          hides itself when the query is short or returns no hits, so it
          stays invisible in the empty-state and the tenant-has-no-vectors
          cases. */}
      {tables.length > 0 && <FindByMeaningPanel />}

      {tables.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {tables.map((row) => (
            <TableCard key={row.id} row={row} onDelete={() => deleteTable(row.name)} />
          ))}
        </div>
      )}

      <section className="rounded-lg border border-border bg-card p-5 shadow-xs">
        <header className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setShowTokens((v) => !v)}
            className="flex items-center gap-2 text-left"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <KeyRound className="h-3.5 w-3.5" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">{t("tables.tokensHeading")}</h2>
              <p className="text-[11px] text-muted-foreground">
                {tokens.length === 0
                  ? t("tables.tokensEmptyHint")
                  : t("tables.activeTokensCount")
                      .replace("{n}", String(tokens.length))
                      .replace("{plural}", tokens.length === 1 ? "" : "s")}
              </p>
            </div>
          </button>
          <ChevronToggle expanded={showTokens} onClick={() => setShowTokens((v) => !v)} />
        </header>

        {showTokens && (
          <TokensPanel
            tokens={tokens}
            availableTables={tables.map((row) => row.name)}
            onChanged={async () => {
              const r = await fetch("/api/lake/tokens", { credentials: "include" });
              if (r.ok) { const j = await r.json(); setTokens((j.items ?? []).filter((tok: any) => !tok.revokedAt)); }
            }}
          />
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload card
// ---------------------------------------------------------------------------

type PreviewColumn = {
  name: string;
  type: "text" | "number" | "boolean" | "date" | "unknown";
  sample?: any;
  /** Set for date columns: which way round the file's slash dates read. */
  dateOrder?: "mdy" | "dmy";
};
type PreviewData = {
  suggestedName: string;
  columns: PreviewColumn[];
  sampleRows: Array<Record<string, unknown>>;
  rowCount: number;
  /** Workbook sheet names; empty for CSV/JSON. */
  sheets: string[];
  /** The sheet this preview was read from; null for CSV/JSON. */
  sheet: string | null;
  /** Date columns whose values don't say whether they're day- or month-first. */
  ambiguousDateColumns: string[];
};

/**
 * Upload used to commit blind: pick a file, it's a table. The first
 * feedback about how a column got typed was an empty chart-type picker
 * somewhere else in the product entirely, with nothing explaining why.
 *
 * Now file selection previews first (POST .../preview — parses, infers,
 * writes nothing) and shows the detected schema with a per-column type
 * override before anything is created. Confirming re-sends the SAME File
 * object the browser already holds, plus any corrected types, to the real
 * create endpoint — no server-side session needed to bridge preview and
 * commit across two requests.
 */
function UploadCard({ onUploaded }: { onUploaded: () => void | Promise<void> }) {
  const { t } = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);

  async function startPreview(file: File) {
    setPreviewing(true); setPreviewError(null);
    try {
      const j = await fetchPreview(file);
      setPendingFile(file);
      setPreview(j);
    } catch (e: any) {
      setPreviewError(e?.message ?? t("tables.upload.failedFallback"));
    } finally {
      setPreviewing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault(); setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void startPreview(f);
  }

  function closePreview() {
    setPreview(null);
    setPendingFile(null);
  }

  return (
    <section
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
      className={
        "rounded-lg border-2 border-dashed bg-card p-5 transition-colors " +
        (drag ? "border-primary bg-primary/5" : "border-border")
      }
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-6">
        <div className="flex items-center gap-3 md:flex-1">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Upload className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">{t("tables.upload.heading")}</h2>
            <p className="text-[11px] text-muted-foreground">
              {t("tables.upload.subtext")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept=".csv,.tsv,.txt,.xlsx,.xls,.json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void startPreview(f);
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={previewing}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {previewing ? t("tables.upload.previewing") : t("action.upload")}
          </button>
        </div>
      </div>
      {previewError && (
        <div className="mt-3 flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{previewError}</span>
        </div>
      )}

      {preview && pendingFile && (
        <UploadPreviewDialog
          file={pendingFile}
          preview={preview}
          onClose={closePreview}
          onCreated={async () => { closePreview(); await onUploaded(); }}
        />
      )}
    </section>
  );
}

/**
 * Day-first / month-first for one date column. Shown on every date column
 * so a wrong auto-detection is always correctable, and called out only
 * when the file itself proved nothing either way.
 */
function DateOrderToggle({
  value, unproven, onChange,
}: {
  value: "mdy" | "dmy";
  unproven: boolean;
  onChange: (v: "mdy" | "dmy") => void;
}) {
  const { t } = useT();
  return (
    <div className="mt-1 flex items-center gap-1">
      {(["dmy", "mdy"] as const).map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          title={t(o === "dmy" ? "tables.preview.dmyTitle" : "tables.preview.mdyTitle")}
          className={
            "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors " +
            (value === o
              ? "bg-primary-soft text-primary"
              : "text-muted-foreground hover:bg-muted")
          }
        >
          {t(o === "dmy" ? "tables.preview.dmy" : "tables.preview.mdy")}
        </button>
      ))}
      {unproven && (
        <span className="text-[10px] text-warning" title={t("tables.preview.dateUnprovenHint")}>
          {t("tables.preview.dateUnproven")}
        </span>
      )}
    </div>
  );
}

async function fetchPreview(file: File, sheet?: string): Promise<PreviewData> {
  const fd = new FormData();
  fd.append("file", file);
  if (sheet) fd.append("sheet", sheet);
  const r = await fetch("/api/lake/tables/preview", { method: "POST", credentials: "include", body: fd });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);
  return j as PreviewData;
}

const TYPE_OPTIONS: Array<{ value: PreviewColumn["type"]; labelKey: string }> = [
  { value: "text",    labelKey: "tableManage.retype.text" },
  { value: "number",  labelKey: "tableManage.retype.number" },
  { value: "date",    labelKey: "tableManage.retype.date" },
  { value: "boolean", labelKey: "tableManage.retype.boolean" },
];

function UploadPreviewDialog({
  file, preview: initialPreview, onClose, onCreated,
}: {
  file: File;
  preview: PreviewData;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const { t } = useT();
  const [preview, setPreview] = useState(initialPreview);
  const [switching, setSwitching] = useState(false);
  const [name, setName] = useState(preview.suggestedName);
  const [types, setTypes] = useState<Record<string, PreviewColumn["type"]>>(
    // "unknown" (an entirely empty column) isn't a selectable option below —
    // same exclusion retypeColumn applies, since it's never a meaningful
    // target, only something a column starts as. Defaults to text, the
    // always-safe choice.
    () => Object.fromEntries(preview.columns.map((c) => [c.name, c.type === "unknown" ? "text" : c.type])),
  );
  const [dateOrders, setDateOrders] = useState<Record<string, "mdy" | "dmy">>(
    () => Object.fromEntries(
      preview.columns.filter((c) => c.type === "date").map((c) => [c.name, c.dateOrder ?? "mdy"]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-previews on the server rather than parsing the workbook in the
  // browser: one parser, one set of type-inference rules, so the sheet you
  // confirm is typed by exactly the code that will import it.
  async function switchSheet(sheet: string) {
    if (sheet === preview.sheet) return;
    setSwitching(true); setError(null);
    try {
      const next = await fetchPreview(file, sheet);
      setPreview(next);
      setName(next.suggestedName);
      setTypes(Object.fromEntries(next.columns.map((c) => [c.name, c.type === "unknown" ? "text" : c.type])));
      setDateOrders(Object.fromEntries(
        next.columns.filter((c) => c.type === "date").map((c) => [c.name, c.dateOrder ?? "mdy"]),
      ));
    } catch (e: any) {
      setError(e?.message ?? t("tables.upload.failedFallback"));
    } finally {
      setSwitching(false);
    }
  }

  async function create() {
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (name.trim()) fd.append("name", name.trim());
      if (preview.sheet) fd.append("sheet", preview.sheet);
      fd.append("columnTypes", JSON.stringify(types));
      fd.append("columnDateOrders", JSON.stringify(dateOrders));
      const r = await fetch("/api/lake/tables", { method: "POST", credentials: "include", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);
      await onCreated();
    } catch (e: any) {
      setError(e?.message ?? t("tables.upload.failedFallback"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogIcon variant="primary"><Eye className="h-4 w-4" /></DialogIcon>
          <div>
            <DialogTitle>{t("tables.preview.heading")}</DialogTitle>
            <DialogDescription>
              {t("tables.preview.subtext")
                .replace("{rows}", preview.rowCount.toLocaleString())
                .replace("{cols}", String(preview.columns.length))}
            </DialogDescription>
          </div>
        </DialogHeader>

        <DialogBody className="space-y-3">
          {preview.sheets.length > 1 && (
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                {t("tables.preview.sheetLabel").replace("{count}", String(preview.sheets.length))}
              </label>
              <Select
                value={preview.sheet ?? undefined}
                onValueChange={(v) => void switchSheet(v)}
                disabled={busy || switching}
              >
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {preview.sheets.map((s) => (
                    <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                {t("tables.preview.sheetHint")}
              </p>
            </div>
          )}

          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
              {t("tables.upload.namePlaceholder")}
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={busy}
            />
          </div>

          <div className={"max-h-[45vh] overflow-y-auto rounded-md border border-border transition-opacity " + (switching ? "opacity-40" : "")}>
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted/60 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">{t("tableDetail.colHeaderColumn")}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("tableDetail.colHeaderType")}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("tableDetail.colHeaderSample")}</th>
                </tr>
              </thead>
              <tbody>
                {preview.columns.map((c) => (
                  <tr key={c.name} className="border-t border-border">
                    <td className="px-3 py-1.5 font-mono">{c.name}</td>
                    <td className="px-3 py-1.5">
                      <Select
                        value={types[c.name]}
                        onValueChange={(v) => setTypes((cur) => ({ ...cur, [c.name]: v as PreviewColumn["type"] }))}
                      >
                        <SelectTrigger className="h-7 w-28 text-[11px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TYPE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value} className="text-[11px]">
                              {t(opt.labelKey)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {types[c.name] === "date" && (
                        <DateOrderToggle
                          value={dateOrders[c.name] ?? "mdy"}
                          // Only nag where the file genuinely didn't say. A
                          // column with a day above 12 in it already proved
                          // its own order and needs no attention drawn.
                          unproven={preview.ambiguousDateColumns.includes(c.name)}
                          onChange={(v) => setDateOrders((cur) => ({ ...cur, [c.name]: v }))}
                        />
                      )}
                    </td>
                    <td className="px-3 py-1.5 truncate font-mono text-[11px] text-muted-foreground">
                      {c.sample == null ? <span className="italic">{t("tableDetail.nullLabel")}</span> : String(c.sample).slice(0, 40)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {error && (
            <div className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            {t("action.cancel")}
          </button>
          <button
            type="button"
            onClick={create}
            disabled={busy || switching || !name.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {t("tables.preview.createButton")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Find by meaning — semantic column search (Vector DB schema_col)
// ---------------------------------------------------------------------------

type ColumnHit = {
  tableId: string;
  tableName: string;
  columnName: string;
  columnType: string | null;
  score: number;
  sample: string | null;
};

function FindByMeaningPanel() {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ColumnHit[]>([]);
  const [loading, setLoading] = useState(false);
  // Three "no hits" states the UI distinguishes between:
  //   "ok"         — search ran fine, just no matches above the score floor
  //   "disabled"   — backend returned vector_db_off (env flag not set)
  //   "error"      — network / 500 / abort that wasn't a retype
  // Renders a different message per state so the user understands
  // whether to wait, retry, or accept it.
  const [emptyReason, setEmptyReason] = useState<"ok" | "disabled" | "error">("ok");
  // The endpoint enforces a 4-char floor; we mirror it client-side so we
  // don't fire a request on every keystroke during the initial type.
  const MIN_CHARS = 4;
  const fetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (fetchTimer.current) clearTimeout(fetchTimer.current);
    const q = query.trim();
    if (q.length < MIN_CHARS) {
      setHits([]); setLoading(false);
      return;
    }
    setLoading(true);
    fetchTimer.current = setTimeout(async () => {
      // Cancel any in-flight request — the user has typed past it.
      if (abortRef.current) abortRef.current.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const r = await fetch("/api/lake/tables/search-columns?q=" + encodeURIComponent(q), {
          credentials: "include",
          signal: ac.signal,
        });
        if (!r.ok) {
          setHits([]); setEmptyReason("error");
          return;
        }
        const j = await r.json();
        const list = Array.isArray(j.hits) ? j.hits : [];
        setHits(list);
        setEmptyReason(j.note === "vector_db_off" ? "disabled" : "ok");
      } catch (e: any) {
        // Aborts are normal — the user typed past us. Don't surface
        // them as errors. Anything else is worth telling the user
        // about so they know to retry.
        if (e?.name !== "AbortError") setEmptyReason("error");
      } finally {
        if (abortRef.current === ac) setLoading(false);
      }
    }, 350);
    return () => { if (fetchTimer.current) clearTimeout(fetchTimer.current); };
  }, [query]);

  const longEnough = query.trim().length >= MIN_CHARS;
  // Render the results region when there's a real reason to show it —
  // hits to render, loading, or a status worth surfacing (disabled /
  // error). Empty + "ok" stays silent because absence of hits doesn't
  // need a message — it just means nothing matched.
  const showResults = longEnough && (loading || hits.length > 0 || emptyReason !== "ok");

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-xs">
      <label htmlFor="tables-find-by-meaning" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Sparkles className="h-3 w-3" />
        {t("tables.findByMeaning.label")}
      </label>
      <div className="relative mt-2">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
        <input
          id="tables-find-by-meaning"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("tables.findByMeaning.placeholder")}
          className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      {showResults && (
        <ul className="mt-3 flex flex-col gap-1">
          {loading && hits.length === 0 && (
            <li className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("tables.findByMeaning.searching")}
            </li>
          )}
          {!loading && hits.length === 0 && emptyReason === "disabled" && (
            <li className="px-2 py-2 text-xs text-muted-foreground">
              {t("tables.findByMeaning.disabledPart1")} <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">CURF_VECTOR_DB=on</code> {t("tables.findByMeaning.disabledPart2")} <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">npm run db:embed-backfill</code> {t("tables.findByMeaning.disabledPart3")}
            </li>
          )}
          {!loading && hits.length === 0 && emptyReason === "error" && (
            <li className="flex items-center gap-2 px-2 py-2 text-xs text-destructive">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {t("tables.findByMeaning.error")}
            </li>
          )}
          {hits.map((h) => (
            <li key={`${h.tableId}:${h.columnName}`}>
              <Link
                href={`/tables/${encodeURIComponent(h.tableName)}#col-${encodeURIComponent(h.columnName)}`}
                className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground/90 transition-colors hover:bg-muted"
              >
                <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{h.tableName}</span>
                  <span className="mx-1.5 text-muted-foreground/60">·</span>
                  <span>{h.columnName}</span>
                  {h.columnType && (
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {h.columnType}
                    </span>
                  )}
                  {h.sample && (
                    <span className="ml-2 truncate text-[11px] text-muted-foreground/80">
                      {h.sample}
                    </span>
                  )}
                </span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {Math.round(h.score * 100)}%
                </span>
                <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Empty state + per-table card
// ---------------------------------------------------------------------------

function EmptyState() {
  const { t } = useT();
  return (
    <section className="rounded-lg border border-dashed border-border bg-muted/20 p-10 text-center">
      <Database className="mx-auto h-8 w-8 text-muted-foreground/60" />
      <h3 className="mt-3 text-sm font-semibold">{t("tables.empty")}</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("tables.empty.subtext")}
      </p>
    </section>
  );
}

function TableCard({ row, onDelete }: { row: TableRow; onDelete: () => void }) {
  const { t } = useT();
  const Icon = SOURCE_ICONS[row.sourceKind] ?? Database;
  const [generating, setGenerating] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);

  async function autoGenerate(e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation();
    setGenerating(true); setAutoError(null);
    try {
      const r = await fetch("/api/reports/auto-generate", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        // The /tables list shortcut always publishes — different intent
        // from the detail-page button (which lets the user opt out).
        body: JSON.stringify({ lakeTable: row.name, publish: true }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);
      // Hand the public URL to the new report's first render via the
      // same sessionStorage key AutoCurfPublishedBanner reads.
      if (j.publicAppUrl && typeof window !== "undefined") {
        window.sessionStorage.setItem("curf.autoCurf.lastPublicUrl", j.publicAppUrl);
      }
      window.location.href = "/reports/" + j.id;
    } catch (e: any) {
      setAutoError(e?.message ?? t("tables.card.autoGenerateFailedFallback"));
      setGenerating(false);
    }
  }

  return (
    <div className="group relative flex flex-col rounded-lg border border-border bg-card p-4 shadow-xs transition-shadow hover:shadow-md">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground ring-1 ring-border group-hover:bg-primary/10 group-hover:text-primary">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <Link
            href={`/tables/${encodeURIComponent(row.name)}`}
            className="block truncate text-sm font-semibold hover:underline"
          >
            {row.name}
          </Link>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <span>{t(SOURCE_LABEL_KEYS[row.sourceKind])}</span>
            <span>·</span>
            <span>
              {t("tables.card.colsLabel")
                .replace("{n}", String(row.schema.length))
                .replace("{plural}", row.schema.length === 1 ? "" : "s")}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {/* Wow-moment shortcut: skip the detail page entirely. The
              spinner uses the same multi-stage caption pattern as the
              detail-page button so users get progress feedback during
              the 4-8 second LLM round-trip. */}
          <button
            type="button"
            onClick={autoGenerate}
            disabled={generating}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2 text-[10px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            title={t("tables.card.autoGenerateTitle")}
          >
            {generating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            {generating ? t("tables.card.designing") : t("tables.card.autoButton")}
          </button>
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); onDelete(); }}
            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title={t("tables.card.deleteTitle")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="mt-3 flex items-baseline justify-between text-xs">
        <span className="font-semibold tabular-nums text-foreground">{t("tables.card.rowsCount").replace("{n}", row.rowCount.toLocaleString())}</span>
        {/* timeAgo() reads Date.now() — the server and the hydrating
            client almost always tick into different buckets ("32s ago"
            vs "33s ago", or worse across the 60s / 60m / 24h boundaries),
            which trips React's hydration check. suppressHydrationWarning
            on this single span tells React to trust the client value
            without throwing — the right tool for relative-time strings. */}
        <span className="text-muted-foreground" suppressHydrationWarning>
          {t("tables.card.updatedAgo").replace("{time}", timeAgo(row.updatedAt, t))}
        </span>
      </div>
      {row.schema.length > 0 && (
        <p className="mt-2 truncate font-mono text-[10px] text-muted-foreground/80">
          {row.schema.slice(0, 6).map((c) => c.name).join(", ")}
          {row.schema.length > 6 ? ", " + t("tables.card.moreColumns").replace("{n}", String(row.schema.length - 6)) : ""}
        </p>
      )}
      {autoError && (
        <p className="mt-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
          {autoError}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tokens panel
// ---------------------------------------------------------------------------

function TokensPanel({
  tokens, availableTables, onChanged,
}: {
  tokens: TokenRow[];
  availableTables: string[];
  onChanged: () => Promise<void>;
}) {
  const { t } = useT();
  const [showCreate, setShowCreate] = useState(false);
  const [label, setLabel] = useState("");
  const [tableName, setTableName] = useState("");
  const [busy, setBusy] = useState(false);
  const [justMinted, setJustMinted] = useState<{ secret: string; label: string } | null>(null);

  async function mint(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await fetch("/api/lake/tokens", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label, tableName }),
      });
      const j = await r.json();
      if (r.ok) {
        setJustMinted({ secret: j.secret, label });
        setLabel(""); setTableName("");
        setShowCreate(false);
        await onChanged();
      }
    } finally { setBusy(false); }
  }

  async function revoke(id: string) {
    if (!confirm(t("tables.tokens.revokeConfirm"))) return;
    const r = await fetch(`/api/lake/tokens/${id}`, { method: "DELETE", credentials: "include" });
    if (r.ok) await onChanged();
  }

  return (
    <div className="mt-4 space-y-3">
      {justMinted && (
        <NewTokenBanner secret={justMinted.secret} label={justMinted.label} onDismiss={() => setJustMinted(null)} />
      )}

      {!showCreate && (
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs hover:bg-muted"
        >
          <Plus className="h-3 w-3" /> {t("tables.tokens.mintButton")}
        </button>
      )}

      {showCreate && (
        <form onSubmit={mint} className="grid gap-2 rounded-md border border-border bg-muted/20 p-3 md:grid-cols-3">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("tables.tokens.labelPlaceholder")}
            required maxLength={80}
            className="h-9 rounded-md border border-border bg-background px-3 text-xs"
          />
          <input
            value={tableName}
            onChange={(e) => setTableName(e.target.value)}
            placeholder={t("tables.tokens.tablePlaceholder")}
            required maxLength={60}
            list="lake-table-options"
            className="h-9 rounded-md border border-border bg-background px-3 text-xs"
          />
          <datalist id="lake-table-options">
            {availableTables.map((tbl) => <option key={tbl} value={tbl} />)}
          </datalist>
          <div className="flex items-center gap-1">
            <button type="submit" disabled={busy} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />} {t("tables.tokens.mint")}
            </button>
            <button type="button" onClick={() => setShowCreate(false)} className="h-9 rounded-md px-3 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">{t("action.cancel")}</button>
          </div>
        </form>
      )}

      {tokens.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/10 px-3 py-2 text-[11px] text-muted-foreground">
          {t("tables.tokens.emptyPart1")} <code className="font-mono">/api/lake/append</code> {t("tables.tokens.emptyPart2")} <code className="font-mono">Authorization: Bearer &lt;token&gt;</code> {t("tables.tokens.emptyPart3")}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border bg-background">
          {tokens.map((tok) => (
            <li key={tok.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs font-medium">
                  <KeyRound className="h-3 w-3 text-muted-foreground" />
                  <span className="truncate">{tok.label}</span>
                  <code className="font-mono text-[10px] text-muted-foreground">{tok.prefix}…</code>
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  {t("tables.tokens.arrowTable")} <code className="font-mono">{tok.tableName}</code>
                  {tok.lastUsedAt
                    ? ` · ${t("tables.tokens.lastUsed").replace("{time}", timeAgo(tok.lastUsedAt, t))}`
                    : ` · ${t("tables.tokens.neverUsed")}`}
                </div>
              </div>
              <button
                type="button"
                onClick={() => revoke(tok.id)}
                className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                title={t("tables.tokens.revoke")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Hoisted so the JSX text doesn't have to dodge the `{...}` inside the
// JSON example — SWC's JSX parser is stricter about brace balance inside
// template literals than the spec allows for, so isolating it here keeps
// the render tree clean.
const EXAMPLE_CURL = "curl -X POST .../api/lake/append -H 'Authorization: Bearer <token>' -d '[" + '{"foo":1}' + "]'";

function NewTokenBanner({ secret, label, onDismiss }: { secret: string; label: string; onDismiss: () => void }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard?.writeText(secret).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }
  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 p-3 ">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-warning ">
            {t("tables.tokens.mintedBanner").replace("{label}", label)}
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="block flex-1 truncate rounded border border-warning/30 bg-background px-2 py-1 font-mono text-[11px]">{secret}</code>
            <button
              type="button"
              onClick={copy}
              className="inline-flex h-7 items-center gap-1 rounded bg-warning/20 px-2 text-[11px] font-semibold text-warning hover:bg-warning/30"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} {t("tables.tokens.copyButton")}
            </button>
          </div>
          <p className="mt-2 text-[10px] text-warning/80">
            {t("tables.tokens.useInProducer")}{" "}
            <code className="font-mono">{EXAMPLE_CURL}</code>
          </p>
        </div>
        <button type="button" onClick={onDismiss} className="rounded p-1 text-warning/60 hover:bg-warning/20"><X className="h-3 w-3" /></button>
      </div>
    </div>
  );
}

function ChevronToggle({ expanded, onClick }: { expanded: boolean; onClick: () => void }) {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      aria-label={expanded ? t("tables.toggle.collapse") : t("tables.toggle.expand")}
    >
      {expanded ? "▲" : "▼"}
    </button>
  );
}

function timeAgo(iso: string, t: (key: string) => string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return t("time.justNow");
  const min = Math.floor(sec / 60);
  if (min < 60) return t("time.minutesAgo").replace("{n}", String(min));
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("time.hoursAgo").replace("{n}", String(hr));
  const day = Math.floor(hr / 24);
  if (day < 7) return t("time.daysAgo").replace("{n}", String(day));
  return d.toLocaleDateString();
}
