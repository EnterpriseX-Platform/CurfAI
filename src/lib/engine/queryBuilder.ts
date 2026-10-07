/**
 * The report designer's query builder for a Java-engine data source: pure functions over an `EngineQuery`
 * (src/lib/reporting/schema.ts) and the published view it reads. No React, no fetch, and no server imports,
 * so the designer's editor, its validation and its tests all share one definition of "a well-formed query".
 *
 * The engine is the authority: it still checks every name, type and bound when the query runs, and masks or
 * hides what this person may not see. This module only keeps what an author builds from being obviously
 * wrong, and says why in words the editor can show beside the field.
 */
import type { EngineQuery, TableColumn } from "@/lib/reporting/schema";

// ---------------------------------------------------------------- the catalogue, as the editor sees it

export type EngineViewColumn = { name: string; type: string; label?: string; description?: string; masked: boolean };
export type EngineView = { id: string; name: string; description?: string; version: number; columns: EngineViewColumn[] };

export type EngineValue = string | number | boolean | null | { $param: string };
export type EngineFilter = NonNullable<EngineQuery["filters"]>[number];
export type FilterOp = EngineFilter["op"];
export type AggregateFn = NonNullable<EngineQuery["aggregates"]>[number]["fn"];
export type EngineAggregate = NonNullable<EngineQuery["aggregates"]>[number];
export type EngineOrder = NonNullable<EngineQuery["orderBy"]>[number];
export type ColumnFamily = "number" | "text" | "date" | "boolean" | "other";

export const AGGREGATE_FNS: readonly AggregateFn[] = ["COUNT", "SUM", "AVG", "MIN", "MAX"];
/** The engine's own limits on a query (EngineQuerySchema), so the editor stops at them instead of at a save error. */
export const MAX_FILTERS = 50;
export const MAX_GROUP_BY = 20;
export const MAX_AGGREGATES = 20;
export const MAX_ORDER_BY = 20;
export const MAX_LIMIT = 200_000;

/** The engine's rule for an output name an author may choose (`as`): a plain name. */
const OUTPUT_NAME = /^[\p{L}_][\p{L}\p{M}\p{N}_$]{0,127}$/u;

// ---------------------------------------------------------------- column types

const NUMBER_TYPE = /^(int|integer|tinyint|smallint|mediumint|bigint|int\d+|serial|bigserial|smallserial|numeric|decimal|dec|number|float|float\d+|double|real|money)\b/;
const TEXT_TYPE = /^(varchar|nvarchar|char|nchar|bpchar|character|text|string|citext|clob|tinytext|mediumtext|longtext|uuid|name)\b/;
const DATE_TYPE = /^(date|datetime|datetime2|smalldatetime|timestamp|timestamptz|time|timetz)\b/;
const BOOLEAN_TYPE = /^(bool|boolean)\b/;

/** What a database type string is for the purpose of choosing operators and aggregates. Tolerant: unknown is "other". */
export function columnFamily(type: string | undefined | null): ColumnFamily {
  const t = (type ?? "").trim().toLowerCase();
  if (!t) return "other";
  if (BOOLEAN_TYPE.test(t)) return "boolean";
  if (NUMBER_TYPE.test(t)) return "number";
  if (DATE_TYPE.test(t)) return "date";
  if (TEXT_TYPE.test(t)) return "text";
  return "other";
}

const OPS_BY_FAMILY: Record<ColumnFamily, readonly FilterOp[]> = {
  number: ["EQ", "NE", "GT", "GE", "LT", "LE", "BETWEEN", "IN", "NOT_IN", "IS_NULL", "IS_NOT_NULL"],
  text: ["EQ", "NE", "LIKE", "IN", "NOT_IN", "IS_NULL", "IS_NOT_NULL"],
  date: ["EQ", "NE", "GT", "GE", "LT", "LE", "BETWEEN", "IS_NULL", "IS_NOT_NULL"],
  boolean: ["EQ", "NE", "IS_NULL", "IS_NOT_NULL"],
  other: ["EQ", "NE", "IN", "NOT_IN", "IS_NULL", "IS_NOT_NULL"],
};

export const ALL_FILTER_OPS: readonly FilterOp[] = OPS_BY_FAMILY.number.concat(["LIKE"]);

export function opsForFamily(family: ColumnFamily): readonly FilterOp[] {
  return OPS_BY_FAMILY[family];
}

export function opsForColumn(col: EngineViewColumn | undefined): readonly FilterOp[] {
  return OPS_BY_FAMILY[columnFamily(col?.type)];
}

export const opTakesNoValue = (op: FilterOp) => op === "IS_NULL" || op === "IS_NOT_NULL";
export const opTakesList = (op: FilterOp) => op === "IN" || op === "NOT_IN";

/** Which aggregates a column can take: SUM and AVG need a number, the rest work on any column. */
export function canAggregate(fn: AggregateFn, col: EngineViewColumn | undefined): boolean {
  if (!col) return false;
  if (fn === "SUM" || fn === "AVG") return columnFamily(col.type) === "number";
  return true;
}

// ---------------------------------------------------------------- small helpers

export const isParamRef = (v: unknown): v is { $param: string } =>
  !!v && typeof v === "object" && typeof (v as any).$param === "string";

export const paramValue = (name: string): { $param: string } => ({ $param: name });

const isBlankLiteral = (v: unknown) => v === undefined || v === null || v === "";

export function findColumn(view: EngineView | null | undefined, name: string): EngineViewColumn | undefined {
  return view?.columns.find((c) => c.name === name);
}

/** What a typed literal means for a column of this family: numbers and booleans become real ones when they read as such. */
export function parseLiteral(family: ColumnFamily, text: string): EngineValue {
  const s = text.trim();
  if (family === "number") {
    if (s === "") return "";
    const n = Number(s);
    return Number.isFinite(n) ? n : text;
  }
  if (family === "boolean") {
    if (s.toLowerCase() === "true") return true;
    if (s.toLowerCase() === "false") return false;
  }
  return text;
}

/** A literal as the editor's text box shows it. */
export function formatLiteral(v: EngineValue | undefined): string {
  if (v === undefined || v === null) return "";
  if (isParamRef(v)) return "";
  return String(v);
}

/** A comma-separated list as typed into an "is one of" filter. */
export function parseList(family: ColumnFamily, text: string): EngineValue[] {
  return text.split(",").map((p) => p.trim()).filter((p) => p !== "").map((p) => parseLiteral(family, p));
}

export function formatList(values: EngineValue[] | undefined): string {
  return (values ?? []).map(formatLiteral).join(", ");
}

/** Drops empty arrays and undefined keys so the saved definition holds only what the author chose. */
function clean(q: EngineQuery): EngineQuery {
  const out: EngineQuery = { viewId: q.viewId };
  if (q.columns && (q.columns.length > 0 || !isGrouped(q))) out.columns = q.columns;
  if (q.filters?.length) out.filters = q.filters;
  if (q.groupBy?.length) out.groupBy = q.groupBy;
  if (q.aggregates?.length) out.aggregates = q.aggregates;
  if (q.orderBy?.length) out.orderBy = q.orderBy;
  if (q.limit !== undefined) out.limit = q.limit;
  return out;
}

// ---------------------------------------------------------------- the query as a whole

/** A query for a view that is not chosen yet (what the add-query flow saves; the editor then asks for a view). */
export function initialQuery(view?: EngineView | null): EngineQuery {
  return { viewId: view?.id ?? "" };
}

export function isGrouped(q: EngineQuery): boolean {
  return (q.groupBy?.length ?? 0) > 0 || (q.aggregates?.length ?? 0) > 0;
}

export function aggregateAlias(a: EngineAggregate): string {
  if (a.as) return a.as;
  if (!a.column) return "count_all";
  return `${a.fn.toLowerCase()}_${a.column}`;
}

/** The names of the columns the query returns, in order. */
export function outputNames(q: EngineQuery, view: EngineView | null | undefined): string[] {
  if (isGrouped(q)) {
    const names = [...(q.groupBy ?? [])];
    for (const a of q.aggregates ?? []) {
      const alias = aggregateAlias(a);
      if (!names.includes(alias)) names.push(alias);
    }
    return names;
  }
  if (q.columns && q.columns.length > 0) return [...q.columns];
  return (view?.columns ?? []).map((c) => c.name);
}

/** What a sort may name: the group columns and totals of a grouped query, any column of the view otherwise (the engine's rule). */
export function sortableNames(q: EngineQuery, view: EngineView | null | undefined): string[] {
  return isGrouped(q) ? outputNames(q, view) : (view?.columns ?? []).map((c) => c.name);
}

/**
 * Brings a query to a shape the engine accepts: no leftover `columns` once it groups (the group columns are
 * what it returns), no sort on a name the query no longer offers, and no empty lists.
 */
export function normalizeQuery(q: EngineQuery, view: EngineView | null | undefined): EngineQuery {
  let next: EngineQuery = { ...q };
  if (isGrouped(next)) delete next.columns;
  if (next.orderBy?.length) {
    const allowed = new Set(sortableNames(next, view));
    // A view that is not loaded yet cannot say what a plain query may sort on; keep the sort until it can.
    if (isGrouped(next) || view) next.orderBy = next.orderBy.filter((o) => allowed.has(o.column));
  }
  return clean(next);
}

/**
 * Chooses (or, with null, clears) the view. Whatever the query says about a column the new view also has is
 * kept; the rest is dropped, so switching views never leaves a filter on a column that is not there.
 */
export function setView(q: EngineQuery, view: EngineView | null): EngineQuery {
  if (!view) return { viewId: "", ...(q.limit !== undefined ? { limit: q.limit } : {}) };
  if (view.id === q.viewId) return normalizeQuery(q, view);
  const has = (name: string) => !!findColumn(view, name);
  const next: EngineQuery = { viewId: view.id };
  if (q.columns) {
    const kept = q.columns.filter(has);
    if (kept.length > 0) next.columns = kept;
  }
  const filters = (q.filters ?? [])
    .filter((f) => has(f.column))
    .filter((f) => opsForColumn(findColumn(view, f.column)).includes(f.op));
  if (filters.length) next.filters = filters.map((f) => shapeFilter(f));
  const groupBy = (q.groupBy ?? []).filter(has);
  if (groupBy.length) next.groupBy = groupBy;
  const aggregates = (q.aggregates ?? []).filter((a) => (a.column ? canAggregate(a.fn, findColumn(view, a.column)) : a.fn === "COUNT"));
  if (aggregates.length) next.aggregates = aggregates;
  if (q.orderBy?.length) next.orderBy = q.orderBy;
  if (q.limit !== undefined) next.limit = q.limit;
  return normalizeQuery(next, view);
}

// ---------------------------------------------------------------- columns

/** The columns a plain (not grouped) query returns: the chosen ones, or every column when none are chosen. */
export function selectedColumns(q: EngineQuery, view: EngineView): string[] {
  if (q.columns) return view.columns.map((c) => c.name).filter((n) => q.columns!.includes(n));
  return view.columns.map((c) => c.name);
}

/** Sets the chosen columns (in the view's order). Choosing every column is the same as choosing none: all. */
export function setColumns(q: EngineQuery, view: EngineView, names: string[]): EngineQuery {
  if (isGrouped(q)) return q;
  const chosen = view.columns.map((c) => c.name).filter((n) => names.includes(n));
  const next = { ...q, columns: chosen.length === view.columns.length ? undefined : chosen };
  return normalizeQuery(next as EngineQuery, view);
}

export function toggleColumn(q: EngineQuery, view: EngineView, name: string): EngineQuery {
  if (isGrouped(q) || !findColumn(view, name)) return q;
  const current = selectedColumns(q, view);
  return setColumns(q, view, current.includes(name) ? current.filter((n) => n !== name) : [...current, name]);
}

// ---------------------------------------------------------------- filters

function allRefs(f: EngineFilter): Array<{ $param: string }> {
  return [f.value, ...(f.values ?? [])].filter(isParamRef);
}

/** Makes a filter's `value`/`values` right for its operator, and drops `skipIfEmpty` when nothing is bound to a parameter. */
export function shapeFilter(f: EngineFilter): EngineFilter {
  const out: EngineFilter = { column: f.column, op: f.op };
  if (opTakesNoValue(f.op)) return out;
  if (f.op === "BETWEEN") {
    const src = f.values ?? (f.value !== undefined ? [f.value] : []);
    out.values = [src[0] ?? "", src[1] ?? ""];
  } else if (opTakesList(f.op)) {
    out.values = f.values ?? (f.value !== undefined && f.value !== "" ? [f.value] : []);
  } else {
    out.value = f.value !== undefined ? f.value : (f.values?.[0] ?? "");
  }
  if (f.skipIfEmpty && allRefs(out).length > 0) out.skipIfEmpty = true;
  return out;
}

export function newFilter(view: EngineView, column?: string): EngineFilter {
  const col = findColumn(view, column ?? "") ?? view.columns[0];
  return shapeFilter({ column: col?.name ?? "", op: opsForColumn(col)[0] });
}

export function addFilter(q: EngineQuery, view: EngineView, column?: string): EngineQuery {
  if ((q.filters?.length ?? 0) >= MAX_FILTERS || view.columns.length === 0) return q;
  return normalizeQuery({ ...q, filters: [...(q.filters ?? []), newFilter(view, column)] }, view);
}

export function removeFilter(q: EngineQuery, index: number): EngineQuery {
  return normalizeQuery({ ...q, filters: (q.filters ?? []).filter((_, i) => i !== index) }, undefined);
}

function replaceFilter(q: EngineQuery, index: number, f: EngineFilter): EngineQuery {
  const filters = (q.filters ?? []).map((cur, i) => (i === index ? shapeFilter(f) : cur));
  return { ...q, filters };
}

/** Another column: kept operator if the column allows it (else the first one it does), literals cleared when the kind of value changes. */
export function setFilterColumn(q: EngineQuery, view: EngineView, index: number, column: string): EngineQuery {
  const cur = q.filters?.[index];
  const col = findColumn(view, column);
  if (!cur || !col) return q;
  const sameFamily = columnFamily(findColumn(view, cur.column)?.type) === columnFamily(col.type);
  const op = opsForColumn(col).includes(cur.op) ? cur.op : opsForColumn(col)[0];
  const keep = (v: EngineValue) => (sameFamily || isParamRef(v) ? v : "");
  return replaceFilter(q, index, {
    column,
    op,
    ...(cur.value !== undefined ? { value: keep(cur.value) } : {}),
    ...(cur.values ? { values: cur.values.map(keep) } : {}),
    ...(cur.skipIfEmpty ? { skipIfEmpty: true } : {}),
  });
}

export function setFilterOp(q: EngineQuery, index: number, op: FilterOp): EngineQuery {
  const cur = q.filters?.[index];
  if (!cur) return q;
  return replaceFilter(q, index, { ...cur, op });
}

/** The single value of a plain filter (`value`) or one slot of a BETWEEN (`values[slot]`). */
export function setFilterValue(q: EngineQuery, index: number, v: EngineValue, slot = 0): EngineQuery {
  const cur = q.filters?.[index];
  if (!cur) return q;
  if (cur.op === "BETWEEN") {
    const values = [...(shapeFilter(cur).values ?? ["", ""])];
    values[slot === 1 ? 1 : 0] = v;
    return replaceFilter(q, index, { ...cur, values });
  }
  return replaceFilter(q, index, { ...cur, value: v });
}

/** The list of an "is one of" filter. */
export function setFilterValues(q: EngineQuery, index: number, values: EngineValue[]): EngineQuery {
  const cur = q.filters?.[index];
  if (!cur) return q;
  return replaceFilter(q, index, { ...cur, values });
}

/** Binds a filter value (or BETWEEN slot) to a report parameter, or - with null - back to an empty literal. */
export function bindFilterParam(q: EngineQuery, index: number, name: string | null, slot = 0): EngineQuery {
  const cur = q.filters?.[index];
  if (!cur) return q;
  if (opTakesList(cur.op)) return setFilterValues(q, index, name ? [paramValue(name)] : []);
  return setFilterValue(q, index, name ? paramValue(name) : "", slot);
}

export function setFilterSkipIfEmpty(q: EngineQuery, index: number, skip: boolean): EngineQuery {
  const cur = q.filters?.[index];
  if (!cur) return q;
  const next: EngineFilter = { ...cur };
  if (skip) next.skipIfEmpty = true; else delete next.skipIfEmpty;
  return replaceFilter(q, index, next);
}

/** Whether the filter holds a report parameter, i.e. whether "ignore when empty" means anything for it. */
export const filterHasParam = (f: EngineFilter) => allRefs(f).length > 0;

// ---------------------------------------------------------------- group & totals

export function toggleGroupBy(q: EngineQuery, view: EngineView, name: string): EngineQuery {
  if (!findColumn(view, name)) return q;
  const cur = q.groupBy ?? [];
  if (cur.includes(name)) return normalizeQuery({ ...q, groupBy: cur.filter((n) => n !== name) }, view);
  if (cur.length >= MAX_GROUP_BY) return q;
  return normalizeQuery({ ...q, groupBy: [...cur, name] }, view);
}

/** The first column a SUM/AVG can run on, so a new total starts valid. */
function firstNumberColumn(view: EngineView): string | undefined {
  return view.columns.find((c) => columnFamily(c.type) === "number")?.name;
}

export function addAggregate(q: EngineQuery, view: EngineView, fn: AggregateFn = "COUNT", column?: string): EngineQuery {
  if ((q.aggregates?.length ?? 0) >= MAX_AGGREGATES) return q;
  const agg: EngineAggregate = { fn };
  if (fn !== "COUNT" || column) {
    const col = column ?? (fn === "SUM" || fn === "AVG" ? firstNumberColumn(view) : view.columns[0]?.name);
    if (col) agg.column = col;
  }
  return normalizeQuery({ ...q, aggregates: [...(q.aggregates ?? []), agg] }, view);
}

export function updateAggregate(q: EngineQuery, view: EngineView, index: number, patch: Partial<EngineAggregate> & { as?: string | undefined }): EngineQuery {
  const cur = q.aggregates?.[index];
  if (!cur) return q;
  const merged: EngineAggregate = { ...cur, ...patch };
  if (patch.as !== undefined && patch.as.trim() === "") delete merged.as;
  if ("column" in patch && patch.column === undefined) delete merged.column;
  if (merged.fn !== "COUNT" && !merged.column) {
    const col = merged.fn === "SUM" || merged.fn === "AVG" ? firstNumberColumn(view) : view.columns[0]?.name;
    if (col) merged.column = col;
  }
  // A SUM/AVG left on a column that cannot take it moves to one that can.
  if (merged.column && !canAggregate(merged.fn, findColumn(view, merged.column))) {
    const col = firstNumberColumn(view);
    if (col) merged.column = col; else delete merged.column;
  }
  const aggregates = (q.aggregates ?? []).map((a, i) => (i === index ? merged : a));
  return normalizeQuery({ ...q, aggregates }, view);
}

export function removeAggregate(q: EngineQuery, view: EngineView, index: number): EngineQuery {
  return normalizeQuery({ ...q, aggregates: (q.aggregates ?? []).filter((_, i) => i !== index) }, view);
}

// ---------------------------------------------------------------- sort & limit

export function addOrder(q: EngineQuery, view: EngineView, column?: string): EngineQuery {
  if ((q.orderBy?.length ?? 0) >= MAX_ORDER_BY) return q;
  const used = new Set((q.orderBy ?? []).map((o) => o.column));
  const name = column ?? sortableNames(q, view).find((n) => !used.has(n));
  if (!name) return q;
  return normalizeQuery({ ...q, orderBy: [...(q.orderBy ?? []), { column: name }] }, view);
}

export function updateOrder(q: EngineQuery, view: EngineView, index: number, patch: Partial<EngineOrder>): EngineQuery {
  const orderBy = (q.orderBy ?? []).map((o, i) => {
    if (i !== index) return o;
    const next = { ...o, ...patch };
    if (!next.descending) delete next.descending;
    return next;
  });
  return normalizeQuery({ ...q, orderBy }, view);
}

export function removeOrder(q: EngineQuery, view: EngineView, index: number): EngineQuery {
  return normalizeQuery({ ...q, orderBy: (q.orderBy ?? []).filter((_, i) => i !== index) }, view);
}

/** A blank or invalid number clears the limit; a larger one than the engine allows is held at the cap. */
export function setLimit(q: EngineQuery, limit: number | null | undefined): EngineQuery {
  const next = { ...q };
  if (limit === null || limit === undefined || !Number.isFinite(limit) || limit < 1) delete next.limit;
  else next.limit = Math.min(Math.floor(limit), MAX_LIMIT);
  return clean(next);
}

// ---------------------------------------------------------------- validation

export type EngineQueryProblem = {
  /** Where in the query, e.g. `filters[1]`, `aggregates[0]`, `viewId`. */
  field: string;
  /** An i18n key under `engineQuery.problem.*`. Placeholders in the message are `{name}`s taken from `values`. */
  key: string;
  values?: Record<string, string | number>;
};

const problem = (field: string, key: string, values?: Record<string, string | number>): EngineQueryProblem =>
  values ? { field, key: `engineQuery.problem.${key}`, values } : { field, key: `engineQuery.problem.${key}` };

/** What is wrong with this query, if anything. Empty means the editor has nothing to say; the engine still has the last word. */
export function validateEngineQuery(
  q: EngineQuery,
  view: EngineView | null | undefined,
  parameterNames: readonly string[],
): EngineQueryProblem[] {
  const out: EngineQueryProblem[] = [];
  if (!q.viewId) {
    out.push(problem("viewId", "noView"));
    return out;
  }
  if (!view) {
    out.push(problem("viewId", "viewMissing", { view: q.viewId }));
    return out;
  }
  const params = new Set(parameterNames);
  const known = (name: string) => !!findColumn(view, name);
  const grouped = isGrouped(q);

  if (!grouped && q.columns?.length === 0) out.push(problem("columns", "noColumns"));
  for (const c of q.columns ?? []) {
    if (!known(c)) out.push(problem("columns", "unknownColumn", { column: c }));
    else if (grouped && !(q.groupBy ?? []).includes(c)) out.push(problem("columns", "columnsWhenGrouped", { column: c }));
  }

  (q.filters ?? []).forEach((f, i) => {
    const field = `filters[${i}]`;
    const col = findColumn(view, f.column);
    if (!col) {
      out.push(problem(field, "unknownColumn", { column: f.column }));
      return;
    }
    const family = columnFamily(col.type);
    if (!opsForFamily(family).includes(f.op)) out.push(problem(field, "filterOpNotAllowed", { column: f.column, op: f.op }));
    for (const ref of allRefs(f)) {
      if (!params.has(ref.$param)) out.push(problem(field, "filterParamUnknown", { name: ref.$param }));
    }
    const literalProblems = (vals: EngineValue[]) => {
      for (const v of vals) {
        if (family === "number" && !isParamRef(v) && !isBlankLiteral(v) && typeof v !== "number") {
          out.push(problem(field, "filterNotNumber", { column: f.column }));
          return;
        }
      }
    };
    if (opTakesNoValue(f.op)) return;
    if (f.op === "BETWEEN") {
      const vals = f.values ?? [];
      if (vals.length !== 2) out.push(problem(field, "filterBetweenTwo", { column: f.column }));
      else if (vals.some((v) => !isParamRef(v) && isBlankLiteral(v))) out.push(problem(field, "filterBetweenTwo", { column: f.column }));
      literalProblems(vals);
    } else if (opTakesList(f.op)) {
      const vals = f.values ?? [];
      if (vals.length === 0 || vals.every((v) => !isParamRef(v) && isBlankLiteral(v))) out.push(problem(field, "filterListEmpty", { column: f.column }));
      literalProblems(vals);
    } else {
      // A "blank means no filter" filter may hold nothing yet: it is only a filter once its parameter has a value.
      if (!isParamRef(f.value) && isBlankLiteral(f.value)) out.push(problem(field, "filterValueMissing", { column: f.column }));
      literalProblems(f.value === undefined ? [] : [f.value]);
    }
  });

  for (const g of q.groupBy ?? []) {
    if (!known(g)) out.push(problem("groupBy", "unknownColumn", { column: g }));
  }

  const aliases = new Set<string>(q.groupBy ?? []);
  (q.aggregates ?? []).forEach((a, i) => {
    const field = `aggregates[${i}]`;
    if (a.column) {
      const col = findColumn(view, a.column);
      if (!col) out.push(problem(field, "unknownColumn", { column: a.column }));
      else if (!canAggregate(a.fn, col)) out.push(problem(field, "aggNeedsNumber", { fn: a.fn, column: a.column }));
    } else if (a.fn !== "COUNT") {
      out.push(problem(field, "aggNeedsColumn", { fn: a.fn }));
    }
    const alias = aggregateAlias(a);
    if (a.as && !OUTPUT_NAME.test(a.as)) out.push(problem(field, "aggAliasInvalid", { name: a.as }));
    if (aliases.has(alias)) out.push(problem(field, "aggAliasDuplicate", { name: alias }));
    aliases.add(alias);
  });

  const sortable = new Set(sortableNames(q, view));
  (q.orderBy ?? []).forEach((o, i) => {
    if (!sortable.has(o.column)) out.push(problem(`orderBy[${i}]`, "orderUnknown", { column: o.column }));
  });

  if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > MAX_LIMIT)) {
    out.push(problem("limit", "limitInvalid", { max: MAX_LIMIT }));
  }
  return out;
}

// ---------------------------------------------------------------- the table block's columns

export type SuggestedTableColumn = { key: string; label: string; type: "string" | "number" | "date" | "datetime" };

function tableType(col: EngineViewColumn | undefined): SuggestedTableColumn["type"] {
  const family = columnFamily(col?.type);
  if (family === "number") return "number";
  if (family === "date") return /timestamp|datetime/i.test(col?.type ?? "") ? "datetime" : "date";
  return "string";
}

/**
 * The table-block columns for what the query returns: the chosen columns, or the group columns followed by the
 * totals under the names the engine gives them. `describeAggregate` words a total's heading ("Total of Amount");
 * without it the heading is the output name.
 */
export function suggestTableColumns(
  q: EngineQuery,
  view: EngineView,
  describeAggregate?: (fn: AggregateFn, columnLabel: string | undefined) => string,
): SuggestedTableColumn[] {
  const cols: SuggestedTableColumn[] = [];
  const labelOf = (c: EngineViewColumn) => c.label?.trim() || c.name;
  if (isGrouped(q)) {
    for (const g of q.groupBy ?? []) {
      const c = findColumn(view, g);
      if (c) cols.push({ key: c.name, label: labelOf(c), type: tableType(c) });
    }
    for (const a of q.aggregates ?? []) {
      const key = aggregateAlias(a);
      if (cols.some((c) => c.key === key)) continue;
      const src = a.column ? findColumn(view, a.column) : undefined;
      const type: SuggestedTableColumn["type"] = a.fn === "MIN" || a.fn === "MAX" ? tableType(src) : "number";
      const label = a.as ?? (describeAggregate ? describeAggregate(a.fn, src ? labelOf(src) : undefined) : key);
      cols.push({ key, label, type });
    }
    return cols;
  }
  for (const name of selectedColumns(q, view)) {
    const c = findColumn(view, name);
    if (c) cols.push({ key: c.name, label: labelOf(c), type: tableType(c) });
  }
  return cols;
}

/**
 * The suggestion applied to a table block's existing columns: a column the table already has keeps everything
 * the author set on it (label, format, totals, conditional formatting); a new one is added; one the query no
 * longer returns is dropped. Order follows the query.
 */
export function mergeTableColumns(existing: readonly TableColumn[], suggested: readonly SuggestedTableColumn[]): TableColumn[] {
  const byKey = new Map(existing.map((c) => [c.key, c]));
  return suggested.map((s) => byKey.get(s.key) ?? ({ ...s, total: "none" } as TableColumn));
}
