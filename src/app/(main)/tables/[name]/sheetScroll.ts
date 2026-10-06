/**
 * Scrolling the spreadsheet past what a browser will draw.
 *
 * A browser caps an element's height: about 33.5 million px in Chrome and
 * 17.9 million in Firefox. At 32px a row, the sheet stopped there, at about a
 * million rows (560k in Firefox), and the rows beyond couldn't be scrolled to.
 *
 * So the scrolling box is never taller than MAX_BODY_PX. It shows a window of
 * the table: a row at y in the whole table is drawn at y - offset. When the
 * view comes within EDGE_PX of the window's end, the window moves on by
 * SHIFT_PX and the scroll position moves back by the same amount, so nothing
 * on screen moves. Going back up works the same way. A wheel or a key scrolls
 * one to one everywhere; the scrollbar spans the window, not the whole table
 * (it already spanned only the rows loaded so far).
 */
export const MAX_BODY_PX = 4_000_000;
/** Far enough from both edges that one move never lands at the other edge. */
const EDGE_PX = MAX_BODY_PX / 8;
const SHIFT_PX = MAX_BODY_PX / 2;

/** How tall the scrolling box is for `contentPx` of rows, from `offset`. */
export function bodyHeightFor(contentPx: number, offset: number): number {
  return Math.max(0, Math.min(contentPx - offset, MAX_BODY_PX));
}

/**
 * Where the window and the scroll position move to, or null when the view is
 * clear of both edges. Moves are whole rows, so rows keep whole-pixel tops.
 */
export function shiftWindow(o: { offset: number; scrollTop: number; viewPx: number; contentPx: number; rowPx: number }): { offset: number; scrollTop: number } | null {
  const { offset, scrollTop, viewPx, contentPx, rowPx } = o;
  const whole = (px: number) => Math.floor(px / rowPx) * rowPx;
  if (scrollTop + viewPx > MAX_BODY_PX - EDGE_PX && offset + MAX_BODY_PX < contentPx) {
    const by = whole(SHIFT_PX);
    return { offset: offset + by, scrollTop: scrollTop - by };
  }
  if (scrollTop < EDGE_PX && offset > 0) {
    const by = Math.min(offset, whole(SHIFT_PX));
    return { offset: offset - by, scrollTop: scrollTop + by };
  }
  return null;
}
