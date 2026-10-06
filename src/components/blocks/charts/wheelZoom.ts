/**
 * When a mouse wheel over a chart zooms it instead of scrolling the page —
 * one rule for ChartZoom (every 2D chart) and Stage3D (the 3D views):
 *
 *   - Ctrl/⌘ + wheel, or a trackpad pinch (which arrives as one): always;
 *   - a plain wheel in the Enlarge view (ExpandableCell's [data-expanded]),
 *     where there is no page to scroll;
 *   - a plain wheel on the page once the reader has clicked into the chart,
 *     until the pointer leaves it.
 *
 * A plain wheel over a chart nobody clicked scrolls the page: an executive
 * view is a column of charts, and scrolling past them must never zoom one
 * by accident (a map in the middle of a page once swallowed every scroll).
 */
export function wheelZooms(e: WheelEvent, el: Element, activated: boolean): boolean {
  return e.ctrlKey || e.metaKey || activated || !!el.closest("[data-expanded]");
}
