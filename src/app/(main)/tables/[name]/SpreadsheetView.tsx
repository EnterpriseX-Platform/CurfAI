"use client";
/**
 * The whole table as a spreadsheet — for tables too wide or too long for the
 * page's preview. Opens full screen over the page when the URL says
 * `?view=sheet` (so it can be linked to, and Back closes it).
 *
 * Rows come a page at a time from GET /api/lake/tables/[name]/rows, which
 * sorts and finds on the server and pages by keyset, so a million-row table
 * scrolls like a small one: the next page loads as you near the end of what's
 * loaded. Only about WINDOW_ROWS rows around the view are held (sheetPages.ts):
 * pages far behind are dropped and fetched again, by their own cursor, if you
 * scroll back. Only the rows and columns in view are drawn, and a row that
 * stays in view isn't drawn again as you scroll. The scrolling box shows a
 * window of the table no taller than a browser will draw (sheetScroll.ts), so
 * scrolling doesn't stop at a million rows. The row number and the first
 * column stay put while you scroll across.
 *
 * What the viewer may not see arrives masked, and a masked column can't be
 * sorted (the server refuses; the header says why). Formula columns are marked
 * and show their formula on hover. Column widths are remembered per table in
 * this browser. Someone who may change the table can add a column (the + at
 * the end of the header, or the toolbar) or edit a formula column's formula
 * (its header's pencil) — ColumnEditor, the same dialog as the table page's.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowDown, ArrowUp, Loader2, Lock, Pencil, Plus, Search, SquareFunction, X } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { translated } from "@/lib/i18n/fill";
import { isIdentifierLabel } from "@/lib/reporting/format";
import { ColumnEditor } from "./ColumnEditor";
import { NO_PAGES, cursorFor, droppedPageIn, keepAround, placePage, rowAt, type SheetPages, type SheetRow } from "./sheetPages";
import { bodyHeightFor, shiftWindow } from "./sheetScroll";

type SheetColumn = { name: string; type: string; formula?: string; masked?: boolean };
type RowsResponse = {
  columns: SheetColumn[];
  rows: SheetRow[];
  rowIdKey: string;
  next: string | null;
  rowCount: number;
};
type Sort = { column: string; dir: "asc" | "desc" } | null;
type Layout = { w: number[]; left: number[]; total: number };
type Format = (v: unknown, c: SheetColumn) => string;

const ROW_H = 32;
const HEAD_H = 36;
const NUM_W = 64;
const PAGE = 200;
const MIN_W = 56;
const MAX_W = 600;
/** Rows / columns drawn beyond the edges of the view, so a quick scroll doesn't show blanks. */
const OVERSCAN_ROWS = 12;
const OVERSCAN_PX = 400;
/** Rows held around the view; pages beyond are dropped and fetched again if scrolled back to. */
const WINDOW_ROWS = 10_000;
/** The + at the end of the header row. */
const ADD_W = 44;

export function SpreadsheetView({ tableName, canEdit }: { tableName: string; canEdit: boolean }) {
  const params = useSearchParams();
  const open = params.get("view") === "sheet";
  return open ? <Sheet tableName={tableName} canEdit={canEdit} /> : null;
}

function Sheet({ tableName, canEdit }: { tableName: string; canEdit: boolean }) {
  const { t, locale } = useT();
  const router = useRouter();
  const pathname = usePathname();

  const [columns, setColumns] = useState<SheetColumn[]>([]);
  // The pages fetched so far; only those around the view hold their rows.
  const [sheet, setSheet] = useState<SheetPages>(NO_PAGES);
  const [rowIdKey, setRowIdKey] = useState("row id");
  const [rowCount, setRowCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>(null);
  const [findText, setFindText] = useState("");
  const [find, setFind] = useState("");
  // Read after mount: the server has no localStorage, and a page opened straight at ?view=sheet renders there first.
  const [widths, setWidths] = useState<Record<string, number>>({});
  useEffect(() => setWidths(readWidths(tableName)), [tableName]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  // view.top is in the whole table's pixels; the scrolling box shows the
  // window of it that starts at `offset` (sheetScroll.ts).
  const [view, setView] = useState({ top: 0, left: 0, width: 0, height: 0 });
  const [offset, setOffset] = useState(0);
  const offsetRef = useRef(0);
  // What a page landing needs to know without being re-created on every scroll frame.
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;
  const viewRef = useRef(view);
  viewRef.current = view;

  const close = useCallback(() => router.replace(pathname, { scroll: false }), [router, pathname]);
  const [editor, setEditor] = useState<{ open: boolean; editing: string | null }>({ open: false, editing: null });
  // The dialog handles its own Escape; the sheet mustn't close under it.
  const editorOpen = useRef(false);
  editorOpen.current = editor.open;

  // ---- Loading ------------------------------------------------------------
  // Each new sort or search starts a new generation; an answer to an older
  // one is dropped, so a slow page can't land on top of a newer query.
  const generation = useRef(0);
  const inFlight = useRef(false);
  // A new sort or search cancels the request still out for the old one, so
  // typing doesn't queue up whole-table scans behind each other.
  const pending = useRef<AbortController | null>(null);
  // `reset` starts over at the top; otherwise `page` is fetched — the one
  // after the last, or one dropped earlier, each with its own cursor.
  const load = useCallback(async (opts: { reset: true } | { reset: false; page: number }) => {
    const gen = opts.reset ? ++generation.current : generation.current;
    let cursor: string | null = null;
    if (opts.reset) pending.current?.abort();
    else {
      const at = cursorFor(sheetRef.current, opts.page);
      if (inFlight.current || at === undefined) return;
      cursor = at;
    }
    const ctrl = new AbortController();
    pending.current = ctrl;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ limit: String(PAGE) });
    if (sort) { qs.set("sort", sort.column); qs.set("dir", sort.dir); }
    if (find) qs.set("find", find);
    if (cursor) qs.set("cursor", cursor);
    try {
      const res = await fetch(`/api/lake/tables/${encodeURIComponent(tableName)}/rows?${qs}`, { signal: ctrl.signal });
      const body = await res.json().catch(() => ({}));
      if (gen !== generation.current) return;
      if (!res.ok) {
        setError(translated(t, body?.key, body?.params, typeof body?.error === "string" ? body.error : t("sheet.loadFailed")));
        return;
      }
      const page = body as RowsResponse;
      setColumns(page.columns);
      setRowIdKey(page.rowIdKey);
      setRowCount(page.rowCount);
      // The page goes in its place, and pages far from the view let go of their rows.
      const v = viewRef.current;
      const top = Math.floor(v.top / ROW_H);
      setSheet((s) => keepAround(
        opts.reset ? placePage(NO_PAGES, 0, null, page.rows, page.next) : placePage(s, opts.page, cursor, page.rows, page.next),
        top, top + Math.ceil(v.height / ROW_H), WINDOW_ROWS,
      ));
    } catch {
      if (gen === generation.current && !ctrl.signal.aborted) setError(t("sheet.loadFailed"));
    } finally {
      if (gen === generation.current) { inFlight.current = false; setLoading(false); }
    }
  }, [tableName, sort, find, t]);

  useEffect(() => {
    inFlight.current = false;
    offsetRef.current = 0;
    setOffset(0);
    scrollRef.current?.scrollTo({ top: 0 });
    void load({ reset: true });
  }, [load]);

  // Searching as you type, a moment after the last key — from two
  // characters: one matches nearly every row and is rarely what's meant
  // (Enter searches for it anyway).
  useEffect(() => {
    const text = findText.trim();
    const id = setTimeout(() => setFind(text.length === 1 ? "" : text), 450);
    return () => clearTimeout(id);
  }, [findText]);
  useEffect(() => () => pending.current?.abort(), []);

  // A dropped page the view has come back to, then the next page when the
  // view comes within two screens of what's loaded.
  useEffect(() => {
    if (loading || error) return;
    const from = Math.max(0, Math.floor(view.top / ROW_H) - OVERSCAN_ROWS);
    const dropped = droppedPageIn(sheet, from, Math.ceil((view.top + view.height) / ROW_H) + OVERSCAN_ROWS);
    if (dropped !== null) void load({ reset: false, page: dropped });
    else if (sheet.next && sheet.total * ROW_H - (view.top + view.height) < view.height * 2) void load({ reset: false, page: sheet.pages.length });
  }, [view, sheet, loading, error, load]);

  // ---- Page chrome --------------------------------------------------------
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      // An Escape a dialog above the sheet already handled (Radix marks it
      // defaultPrevented) closes that dialog, not the sheet. The open flag
      // alone isn't enough: React re-renders before this listener runs, so
      // by now it already reads "closed".
      if (editorOpen.current || e.defaultPrevented) return;
      if (e.key === "Escape" && document.activeElement !== findRef.current) close();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); findRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
  }, [close]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const s = sheetRef.current;
      const moved = shiftWindow({
        offset: offsetRef.current, scrollTop: el.scrollTop, viewPx: el.clientHeight,
        contentPx: s.total * ROW_H + (s.next ? ROW_H : 0), rowPx: ROW_H,
      });
      if (moved) {
        // The rows move up (or down) the box and the scroll position with
        // them, in the same frame, so nothing on screen jumps.
        offsetRef.current = moved.offset;
        flushSync(() => setOffset(moved.offset));
        el.scrollTop = moved.scrollTop;
      }
      setView({ top: offsetRef.current + el.scrollTop, left: el.scrollLeft, width: el.clientWidth, height: el.clientHeight - HEAD_H });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    let frame = 0;
    const onScroll = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener("scroll", onScroll); cancelAnimationFrame(frame); };
  }, []);

  // ---- Layout -------------------------------------------------------------
  const layout = useMemo((): Layout => {
    const w = columns.map((c) => widths[c.name] ?? defaultWidth(c));
    const left: number[] = [];
    let x = NUM_W;
    for (const cw of w) { left.push(x); x += cw; }
    return { w, left, total: x + (canEdit ? ADD_W : 0) };
  }, [columns, widths, canEdit]);

  // Columns in view, besides the first, which is always drawn (it stays put).
  const [colFrom, colTo] = useMemo(() => {
    if (columns.length <= 1) return [1, 0];
    const lo = view.left - OVERSCAN_PX;
    const hi = view.left + view.width + OVERSCAN_PX;
    let from = 1;
    while (from < columns.length - 1 && layout.left[from]! + layout.w[from]! < lo) from++;
    let to = from;
    while (to < columns.length - 1 && layout.left[to + 1]! < hi) to++;
    return [from, to];
  }, [columns.length, layout, view.left, view.width]);

  const rowFrom = Math.max(0, Math.floor(view.top / ROW_H) - OVERSCAN_ROWS);
  const rowTo = Math.min(sheet.total, Math.ceil((view.top + view.height) / ROW_H) + OVERSCAN_ROWS);
  const bodyHeight = bodyHeightFor(sheet.total * ROW_H + (sheet.next ? ROW_H : 0), offset);
  // Space the drawn columns leave out between the first column and the first one in view.
  const gap = columns.length > 1 ? layout.left[colFrom]! - layout.left[1]! : 0;
  const drawn = columns.length > 1 ? columns.slice(colFrom, colTo + 1).map((c, i) => ({ c, i: colFrom + i })) : [];

  // ---- Sorting and resizing -----------------------------------------------
  const cycleSort = (c: SheetColumn) => {
    if (c.masked) return;
    setSort((s) => (s?.column !== c.name ? { column: c.name, dir: "asc" } : s.dir === "asc" ? { column: c.name, dir: "desc" } : null));
  };

  const startResize = (e: React.PointerEvent, name: string, from: number) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    let latest = from;
    const move = (ev: PointerEvent) => {
      latest = Math.max(MIN_W, Math.min(MAX_W, from + ev.clientX - x0));
      setWidths((w) => ({ ...w, [name]: latest }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setWidths((w) => { writeWidths(tableName, w); return w; });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const fmt = useMemo(() => formatter(locale, t), [locale, t]);
  const formulaCount = columns.filter((c) => c.formula).length;

  // ---- Render -------------------------------------------------------------
  const headCell = (c: SheetColumn, i: number, sticky: boolean) => {
    const sorted = sort?.column === c.name ? sort.dir : null;
    const title = c.masked ? t("sheet.maskedColumn") : c.formula ? `= ${c.formula}` : `${c.name} · ${typeLabel(c, t)}`;
    return (
      <div
        key={c.name}
        role="columnheader"
        aria-colindex={i + 2}
        aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
        title={title}
        className={`group relative flex h-full shrink-0 select-none items-center gap-1.5 border-r border-border px-2.5 font-mono text-[11.5px] font-medium ${
          c.formula ? "bg-primary-soft text-primary-ink" : "bg-muted text-foreground"
        } ${sticky ? "sticky z-20 shadow-[1px_0_0_hsl(var(--border))]" : ""}`}
        style={{ width: layout.w[i], ...(sticky ? { left: NUM_W } : {}) }}
      >
        <button
          type="button"
          onClick={() => cycleSort(c)}
          disabled={c.masked}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default"
        >
          {c.formula
            ? <SquareFunction className="h-3.5 w-3.5 shrink-0" aria-label={t("sheet.formulaColumn")} />
            : <span className="shrink-0 text-[10px] text-faint">{TYPE_MARK[c.type] ?? "Aa"}</span>}
          <span className="truncate">{c.name}</span>
          {c.masked && <Lock className="h-3 w-3 shrink-0 text-faint" aria-label={t("sheet.maskedColumn")} />}
          {sorted === "asc" && <ArrowUp className="h-3 w-3 shrink-0 text-primary-ink" />}
          {sorted === "desc" && <ArrowDown className="h-3 w-3 shrink-0 text-primary-ink" />}
        </button>
        {canEdit && c.formula && (
          <button
            type="button"
            onClick={() => setEditor({ open: true, editing: c.name })}
            aria-label={`${t("sheet.editFormula")} · ${c.name}`}
            title={t("sheet.editFormula")}
            className="shrink-0 rounded p-0.5 opacity-0 hover:bg-primary/15 focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
        <span
          aria-hidden="true"
          onPointerDown={(e) => startResize(e, c.name, layout.w[i]!)}
          className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-primary/40"
        />
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background" role="dialog" aria-modal="true" aria-label={t("sheet.title").replace("{name}", tableName)}>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-b border-border bg-card px-4 py-2.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5">
          <span className="truncate font-mono text-[15px] font-semibold">{tableName}</span>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {t("sheet.meta")
              .replace("{rows}", rowCount.toLocaleString(locale))
              .replace("{cols}", String(columns.length))
              .replace("{formulas}", formulaCount ? t("sheet.metaFormulas").replace("{n}", String(formulaCount)) : "")}
          </span>
        </div>
        <div className="flex-1" />
        <label className="flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-faint" />
          <input
            ref={findRef}
            type="search"
            value={findText}
            onChange={(e) => setFindText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setFind(findText.trim());
              if (e.key === "Escape") { if (findText) setFindText(""); else close(); }
            }}
            placeholder={t("sheet.findPlaceholder")}
            aria-label={t("sheet.findPlaceholder")}
            className="w-48 max-w-[42vw] bg-transparent text-[13px] outline-none"
          />
        </label>
        {canEdit && (
          <button
            type="button"
            onClick={() => setEditor({ open: true, editing: null })}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-card px-3 text-[13px] font-medium hover:bg-accent"
          >
            <Plus className="h-3.5 w-3.5" /> {t("sheet.addColumn")}
          </button>
        )}
        <button
          type="button"
          onClick={close}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-card px-3 text-[13px] font-medium hover:bg-accent"
        >
          <X className="h-3.5 w-3.5" /> {t("sheet.close")}
        </button>
      </div>

      <div
        ref={scrollRef}
        tabIndex={0}
        role="grid"
        aria-rowcount={rowCount + 1}
        aria-colcount={columns.length + 1}
        aria-busy={loading}
        className="relative flex-1 overflow-auto bg-card outline-none"
      >
        <div className="relative" style={{ width: layout.total, minWidth: "100%" }}>
          {/* Header */}
          <div role="row" aria-rowindex={1} className="sticky top-0 z-30 flex border-b border-border bg-muted" style={{ height: HEAD_H, width: layout.total }}>
            <div className="sticky left-0 z-30 flex h-full shrink-0 items-center justify-end border-r border-border bg-muted px-2.5 font-mono text-[11px] text-faint" style={{ width: NUM_W }}>#</div>
            {columns.length > 0 && headCell(columns[0]!, 0, true)}
            {gap > 0 && <div className="shrink-0" style={{ width: gap }} />}
            {drawn.map(({ c, i }) => headCell(c, i, false))}
            {canEdit && colTo === columns.length - 1 && (
              <button
                type="button"
                onClick={() => setEditor({ open: true, editing: null })}
                aria-label={t("sheet.addColumn")}
                title={t("sheet.addColumn")}
                className="flex h-full shrink-0 items-center justify-center border-r border-border bg-muted text-primary-ink hover:bg-primary-soft"
                style={{ width: ADD_W }}
              >
                <Plus className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Rows */}
          <div className="relative" style={{ height: bodyHeight }}>
            {Array.from({ length: Math.max(0, rowTo - rowFrom) }, (_, k) => {
              const at = rowFrom + k;
              const r = rowAt(sheet, at);
              return (
                <SheetRowView
                  // A row whose page was dropped shows only its number until the page is back.
                  key={r ? String(r[rowIdKey] ?? at) : `@${at}`}
                  row={r}
                  at={at}
                  top={at * ROW_H - offset}
                  columns={columns}
                  layout={layout}
                  colFrom={colFrom}
                  colTo={colTo}
                  gap={gap}
                  fmt={fmt}
                  locale={locale}
                />
              );
            })}
            {sheet.next && (
              <div className="absolute left-0 flex items-center gap-2 px-3 text-xs text-muted-foreground" style={{ top: sheet.total * ROW_H - offset, height: ROW_H }}>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("sheet.loadingMore")}
              </div>
            )}
          </div>
        </div>

        {sheet.total === 0 && !loading && !error && (
          <p className="absolute inset-x-0 top-24 text-center text-sm text-muted-foreground">
            {find ? t("sheet.noMatches").replace("{find}", find) : t("sheet.noRows")}
          </p>
        )}
        {sheet.total === 0 && loading && (
          <p className="absolute inset-x-0 top-24 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("sheet.loading")}
          </p>
        )}
        {error && (
          <div className="absolute inset-x-0 top-24 flex flex-col items-center gap-2 text-sm">
            <p className="text-destructive">{error}</p>
            <button
              type="button"
              // With rows already shown, clearing the error has the view ask again for the page it needs.
              onClick={() => (sheet.total ? setError(null) : void load({ reset: true }))}
              className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3 text-[13px] font-medium hover:bg-accent"
            >
              {t("sheet.retry")}
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-t border-border bg-card px-4 py-2 font-mono text-[11.5px] tabular-nums text-muted-foreground">
        <span>
          {find
            ? t(sheet.next ? "sheet.footMatchesMore" : "sheet.footMatches").replace("{n}", sheet.total.toLocaleString(locale))
            : t("sheet.footLoaded").replace("{n}", sheet.total.toLocaleString(locale)).replace("{total}", rowCount.toLocaleString(locale))}
        </span>
        <span>{t("sheet.footHint")}</span>
      </div>

      {canEdit && (
        <ColumnEditor
          tableName={tableName}
          columns={columns}
          editing={editor.editing}
          open={editor.open}
          onOpenChange={(open) => setEditor((e) => ({ ...e, open }))}
          onSaved={() => { void load({ reset: true }); router.refresh(); }}
        />
      )}
    </div>
  );
}

type SheetRowProps = {
  row: SheetRow | undefined;
  at: number;
  /** Where the row sits in the scrolling box's window. */
  top: number;
  columns: SheetColumn[];
  layout: Layout;
  colFrom: number;
  colTo: number;
  gap: number;
  fmt: Format;
  locale: string;
};

/**
 * One row. Memoized: a scroll frame re-renders only the rows that came into
 * view — the props of one that stays put change only when the columns in
 * view, their widths, the locale or the window (a rare move) do.
 */
const SheetRowView = memo(function SheetRowView({ row, at, top, columns, layout, colFrom, colTo, gap, fmt, locale }: SheetRowProps) {
  return (
    <div
      role="row"
      aria-rowindex={at + 2}
      className="absolute left-0 flex border-b border-border bg-card hover:bg-muted"
      style={{ top, height: ROW_H, width: layout.total }}
    >
      <div className="sticky left-0 z-10 flex h-full shrink-0 items-center justify-end border-r border-border bg-inherit px-2.5 font-mono text-[11px] tabular-nums text-faint" style={{ width: NUM_W }}>
        {(at + 1).toLocaleString(locale)}
      </div>
      {row && columns.length > 0 && cell(columns[0]!, 0, layout.w[0]!, row[columns[0]!.name], true, fmt)}
      {row && gap > 0 && <div className="shrink-0" style={{ width: gap }} />}
      {row && columns.length > 1 && columns.slice(colFrom, colTo + 1).map((c, k) => cell(c, colFrom + k, layout.w[colFrom + k]!, row[c.name], false, fmt))}
    </div>
  );
});

function cell(c: SheetColumn, i: number, width: number, v: unknown, sticky: boolean, fmt: Format) {
  const num = c.type === "number";
  const empty = v == null || v === "";
  return (
    <div
      key={c.name}
      role="gridcell"
      aria-colindex={i + 2}
      className={`flex h-full shrink-0 items-center overflow-hidden border-r border-border px-2.5 text-[12.5px] ${num ? "justify-end tabular-nums" : ""} ${
        // A sticky cell needs a solid fill, or the columns scrolling under it show through.
        c.formula ? (sticky ? "bg-primary-soft" : "bg-primary-soft/60") : sticky ? "bg-inherit" : ""
      } ${empty ? "text-faint" : ""} ${sticky ? "sticky z-10 shadow-[1px_0_0_hsl(var(--border))]" : ""}`}
      style={{ width, ...(sticky ? { left: NUM_W } : {}) }}
    >
      <span className="truncate">{fmt(v, c)}</span>
    </div>
  );
}

const TYPE_MARK: Record<string, string> = { text: "Aa", number: "#", date: "D", boolean: "✓" };

function typeLabel(c: SheetColumn, t: (k: string) => string): string {
  return t(`sheet.type.${c.type in TYPE_MARK ? c.type : "text"}`);
}

/** A width that fits the column's name and the kind of value it holds. */
function defaultWidth(c: SheetColumn): number {
  const byType = c.type === "number" ? 104 : c.type === "date" ? 116 : c.type === "boolean" ? 84 : 150;
  return Math.max(byType, Math.min(260, c.name.length * 8 + 56));
}

/**
 * How a value shows in a cell: numbers in the reader's format without float
 * noise, yes/no in words, blanks as a dash. A whole number in a column named
 * as a year, code or id (fiscal_year, project_code, loan_id, ปีงบ) is written
 * as it is — 2566, not "2,566" — by the same rule a KPI headline uses
 * (isIdentifierLabel), read with the column name's underscores as spaces.
 */
function formatter(locale: string, t: (k: string) => string) {
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 10 });
  const identifier = new Map<string, boolean>();
  const isIdentifier = (name: string) => {
    let hit = identifier.get(name);
    if (hit === undefined) identifier.set(name, (hit = isIdentifierLabel(name.replace(/_/g, " "))));
    return hit;
  };
  return (v: unknown, c: SheetColumn): string => {
    if (v == null || v === "") return "—";
    if (c.type === "boolean" || typeof v === "boolean") {
      if (v === true || v === 1 || v === "1" || v === "true") return t("sheet.yes");
      if (v === false || v === 0 || v === "0" || v === "false") return t("sheet.no");
    }
    if (c.type === "number") {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isInteger(n) && isIdentifier(c.name)) return String(n);
      if (Number.isFinite(n)) return nf.format(n);
    }
    return String(v);
  };
}

const widthsKey = (table: string) => `curf.sheet.widths.${table}`;

function readWidths(table: string): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(widthsKey(table)) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function writeWidths(table: string, widths: Record<string, number>): void {
  try { localStorage.setItem(widthsKey(table), JSON.stringify(widths)); } catch { /* a convenience only */ }
}
