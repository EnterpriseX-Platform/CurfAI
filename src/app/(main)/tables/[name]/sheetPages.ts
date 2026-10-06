/**
 * The spreadsheet view's rows (SpreadsheetView.tsx), held a page at a time
 * as they come from GET /api/lake/tables/[name]/rows.
 *
 * Only the pages around the view keep their rows: scroll a long way and the
 * ones far behind are dropped, each remembering the cursor that fetched it,
 * so scrolling back fetches it again. A dropped page keeps its place (its
 * first row and length), so the scroll height and every row's position stay
 * as they were. The first page is never dropped: fetching it again would be
 * a request with no cursor, which the rows route treats as a new look at the
 * table (it audits a sensitive read once per look, not once per page).
 *
 * Pure and immutable — a new page copies the list of pages, never the rows.
 */
export type SheetRow = Record<string, unknown>;

export type SheetPage = {
  /** The cursor that fetched this page (null for the first) — fetched with it again once dropped. */
  cursor: string | null;
  /** Its first row's position in the table. */
  start: number;
  /** How many rows it held when first fetched: its share of the scroll. */
  length: number;
  /** Null once dropped. */
  rows: SheetRow[] | null;
};

export type SheetPages = {
  pages: SheetPage[];
  /** The cursor of the page after the last one fetched; null once the table's end is reached. */
  next: string | null;
  /** Rows reached so far — what the scroll covers. */
  total: number;
};

export const NO_PAGES: SheetPages = { pages: [], next: null, total: 0 };

/**
 * The cursor to fetch page `index` with: a dropped page's own, or `next` for
 * the page after the last. Undefined when there's nothing to fetch there —
 * the page holds its rows, or the table has no more.
 */
export function cursorFor(s: SheetPages, index: number): string | null | undefined {
  if (index < s.pages.length) return s.pages[index]!.rows ? undefined : s.pages[index]!.cursor;
  if (index === s.pages.length) return index === 0 ? null : s.next ?? undefined;
  return undefined;
}

/**
 * A fetched page put in its place: after the last (it must have been fetched
 * with `next`), or back where it was dropped. Anything else — an answer that
 * no longer fits, say — leaves the pages as they were.
 */
export function placePage(s: SheetPages, index: number, cursor: string | null, rows: SheetRow[], next: string | null): SheetPages {
  if (index === s.pages.length) {
    if (cursor !== (index === 0 ? null : s.next)) return s;
    return {
      pages: [...s.pages, { cursor, start: s.total, length: rows.length, rows }],
      next,
      total: s.total + rows.length,
    };
  }
  const page = s.pages[index];
  if (!page || page.rows || page.cursor !== cursor) return s;
  const pages = s.pages.slice();
  // Rows added or deleted since can't move the rest of the table: the page keeps its length.
  pages[index] = { ...page, rows: rows.slice(0, page.length) };
  return { ...s, pages };
}

/** The page holding row `i`, or -1 past the rows reached. */
export function pageOf(s: SheetPages, i: number): number {
  if (i < 0 || i >= s.total) return -1;
  let lo = 0;
  let hi = s.pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s.pages[mid]!.start <= i) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Row `i`, if its page holds its rows. */
export function rowAt(s: SheetPages, i: number): SheetRow | undefined {
  const p = pageOf(s, i);
  if (p < 0) return undefined;
  const page = s.pages[p]!;
  return page.rows?.[i - page.start];
}

/** The first dropped page among rows [from, to), which the view needs again; null when there's none. */
export function droppedPageIn(s: SheetPages, from: number, to: number): number | null {
  for (let p = pageOf(s, Math.max(0, from)); p >= 0 && p < s.pages.length && s.pages[p]!.start < to; p++) {
    if (!s.pages[p]!.rows) return p;
  }
  return null;
}

/**
 * Drops the rows of every page outside `windowRows` centred on rows
 * [from, to) — the first page excepted. The same pages back when nothing
 * was dropped.
 */
export function keepAround(s: SheetPages, from: number, to: number, windowRows: number): SheetPages {
  const centre = (from + to) / 2;
  const lo = centre - windowRows / 2;
  const hi = centre + windowRows / 2;
  let pages: SheetPage[] | null = null;
  for (let p = 1; p < s.pages.length; p++) {
    const page = s.pages[p]!;
    if (!page.rows || (page.start + page.length > lo && page.start < hi)) continue;
    pages ??= s.pages.slice();
    pages[p] = { ...page, rows: null };
  }
  return pages ? { ...s, pages } : s;
}

/** Rows held in memory. */
export function heldRows(s: SheetPages): number {
  return s.pages.reduce((n, page) => n + (page.rows?.length ?? 0), 0);
}
