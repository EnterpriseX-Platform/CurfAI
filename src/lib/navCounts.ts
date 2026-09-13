/**
 * Tiny pub/sub so pages that create/delete reports, dashboards, or data
 * sources can tell the sidebar nav badges to refetch. The sidebar fetches
 * its counts once on mount; without this, a badge (e.g. "Dashboards")
 * stays stale after a same-page create/delete until a hard reload
 * remounts the component.
 */
const EVENT = "curf:nav-counts-refresh";

export function refreshNavCounts() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

export function onNavCountsRefresh(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(EVENT, callback);
  return () => window.removeEventListener(EVENT, callback);
}
