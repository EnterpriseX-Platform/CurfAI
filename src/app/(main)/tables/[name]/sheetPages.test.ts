/**
 * The spreadsheet view's page window (sheetPages.ts). The 2026-09-30 audit
 * (P7) found every row scrolled past kept in memory — 187 MB of heap at
 * 500k rows — and the whole array copied on each page. Pages far from the
 * view now drop their rows and are fetched again, by their own cursor, when
 * scrolled back to.
 */
import { describe, it, expect } from "vitest";
import {
  NO_PAGES, cursorFor, droppedPageIn, heldRows, keepAround, pageOf, placePage, rowAt, type SheetPages,
} from "./sheetPages";

const PAGE = 200;
const rows = (from: number, n = PAGE) => Array.from({ length: n }, (_, k) => ({ id: from + k }));

/** `count` full pages, as the view would fetch them one after another. */
function fetched(count: number, last = PAGE): SheetPages {
  let s = NO_PAGES;
  for (let p = 0; p < count; p++) {
    const isLast = p === count - 1;
    s = placePage(s, p, cursorFor(s, p) as string | null, rows(p * PAGE, isLast ? last : PAGE), isLast && last < PAGE ? null : `c${p + 1}`);
  }
  return s;
}

describe("sheetPages", () => {
  it("appends each page after the last, fetched with the previous page's cursor", () => {
    let s = placePage(NO_PAGES, 0, null, rows(0), "c1");
    expect(cursorFor(s, 1)).toBe("c1");
    s = placePage(s, 1, "c1", rows(200), "c2");
    expect(s.total).toBe(400);
    expect(s.next).toBe("c2");
    expect(s.pages.map((p) => [p.cursor, p.start, p.length])).toEqual([[null, 0, 200], ["c1", 200, 200]]);
    expect(rowAt(s, 0)).toEqual({ id: 0 });
    expect(rowAt(s, 399)).toEqual({ id: 399 });
    expect(rowAt(s, 400)).toBeUndefined();
  });

  it("keeps the rows it was given, not a copy of everything before", () => {
    const first = rows(0);
    const s = placePage(placePage(NO_PAGES, 0, null, first, "c1"), 1, "c1", rows(200), null);
    expect(s.pages[0]!.rows).toBe(first);
  });

  it("has nothing to fetch at the end of the table, or where a page holds its rows", () => {
    const s = fetched(3, 50);
    expect(s.next).toBeNull();
    expect(s.total).toBe(450);
    expect(cursorFor(s, 3)).toBeUndefined();
    expect(cursorFor(s, 1)).toBeUndefined();
    expect(cursorFor(NO_PAGES, 0)).toBeNull();
  });

  it("ignores an answer that no longer fits where it was asked for", () => {
    const s = fetched(2);
    expect(placePage(s, 2, "stale", rows(400), "c3")).toBe(s);   // not the cursor after the last page
    expect(placePage(s, 5, "c5", rows(1000), null)).toBe(s);       // past the end
    expect(placePage(s, 1, "c1", rows(200), "c2")).toBe(s);        // page 1 still holds its rows
  });

  it("finds the page of a row by position", () => {
    const s = fetched(5, 10);
    expect(pageOf(s, 0)).toBe(0);
    expect(pageOf(s, 199)).toBe(0);
    expect(pageOf(s, 200)).toBe(1);
    expect(pageOf(s, 809)).toBe(4);
    expect(pageOf(s, 810)).toBe(-1);
    expect(pageOf(s, -1)).toBe(-1);
  });

  it("keeps about 10k rows around the view and the first page, however far it scrolls", () => {
    // 500k rows reached, the view now near the end.
    let s = NO_PAGES;
    for (let p = 0; p < 2500; p++) {
      s = placePage(s, p, cursorFor(s, p) as string | null, rows(p * PAGE), `c${p + 1}`);
      const viewTop = p * PAGE;
      s = keepAround(s, viewTop, viewTop + 30, 10_000);
    }
    expect(s.total).toBe(500_000);
    expect(heldRows(s)).toBeLessThanOrEqual(10_000 + 2 * PAGE);
    expect(s.pages[0]!.rows).not.toBeNull();
    expect(rowAt(s, 499_999)).toEqual({ id: 499_999 });
    expect(rowAt(s, 250_000)).toBeUndefined();
    // Dropped pages keep their place: the scroll covers every row reached.
    expect(s.pages[1250]).toMatchObject({ start: 250_000, length: 200, rows: null, cursor: "c1250" });
  });

  it("returns the same pages when nothing needs dropping", () => {
    const s = fetched(10);
    expect(keepAround(s, 0, 30, 10_000)).toBe(s);
  });

  it("finds a dropped page the view scrolled back to, and fetches it again with its own cursor", () => {
    let s = keepAround(fetched(100), 19_900, 19_930, 10_000);
    expect(rowAt(s, 990)).toBeUndefined();
    expect(droppedPageIn(s, 19_800, 19_900)).toBeNull();
    // Rows 990–1,029 span page 4 (800–999) and page 5 (1,000–1,199): the first comes back first.
    expect(droppedPageIn(s, 990, 1_030)).toBe(4);
    expect(cursorFor(s, 4)).toBe("c4");
    s = placePage(s, 4, "c4", rows(800), "c5");
    expect(rowAt(s, 990)).toEqual({ id: 990 });
    expect(s.total).toBe(20_000);
    expect(s.next).toBe("c100");
    expect(droppedPageIn(s, 990, 1_030)).toBe(5);
    s = placePage(s, 5, "c5", rows(1_000), "c6");
    expect(rowAt(s, 1_000)).toEqual({ id: 1_000 });
    expect(droppedPageIn(s, 990, 1_030)).toBeNull();
  });

  it("keeps a page's place when it comes back with fewer rows", () => {
    let s = keepAround(fetched(100), 19_900, 19_930, 10_000);
    s = placePage(s, 3, "c3", rows(600, 150), "c4");
    expect(s.pages[3]).toMatchObject({ start: 600, length: 200 });
    expect(rowAt(s, 749)).toEqual({ id: 749 });
    expect(rowAt(s, 750)).toBeUndefined();
    expect(pageOf(s, 800)).toBe(4);
    // A short page isn't "dropped": the view doesn't keep asking for it.
    expect(droppedPageIn(s, 700, 800)).toBeNull();
  });
});
