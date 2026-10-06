/**
 * The sidebar's nav badge counts, and a tiny pub/sub so pages that create or
 * delete reports, dashboards or data sources can tell the badges to refetch.
 *
 * Every page renders its own AppShell, so the Sidebar mounts on every
 * navigation. The counts come from one GET /api/nav/counts, and the answer is
 * kept here per workspace for NAV_COUNTS_TTL_MS: a Sidebar that mounts within
 * that time shows it straight away and asks for nothing.
 *
 * refreshNavCounts() marks what's kept stale (and has the next request skip
 * the route's own cache, which holds an answer for as long); however many
 * calls land in the same tick, the Sidebar sees one event and makes one
 * request.
 */
const EVENT = "curf:nav-counts-refresh";

/** How long one answer serves every Sidebar mount — the route keeps its own copy as long. */
export const NAV_COUNTS_TTL_MS = 30_000;

export type NavCounts = {
  reports?: number;
  sources?: number;
  dashboards?: number;
  onScreen?: number;
  notebooks?: number;
  templates?: number;
  decisions?: number;
  metrics?: number;
  /** Operate requests whose current approval step names the caller. */
  inbox?: number;
  watchers?: number;
  dataQuality?: number;
  /** Deep Ask answers finished but not yet opened. */
  askUnread?: number;
};

type Entry = { at: number; counts?: NavCounts; pending?: Promise<NavCounts | null> };

const cache = new Map<string, Entry>();
let skipServerCache = false;
let refreshQueued = false;
let latestKey: string | null = null;

/** What's kept for this workspace, however old — shown while a newer answer loads. */
export function peekNavCounts(key: string): NavCounts | undefined {
  return cache.get(key)?.counts;
}

/** The counts the Sidebar on this page last showed, if it has any yet. */
export function currentNavCounts(): NavCounts | undefined {
  return latestKey ? cache.get(latestKey)?.counts : undefined;
}

/**
 * The counts for one workspace (`key` names the workspace and who's looking).
 * Kept answers under NAV_COUNTS_TTL_MS old are reused, and callers that ask
 * while a request is out share it. Resolves to the newest counts kept once
 * the request settles — never to an answer a refresh has since dropped.
 */
export function loadNavCounts(key: string): Promise<NavCounts | null> {
  latestKey = key;
  const kept = cache.get(key);
  if (kept?.pending) return kept.pending;
  if (kept?.counts && Date.now() - kept.at < NAV_COUNTS_TTL_MS) return Promise.resolve(kept.counts);
  const url = skipServerCache ? "/api/nav/counts?fresh=1" : "/api/nav/counts";
  skipServerCache = false;
  const pending: Promise<NavCounts | null> = fetch(url, { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<NavCounts>) : null))
    .catch(() => null)
    .then((counts) => {
      // A refresh that came in while this was out has already dropped it.
      // A failed request keeps what was shown, stale, so the next mount retries.
      if (cache.get(key)?.pending === pending) {
        cache.set(key, counts ? { at: Date.now(), counts } : { at: 0, counts: kept?.counts });
      }
      return cache.get(key)?.counts ?? null;
    });
  cache.set(key, { at: kept?.at ?? 0, counts: kept?.counts, pending });
  return pending;
}

export function refreshNavCounts() {
  if (typeof window === "undefined") return;
  // Stale at once — a Sidebar that mounts before the event fires refetches
  // too — and an answer still out may predate the change, so it's dropped.
  for (const [key, entry] of cache) cache.set(key, { at: 0, counts: entry.counts });
  skipServerCache = true;
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => {
    refreshQueued = false;
    window.dispatchEvent(new Event(EVENT));
  }, 0);
}

export function onNavCountsRefresh(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(EVENT, callback);
  return () => window.removeEventListener(EVENT, callback);
}
