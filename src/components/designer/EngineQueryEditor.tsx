"use client";
/**
 * The query editor for a data source of kind "engine": pick a published view, choose columns, filters, totals,
 * sort and limit, and see the rows. Replaces the SQL editor in the Data drawer for those sources; the saved
 * shape is `DataSourceDef.engine` (EngineQuery), built only through lib/engine/queryBuilder.ts.
 *
 * What a person sees here is what the engine lets THEM see: the catalogue lists only the views they may query,
 * and a column masked for them is marked as such. No SQL, row rules or role lists ever reach this component.
 */
import { useEffect, useMemo, useRef, useState, useId } from "react";
import Link from "next/link";
import {
  AlertTriangle, ChevronDown, ChevronRight, Loader2, Lock, Play, Plus, RefreshCw, Search, Table2, X as CloseIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/lib/i18n/LocaleContext";
import { EngineQueryAssist } from "@/components/designer/EngineQueryAssist";
import { useDesignerStore } from "@/lib/reporting/store";
import type { DataSourceDef, EngineQuery, Parameter } from "@/lib/reporting/schema";
import { cn } from "@/lib/utils";
import {
  AGGREGATE_FNS, MAX_AGGREGATES, MAX_FILTERS, MAX_ORDER_BY, addAggregate, addFilter, addOrder, bindFilterParam,
  columnFamily, filterHasParam, findColumn, formatList, formatLiteral, initialQuery, isGrouped, isParamRef,
  mergeTableColumns, opTakesList, opTakesNoValue, opsForColumn, parseList, parseLiteral, removeAggregate, removeFilter,
  removeOrder, selectedColumns, setColumns, setFilterColumn, setFilterOp, setFilterSkipIfEmpty, setFilterValue,
  setFilterValues, setLimit, setView, sortableNames, suggestTableColumns, toggleColumn, toggleGroupBy, updateAggregate,
  updateOrder, validateEngineQuery, aggregateAlias,
  type AggregateFn, type ColumnFamily, type EngineValue, type EngineView, type EngineViewColumn, type FilterOp,
} from "@/lib/engine/queryBuilder";

type Catalogue =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; views: EngineView[] };

type PreviewResult = {
  rows?: Record<string, unknown>[];
  columns?: string[];
  totalRows?: number;
  truncated?: boolean;
  durationMs?: number;
  error?: string;
};

const PREVIEW_ROWS = 20;
const NONE = "__none__";
const fill = (text: string, values?: Record<string, string | number>) =>
  Object.entries(values ?? {}).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), text);

export function EngineQueryEditor({
  query, onChange, parameters,
}: {
  query: DataSourceDef;
  onChange: (patch: Partial<DataSourceDef>) => void;
  parameters: Parameter[];
}) {
  const { t } = useT();
  const engine: EngineQuery = query.engine ?? initialQuery();
  const [catalogue, setCatalogue] = useState<Catalogue>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [changingView, setChangingView] = useState(false);

  useEffect(() => {
    if (!query.dataSourceId) return;
    const ctl = new AbortController();
    setCatalogue({ status: "loading" });
    (async () => {
      try {
        const r = await fetch(`/api/engine/views?dataSourceId=${encodeURIComponent(query.dataSourceId)}`, { signal: ctl.signal });
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(typeof body?.error === "string" ? body.error : t("engineQuery.data.loadFailed"));
        setCatalogue({ status: "ready", views: Array.isArray(body?.views) ? body.views : [] });
      } catch (e: any) {
        if (ctl.signal.aborted) return;
        setCatalogue({ status: "error", message: e?.message || t("engineQuery.data.loadFailed") });
      }
    })();
    return () => ctl.abort();
    // `t` changes identity with the language, which must not refetch the catalogue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.dataSourceId, attempt]);

  const views = catalogue.status === "ready" ? catalogue.views : [];
  const view = views.find((v) => v.id === engine.viewId);
  const parameterNames = useMemo(() => parameters.map((p) => p.name), [parameters]);
  const problems = useMemo(
    () => (catalogue.status === "ready" ? validateEngineQuery(engine, view, parameterNames) : []),
    [catalogue.status, engine, view, parameterNames],
  );
  const problemsFor = (prefix: string) => problems.filter((p) => p.field === prefix || p.field.startsWith(`${prefix}[`));

  const update = (next: EngineQuery) => onChange({ engine: next });
  const choosingView = !engine.viewId || changingView || (catalogue.status === "ready" && !view);

  return (
    <div className="grid gap-3" data-testid="engine-query-editor">
      {catalogue.status === "ready" && views.length > 0 && (
        <EngineQueryAssist
          dataSourceId={query.dataSourceId}
          parameterNames={parameterNames}
          hasQuery={!!engine.viewId}
          onApply={(next) => { update(next); setChangingView(false); }}
        />
      )}
      <Section id="data" title={t("engineQuery.data.title")} defaultOpen>
        {catalogue.status === "loading" && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("engineQuery.data.loading")}
          </p>
        )}
        {catalogue.status === "error" && (
          <div className="grid gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs" role="alert">
            <p className="font-medium">{t("engineQuery.data.loadFailedTitle")}</p>
            <p className="text-foreground/80">{catalogue.message}</p>
            <div>
              <Button size="sm" variant="outline" type="button" onClick={() => setAttempt((n) => n + 1)}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> {t("engineQuery.retry")}
              </Button>
            </div>
          </div>
        )}
        {catalogue.status === "ready" && views.length === 0 && (
          <div className="grid gap-1 rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
            <p className="font-medium text-foreground">{t("engineQuery.data.emptyTitle")}</p>
            <p>{t("engineQuery.data.emptyHint")}</p>
            <p>
              <Link href="/admin/connections" className="text-primary underline underline-offset-2 hover:text-primary-ink">
                {t("engineQuery.data.adminLink")}
              </Link>
            </p>
          </div>
        )}
        {catalogue.status === "ready" && views.length > 0 && (
          choosingView ? (
            <ViewPicker
              views={views}
              selectedId={engine.viewId}
              missingId={!view && engine.viewId ? engine.viewId : undefined}
              onPick={(v) => { update(setView(engine, v)); setChangingView(false); }}
              onCancel={view ? () => setChangingView(false) : undefined}
            />
          ) : view ? (
            <div className="flex items-start justify-between gap-3 rounded-md border bg-card p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{view.name}</p>
                {view.description && <p className="text-xs text-muted-foreground">{view.description}</p>}
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {fill(t("engineQuery.data.columnCount"), { n: view.columns.length })}
                </p>
              </div>
              <Button size="sm" variant="outline" type="button" onClick={() => setChangingView(true)}>
                {t("engineQuery.data.change")}
              </Button>
            </div>
          ) : null
        )}
        <ProblemList problems={problemsFor("viewId")} />
      </Section>

      {view && (
        <>
          <Section id="columns" title={t("engineQuery.columns.title")} defaultOpen>
            {isGrouped(engine) ? (
              <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">{t("engineQuery.columns.grouped")}</p>
            ) : (
              <ColumnChecklist
                view={view}
                selected={selectedColumns(engine, view)}
                onToggle={(name) => update(toggleColumn(engine, view, name))}
                onAll={() => update(setColumns(engine, view, view.columns.map((c) => c.name)))}
                onNone={() => update(setColumns(engine, view, []))}
              />
            )}
            <ProblemList problems={problemsFor("columns")} />
          </Section>

          <Section id="filters" title={t("engineQuery.filters.title")} count={engine.filters?.length}>
            {(engine.filters ?? []).length === 0 && (
              <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">{t("engineQuery.filters.empty")}</p>
            )}
            {(engine.filters ?? []).map((f, i) => (
              <FilterRow
                key={i}
                index={i}
                view={view}
                filter={f}
                parameters={parameters}
                problems={problems.filter((p) => p.field === `filters[${i}]`)}
                onColumn={(c) => update(setFilterColumn(engine, view, i, c))}
                onOp={(op) => update(setFilterOp(engine, i, op))}
                onValue={(v, slot) => update(setFilterValue(engine, i, v, slot))}
                onValues={(vs) => update(setFilterValues(engine, i, vs))}
                onParam={(name, slot) => update(bindFilterParam(engine, i, name, slot))}
                onSkip={(skip) => update(setFilterSkipIfEmpty(engine, i, skip))}
                onRemove={() => update(removeFilter(engine, i))}
              />
            ))}
            <div>
              <Button
                size="sm" variant="outline" type="button"
                disabled={(engine.filters?.length ?? 0) >= MAX_FILTERS}
                onClick={() => update(addFilter(engine, view))}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" /> {t("engineQuery.filters.add")}
              </Button>
            </div>
          </Section>

          <Section id="group" title={t("engineQuery.group.title")} count={(engine.groupBy?.length ?? 0) + (engine.aggregates?.length ?? 0)}>
            <p className="text-xs text-muted-foreground">{t("engineQuery.group.hint")}</p>
            <GroupAndTotals
              view={view}
              engine={engine}
              problems={problems}
              onGroup={(name) => update(toggleGroupBy(engine, view, name))}
              onAdd={() => update(addAggregate(engine, view, "COUNT"))}
              onUpdate={(i, patch) => update(updateAggregate(engine, view, i, patch))}
              onRemove={(i) => update(removeAggregate(engine, view, i))}
            />
          </Section>

          <Section id="sort" title={t("engineQuery.sort.title")} count={engine.orderBy?.length}>
            <SortAndLimit
              view={view}
              engine={engine}
              problems={problems}
              onAdd={() => update(addOrder(engine, view))}
              onUpdate={(i, patch) => update(updateOrder(engine, view, i, patch))}
              onRemove={(i) => update(removeOrder(engine, view, i))}
              onLimit={(n) => update(setLimit(engine, n))}
            />
          </Section>

          <Section id="preview" title={t("engineQuery.preview.title")} defaultOpen>
            <Preview query={query} engine={engine} view={view} parameters={parameters} blocked={problems.length > 0} />
          </Section>
        </>
      )}
    </div>
  );
}

// ==============================================================
// Section shell: a button-controlled disclosure, keyboard and screen-reader friendly
// ==============================================================

function Section({
  id, title, count, defaultOpen = false, children,
}: { id: string; title: string; count?: number; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const uid = useId();
  const panel = `${uid}-${id}`;
  return (
    <section className="rounded-md border">
      <h4>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
          <span>{title}</span>
          {!!count && (
            <span className="rounded-full bg-primary-soft px-1.5 text-[10px] font-semibold text-primary-ink">{count}</span>
          )}
        </button>
      </h4>
      <div id={panel} hidden={!open} className="grid gap-3 border-t px-3 py-3">
        {open && children}
      </div>
    </section>
  );
}

function ProblemList({ problems }: { problems: ReturnType<typeof validateEngineQuery> }) {
  const { t } = useT();
  if (problems.length === 0) return null;
  return (
    <ul className="grid gap-1" role="alert">
      {problems.map((p, i) => (
        <li key={i} className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {fill(t(p.key), {
              ...p.values,
              // An operator or calculation is named in the author's words, not by its code.
              ...(typeof p.values?.op === "string" ? { op: t(`engineQuery.op.${p.values.op}`) } : {}),
              ...(typeof p.values?.fn === "string" ? { fn: t(`engineQuery.fn.${p.values.fn}`) } : {}),
            })}
          </span>
        </li>
      ))}
    </ul>
  );
}

function TypeBadge({ type }: { type: string }) {
  const { t } = useT();
  const family = columnFamily(type);
  return (
    <span
      className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
      title={type}
    >
      {t(`engineQuery.type.${family}`)}
    </span>
  );
}

function MaskedMark() {
  const { t } = useT();
  return (
    <span title={t("engineQuery.masked")} className="inline-flex shrink-0 items-center text-muted-foreground">
      <Lock className="h-3.5 w-3.5" aria-hidden />
      <span className="sr-only">{t("engineQuery.masked")}</span>
    </span>
  );
}

const columnLabel = (c: EngineViewColumn) => c.label?.trim() || c.name;

// ==============================================================
// 1. Data: the views this person may query
// ==============================================================

function ViewPicker({
  views, selectedId, missingId, onPick, onCancel,
}: {
  views: EngineView[];
  selectedId: string;
  missingId?: string;
  onPick: (v: EngineView) => void;
  onCancel?: () => void;
}) {
  const { t } = useT();
  const [search, setSearch] = useState("");
  const inputId = useId();
  const needle = search.trim().toLowerCase();
  const shown = needle
    ? views.filter((v) => `${v.name} ${v.description ?? ""}`.toLowerCase().includes(needle))
    : views;
  return (
    <div className="grid gap-2">
      {missingId && (
        <p className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs" role="alert">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {fill(t("engineQuery.problem.viewMissing"), { view: missingId })}
        </p>
      )}
      <div className="flex items-end gap-2">
        <div className="relative grid flex-1 gap-1">
          <Label htmlFor={inputId}>{t("engineQuery.data.search")}</Label>
          <Search className="pointer-events-none absolute bottom-2.5 left-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input
            id={inputId}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("engineQuery.data.searchPlaceholder")}
            className="pl-8"
            autoComplete="off"
          />
        </div>
        {onCancel && (
          <Button size="sm" variant="ghost" type="button" onClick={onCancel}>{t("action.cancel")}</Button>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">{t("engineQuery.data.noMatch")}</p>
      ) : (
        <ul className="grid max-h-64 gap-1 overflow-auto" aria-label={t("engineQuery.data.title")}>
          {shown.map((v) => (
            <li key={v.id}>
              <button
                type="button"
                aria-pressed={v.id === selectedId}
                onClick={() => onPick(v)}
                className={cn(
                  "flex w-full items-start justify-between gap-3 rounded-md border px-3 py-2 text-left hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  v.id === selectedId && "border-primary bg-primary-soft",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{v.name}</span>
                  {v.description && <span className="block text-xs text-muted-foreground">{v.description}</span>}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {fill(t("engineQuery.data.columnCount"), { n: v.columns.length })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ==============================================================
// 2. Columns
// ==============================================================

function ColumnChecklist({
  view, selected, onToggle, onAll, onNone,
}: {
  view: EngineView;
  selected: string[];
  onToggle: (name: string) => void;
  onAll: () => void;
  onNone: () => void;
}) {
  const { t } = useT();
  const uid = useId();
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {fill(t("engineQuery.columns.selected"), { n: selected.length, total: view.columns.length })}
        </span>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" type="button" onClick={onAll}>{t("engineQuery.columns.all")}</Button>
          <Button size="sm" variant="ghost" type="button" onClick={onNone}>{t("engineQuery.columns.none")}</Button>
        </div>
      </div>
      <ul className="grid max-h-64 gap-0.5 overflow-auto rounded-md border p-1">
        {view.columns.map((c, i) => {
          const id = `${uid}-c${i}`;
          return (
            <li key={c.name} className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-accent/40">
              <input
                id={id}
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-primary"
                checked={selected.includes(c.name)}
                onChange={() => onToggle(c.name)}
              />
              <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                <span className="flex items-center gap-1.5 text-sm">
                  <span className="truncate">{columnLabel(c)}</span>
                  {c.label && c.label !== c.name && <span className="truncate font-mono text-[10px] text-muted-foreground">{c.name}</span>}
                  {c.masked && <MaskedMark />}
                </span>
                {c.description && <span className="block text-xs text-muted-foreground">{c.description}</span>}
              </label>
              <TypeBadge type={c.type} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ==============================================================
// 3. Filters
// ==============================================================

type Problems = ReturnType<typeof validateEngineQuery>;

function FilterRow({
  index, view, filter, parameters, problems, onColumn, onOp, onValue, onValues, onParam, onSkip, onRemove,
}: {
  index: number;
  view: EngineView;
  filter: NonNullable<EngineQuery["filters"]>[number];
  parameters: Parameter[];
  problems: Problems;
  onColumn: (c: string) => void;
  onOp: (op: FilterOp) => void;
  onValue: (v: EngineValue, slot?: number) => void;
  onValues: (vs: EngineValue[]) => void;
  onParam: (name: string | null, slot?: number) => void;
  onSkip: (skip: boolean) => void;
  onRemove: () => void;
}) {
  const { t } = useT();
  const uid = useId();
  const col = findColumn(view, filter.column);
  const family = columnFamily(col?.type);
  const ops = opsForColumn(col);
  const n = index + 1;
  return (
    <div className="grid gap-2 rounded-md border bg-card p-2">
      <div className="grid grid-cols-[1fr_9rem_auto] items-end gap-2">
        <div className="grid gap-1">
          <Label htmlFor={`${uid}-col`} className="text-[11px]">{fill(t("engineQuery.filters.column"), { n })}</Label>
          <Select value={filter.column} onValueChange={onColumn}>
            <SelectTrigger id={`${uid}-col`}><SelectValue /></SelectTrigger>
            <SelectContent>
              {view.columns.map((c) => <SelectItem key={c.name} value={c.name}>{columnLabel(c)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${uid}-op`} className="text-[11px]">{fill(t("engineQuery.filters.operator"), { n })}</Label>
          <Select value={filter.op} onValueChange={(v) => onOp(v as FilterOp)}>
            <SelectTrigger id={`${uid}-op`}><SelectValue /></SelectTrigger>
            <SelectContent>
              {ops.map((op) => <SelectItem key={op} value={op}>{t(`engineQuery.op.${op}`)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button size="icon" variant="ghost" type="button" onClick={onRemove} aria-label={fill(t("engineQuery.filters.remove"), { n })} title={t("action.remove")}>
          <CloseIcon className="h-4 w-4" />
        </Button>
      </div>

      {opTakesNoValue(filter.op) ? (
        <p className="text-xs text-muted-foreground">{t("engineQuery.filters.noValue")}</p>
      ) : filter.op === "BETWEEN" ? (
        <div className="grid grid-cols-2 gap-2">
          {[0, 1].map((slot) => (
            <ValueField
              key={slot}
              label={fill(t(slot === 0 ? "engineQuery.filters.from" : "engineQuery.filters.to"), { n })}
              family={family}
              value={filter.values?.[slot]}
              parameters={parameters}
              onLiteral={(text) => onValue(parseLiteral(family, text), slot)}
              onParam={(name) => onParam(name, slot)}
            />
          ))}
        </div>
      ) : opTakesList(filter.op) ? (
        <ListField
          label={fill(t("engineQuery.filters.values"), { n })}
          family={family}
          values={filter.values ?? []}
          parameters={parameters}
          onValues={onValues}
          onParam={(name) => onParam(name)}
        />
      ) : (
        <ValueField
          label={fill(t("engineQuery.filters.value"), { n })}
          family={family}
          value={filter.value}
          parameters={parameters}
          onLiteral={(text) => onValue(parseLiteral(family, text))}
          onParam={(name) => onParam(name)}
        />
      )}

      {filterHasParam(filter) && (
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            role="switch"
            className="h-4 w-4 accent-primary"
            checked={!!filter.skipIfEmpty}
            onChange={(e) => onSkip(e.target.checked)}
          />
          <span>{t("engineQuery.filters.skipIfEmpty")}</span>
        </label>
      )}
      <ProblemList problems={problems} />
    </div>
  );
}

/** One value: typed in, or taken from a report parameter. */
function ValueField({
  label, family, value, parameters, onLiteral, onParam,
}: {
  label: string;
  family: ColumnFamily;
  value: EngineValue | undefined;
  parameters: Parameter[];
  onLiteral: (text: string) => void;
  onParam: (name: string | null) => void;
}) {
  const { t } = useT();
  const uid = useId();
  const bound = isParamRef(value);
  return (
    <div className="grid gap-1">
      <Label htmlFor={`${uid}-v`} className="text-[11px]">{label}</Label>
      <div className="flex gap-1.5">
        {parameters.length > 0 && (
          <Select
            value={bound ? "param" : "value"}
            onValueChange={(m) => onParam(m === "param" ? parameters[0].name : null)}
          >
            <SelectTrigger className="w-[9.5rem] shrink-0" aria-label={`${label}: ${t("engineQuery.filters.source")}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="value">{t("engineQuery.filters.typed")}</SelectItem>
              <SelectItem value="param">{t("engineQuery.filters.fromParam")}</SelectItem>
            </SelectContent>
          </Select>
        )}
        {bound ? (
          <Select value={value.$param} onValueChange={(name) => onParam(name)}>
            <SelectTrigger id={`${uid}-v`}>
              <SelectValue placeholder={t("engineQuery.filters.pickParam")} />
            </SelectTrigger>
            <SelectContent>
              {/* A parameter the report no longer has stays visible, so the problem below has something to point at. */}
              {!parameters.some((p) => p.name === value.$param) && <SelectItem value={value.$param}>{value.$param}</SelectItem>}
              {parameters.map((p) => <SelectItem key={p.name} value={p.name}>{p.label || p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : family === "boolean" ? (
          <Select value={typeof value === "boolean" ? String(value) : NONE} onValueChange={(v) => onLiteral(v === NONE ? "" : v)}>
            <SelectTrigger id={`${uid}-v`}><SelectValue placeholder={t("engineQuery.filters.pickBoolean")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="true">{t("engineQuery.filters.true")}</SelectItem>
              <SelectItem value="false">{t("engineQuery.filters.false")}</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <LiteralInput id={`${uid}-v`} family={family} value={value} onText={onLiteral} />
        )}
      </div>
    </div>
  );
}

/**
 * A text box that keeps what is being typed ("1." on the way to "1.5") while the query holds the typed value
 * ("1"): the box only takes the query's value back when the query changed to something else.
 */
function LiteralInput({
  id, family, value, onText,
}: { id: string; family: ColumnFamily; value: EngineValue | undefined; onText: (text: string) => void }) {
  const [text, setText] = useState(formatLiteral(value));
  useEffect(() => {
    if (formatLiteral(parseLiteral(family, text)) !== formatLiteral(value)) setText(formatLiteral(value));
    // Only an outside change to the value should reset the box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, family]);
  return (
    <Input
      id={id}
      type={family === "date" ? "date" : "text"}
      inputMode={family === "number" ? "decimal" : undefined}
      value={text}
      onChange={(e) => { setText(e.target.value); onText(e.target.value); }}
      autoComplete="off"
    />
  );
}

/** The list of an "is one of" filter: comma-separated values, or one report parameter that holds them. */
function ListField({
  label, family, values, parameters, onValues, onParam,
}: {
  label: string;
  family: ColumnFamily;
  values: EngineValue[];
  parameters: Parameter[];
  onValues: (vs: EngineValue[]) => void;
  onParam: (name: string | null) => void;
}) {
  const { t } = useT();
  const uid = useId();
  const bound = values.find(isParamRef);
  const [text, setText] = useState(formatList(values));
  useEffect(() => {
    if (formatList(parseList(family, text)) !== formatList(values)) setText(formatList(values));
    // Only an outside change should reset the box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, family]);
  return (
    <div className="grid gap-1">
      <Label htmlFor={`${uid}-l`} className="text-[11px]">{label}</Label>
      <div className="flex gap-1.5">
        {parameters.length > 0 && (
          <Select value={bound ? "param" : "value"} onValueChange={(m) => onParam(m === "param" ? parameters[0].name : null)}>
            <SelectTrigger className="w-[9.5rem] shrink-0" aria-label={`${label}: ${t("engineQuery.filters.source")}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="value">{t("engineQuery.filters.typed")}</SelectItem>
              <SelectItem value="param">{t("engineQuery.filters.fromParam")}</SelectItem>
            </SelectContent>
          </Select>
        )}
        {bound ? (
          <Select value={bound.$param} onValueChange={(name) => onParam(name)}>
            <SelectTrigger id={`${uid}-l`}><SelectValue placeholder={t("engineQuery.filters.pickParam")} /></SelectTrigger>
            <SelectContent>
              {!parameters.some((p) => p.name === bound.$param) && <SelectItem value={bound.$param}>{bound.$param}</SelectItem>}
              {parameters.map((p) => <SelectItem key={p.name} value={p.name}>{p.label || p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : (
          <Input
            id={`${uid}-l`}
            value={text}
            placeholder={t("engineQuery.filters.listPlaceholder")}
            onChange={(e) => { setText(e.target.value); onValues(parseList(family, e.target.value)); }}
            autoComplete="off"
          />
        )}
      </div>
    </div>
  );
}

// ==============================================================
// 4. Group & totals
// ==============================================================

function GroupAndTotals({
  view, engine, problems, onGroup, onAdd, onUpdate, onRemove,
}: {
  view: EngineView;
  engine: EngineQuery;
  problems: Problems;
  onGroup: (name: string) => void;
  onAdd: () => void;
  onUpdate: (i: number, patch: Partial<NonNullable<EngineQuery["aggregates"]>[number]>) => void;
  onRemove: (i: number) => void;
}) {
  const { t } = useT();
  const uid = useId();
  const groups = engine.groupBy ?? [];
  const aggregates = engine.aggregates ?? [];
  return (
    <div className="grid gap-3">
      <fieldset className="grid gap-1.5">
        <legend className="mb-1 text-xs font-medium">{t("engineQuery.group.groupBy")}</legend>
        <div className="flex flex-wrap gap-1.5">
          {view.columns.map((c, i) => {
            const id = `${uid}-g${i}`;
            const on = groups.includes(c.name);
            return (
              <label
                key={c.name}
                htmlFor={id}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:bg-accent/50 focus-within:ring-2 focus-within:ring-ring",
                  on && "border-primary bg-primary-soft",
                )}
              >
                <input id={id} type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={on} onChange={() => onGroup(c.name)} />
                {columnLabel(c)}
              </label>
            );
          })}
        </div>
        <ProblemList problems={problems.filter((p) => p.field === "groupBy")} />
      </fieldset>

      <div className="grid gap-2">
        <p className="text-xs font-medium">{t("engineQuery.group.totals")}</p>
        {aggregates.length === 0 && (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">{t("engineQuery.group.noTotals")}</p>
        )}
        {aggregates.map((a, i) => {
          const n = i + 1;
          const numberOnly = a.fn === "SUM" || a.fn === "AVG";
          const choices = view.columns.filter((c) => !numberOnly || columnFamily(c.type) === "number");
          return (
            <div key={i} className="grid gap-1 rounded-md border bg-card p-2">
              <div className="grid grid-cols-[8rem_1fr_1fr_auto] items-end gap-2">
                <div className="grid gap-1">
                  <Label htmlFor={`${uid}-f${i}`} className="text-[11px]">{fill(t("engineQuery.group.function"), { n })}</Label>
                  <Select value={a.fn} onValueChange={(fn) => onUpdate(i, { fn: fn as AggregateFn })}>
                    <SelectTrigger id={`${uid}-f${i}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {AGGREGATE_FNS.map((fn) => <SelectItem key={fn} value={fn}>{t(`engineQuery.fn.${fn}`)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`${uid}-c${i}`} className="text-[11px]">{fill(t("engineQuery.group.of"), { n })}</Label>
                  <Select
                    value={a.column ?? NONE}
                    onValueChange={(c) => onUpdate(i, { column: c === NONE ? undefined : c })}
                  >
                    <SelectTrigger id={`${uid}-c${i}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {a.fn === "COUNT" && <SelectItem value={NONE}>{t("engineQuery.group.allRows")}</SelectItem>}
                      {choices.map((c) => <SelectItem key={c.name} value={c.name}>{columnLabel(c)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`${uid}-a${i}`} className="text-[11px]">{fill(t("engineQuery.group.name"), { n })}</Label>
                  <Input
                    id={`${uid}-a${i}`}
                    value={a.as ?? ""}
                    placeholder={aggregateAlias(a)}
                    onChange={(e) => onUpdate(i, { as: e.target.value })}
                    autoComplete="off"
                  />
                </div>
                <Button size="icon" variant="ghost" type="button" onClick={() => onRemove(i)} aria-label={fill(t("engineQuery.group.remove"), { n })} title={t("action.remove")}>
                  <CloseIcon className="h-4 w-4" />
                </Button>
              </div>
              <ProblemList problems={problems.filter((p) => p.field === `aggregates[${i}]`)} />
            </div>
          );
        })}
        <div>
          <Button size="sm" variant="outline" type="button" disabled={aggregates.length >= MAX_AGGREGATES} onClick={onAdd}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> {t("engineQuery.group.addTotal")}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ==============================================================
// 5. Sort & limit
// ==============================================================

function SortAndLimit({
  view, engine, problems, onAdd, onUpdate, onRemove, onLimit,
}: {
  view: EngineView;
  engine: EngineQuery;
  problems: Problems;
  onAdd: () => void;
  onUpdate: (i: number, patch: { column?: string; descending?: boolean }) => void;
  onRemove: (i: number) => void;
  onLimit: (n: number | null) => void;
}) {
  const { t } = useT();
  const uid = useId();
  const names = sortableNames(engine, view);
  const orderBy = engine.orderBy ?? [];
  const nameOf = (n: string) => {
    const c = findColumn(view, n);
    return c ? columnLabel(c) : n;
  };
  const [limitText, setLimitText] = useState(engine.limit === undefined ? "" : String(engine.limit));
  useEffect(() => {
    if (String(engine.limit ?? "") !== String(Number(limitText) || "")) setLimitText(engine.limit === undefined ? "" : String(engine.limit));
    // Only an outside change to the limit should reset the box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.limit]);
  return (
    <div className="grid gap-3">
      {orderBy.length === 0 && (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">{t("engineQuery.sort.empty")}</p>
      )}
      {orderBy.map((o, i) => {
        const n = i + 1;
        return (
          <div key={i} className="grid gap-1">
            <div className="grid grid-cols-[1fr_10rem_auto] items-end gap-2">
              <div className="grid gap-1">
                <Label htmlFor={`${uid}-sc${i}`} className="text-[11px]">{fill(t("engineQuery.sort.by"), { n })}</Label>
                <Select value={o.column} onValueChange={(column) => onUpdate(i, { column })}>
                  <SelectTrigger id={`${uid}-sc${i}`}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {!names.includes(o.column) && <SelectItem value={o.column}>{o.column}</SelectItem>}
                    {names.map((name) => <SelectItem key={name} value={name}>{nameOf(name)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1">
                <Label htmlFor={`${uid}-sd${i}`} className="text-[11px]">{fill(t("engineQuery.sort.direction"), { n })}</Label>
                <Select value={o.descending ? "desc" : "asc"} onValueChange={(d) => onUpdate(i, { descending: d === "desc" })}>
                  <SelectTrigger id={`${uid}-sd${i}`}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="asc">{t("engineQuery.sort.asc")}</SelectItem>
                    <SelectItem value="desc">{t("engineQuery.sort.desc")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button size="icon" variant="ghost" type="button" onClick={() => onRemove(i)} aria-label={fill(t("engineQuery.sort.remove"), { n })} title={t("action.remove")}>
                <CloseIcon className="h-4 w-4" />
              </Button>
            </div>
            <ProblemList problems={problems.filter((p) => p.field === `orderBy[${i}]`)} />
          </div>
        );
      })}
      <div>
        <Button size="sm" variant="outline" type="button" disabled={orderBy.length >= MAX_ORDER_BY || names.length === 0} onClick={onAdd}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> {t("engineQuery.sort.add")}
        </Button>
      </div>
      <div className="grid max-w-xs gap-1">
        <Label htmlFor={`${uid}-limit`}>{t("engineQuery.sort.limit")}</Label>
        <Input
          id={`${uid}-limit`}
          type="number"
          min={1}
          inputMode="numeric"
          value={limitText}
          placeholder={t("engineQuery.sort.limitPlaceholder")}
          onChange={(e) => { setLimitText(e.target.value); onLimit(e.target.value === "" ? null : Number(e.target.value)); }}
        />
        <p className="text-[11px] text-muted-foreground">{t("engineQuery.sort.limitHint")}</p>
        <ProblemList problems={problems.filter((p) => p.field === "limit")} />
      </div>
    </div>
  );
}

// ==============================================================
// 6. Preview, and the table's columns
// ==============================================================

function Preview({
  query, engine, view, parameters, blocked,
}: {
  query: DataSourceDef;
  engine: EngineQuery;
  view: EngineView;
  parameters: Parameter[];
  blocked: boolean;
}) {
  const { t } = useT();
  const report = useDesignerStore((s) => s.report);
  const setReport = useDesignerStore((s) => s.setReport);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [applied, setApplied] = useState(false);
  const runId = useRef(0);

  const queryKey = JSON.stringify(engine);
  useEffect(() => {
    // A result belongs to the query that produced it.
    runId.current++;
    setResult(null);
    setBusy(false);
    setApplied(false);
  }, [queryKey]);

  async function run() {
    const mine = ++runId.current;
    setBusy(true);
    const defaults = parameters.reduce<Record<string, unknown>>((acc, p) => {
      if (p.default !== undefined) acc[p.name] = p.default;
      return acc;
    }, {});
    try {
      const r = await fetch("/api/reports/preview-query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, params: defaults }),
      });
      const body = await r.json().catch(() => null);
      if (mine !== runId.current) return;
      if (!r.ok || body?.error) setResult({ error: typeof body?.error === "string" ? body.error : t("engineQuery.preview.failed") });
      else setResult(body);
    } catch (e: any) {
      if (mine === runId.current) setResult({ error: e?.message || t("common.requestFailed") });
    } finally {
      if (mine === runId.current) setBusy(false);
    }
  }

  const tables = report.pages.flatMap((p) => p.blocks.filter((b) => b.type === "table" && (b.config as any).queryId === query.id));
  const suggested = suggestTableColumns(engine, view, (fn, label) =>
    label ? fill(t("engineQuery.fnOf"), { fn: t(`engineQuery.fn.${fn}`), column: label }) : t(`engineQuery.fn.${fn}`));

  function useColumns() {
    const ids = new Set(tables.map((b) => b.id));
    setReport({
      ...report,
      pages: report.pages.map((p) => ({
        ...p,
        blocks: p.blocks.map((b) =>
          ids.has(b.id) && b.type === "table"
            ? { ...b, config: { ...b.config, columns: mergeTableColumns(b.config.columns ?? [], suggested) } }
            : b),
      })),
    });
    setApplied(true);
  }

  const masked = new Set(view.columns.filter((c) => c.masked).map((c) => c.name));
  const columns = result?.columns ?? [];
  const rows = (result?.rows ?? []).slice(0, PREVIEW_ROWS);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" type="button" onClick={run} disabled={busy || blocked}>
          {busy
            ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> {t("designerShell.running")}</>
            : <><Play className="mr-1.5 h-4 w-4" /> {t("engineQuery.preview.run")}</>}
        </Button>
        {blocked && <span className="text-xs text-muted-foreground">{t("engineQuery.preview.fixFirst")}</span>}
        {tables.length > 0 && !blocked && suggested.length > 0 && (
          <Button size="sm" variant="ghost" type="button" onClick={useColumns}>
            <Table2 className="mr-1.5 h-4 w-4" />
            {tables.length === 1 ? t("engineQuery.preview.useColumns") : fill(t("engineQuery.preview.useColumnsMany"), { n: tables.length })}
          </Button>
        )}
        {applied && <span className="text-xs text-success" role="status">{t("engineQuery.preview.columnsApplied")}</span>}
      </div>
      {tables.length === 0 && !blocked && (
        <p className="text-[11px] text-muted-foreground">{t("engineQuery.preview.noTable")}</p>
      )}

      <div aria-live="polite">
        {result?.error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs" role="alert">
            <p className="mb-1 font-medium">{t("engineQuery.preview.failedTitle")}</p>
            <p className="whitespace-pre-wrap break-words text-foreground/80">{result.error}</p>
          </div>
        )}
        {result && !result.error && (
          <div className="rounded-md border border-success/40 bg-success/5 p-2 text-xs">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">
                {(result.totalRows ?? rows.length) === 1
                  ? t("dataDrawer.rowOne")
                  : fill(t("dataDrawer.rowMany"), { n: result.totalRows ?? rows.length })}
                {(result.totalRows ?? 0) > rows.length ? " " + fill(t("dataDrawer.showing"), { n: rows.length }) : ""}
                {" · "}{result.durationMs ?? 0}ms
              </span>
              <span className="text-[10px] text-muted-foreground">{fill(t("dataDrawer.columnCount"), { n: columns.length })}</span>
            </div>
            {rows.length > 0 ? (
              <div className="max-h-64 overflow-auto rounded border border-border bg-background">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted text-muted-foreground">
                    <tr>
                      {columns.map((c) => (
                        <th key={c} scope="col" className="border-b border-border px-2 py-1.5 text-left font-medium">
                          <span className="inline-flex items-center gap-1">{c}{masked.has(c) && <MaskedMark />}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={i} className={i % 2 === 1 ? "bg-muted/30" : ""}>
                        {columns.map((c) => (
                          <td key={c} className="max-w-[200px] truncate border-b border-border/50 px-2 py-1 font-mono">{cell(row[c])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="py-4 text-center text-muted-foreground">{t("engineQuery.preview.zeroRows")}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function cell(v: unknown): React.ReactNode {
  if (v === null || v === undefined) return <span className="italic text-muted-foreground">null</span>;
  if (typeof v === "object") {
    let json: string;
    try { json = JSON.stringify(v); } catch { json = String(v); }
    return <span title={json}>{json.length > 120 ? json.slice(0, 120) + "…" : json}</span>;
  }
  return String(v);
}
