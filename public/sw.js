/**
 * Curf service worker — round 12 PWA.
 *
 * Caching strategies:
 *   - Static assets (/_next/static/*, /icon.svg, /apple-icon.svg,
 *     /manifest.webmanifest): cache-first with stale-while-revalidate.
 *     These have content-hashed URLs so we can cache aggressively.
 *
 *   - Navigations (HTML routes): network-first with offline fallback
 *     to a cached "you're offline" shell. We don't pre-render arbitrary
 *     report pages — those need fresh data — but a cached-page-from-
 *     last-visit fallback is the right balance for offline reading.
 *
 *   - API requests (/api/*): network-only. We don't cache reads
 *     because data changes; we don't cache writes because we'd risk
 *     replaying mutations. The dashboard live SSE stream stays open
 *     when the network's up; offline, callers get a clean fail.
 *
 *   - Push notifications: handled by the `push` event listener at the
 *     bottom. Payloads come from the Curf push dispatcher (round 12).
 *
 * Versioning: bump CACHE_VERSION on any sw.js change so the activate
 * step purges old caches. Browsers register the new sw on next reload
 * after a 24-hour update check; for faster propagation in dev,
 * Application → Service Workers → Update on reload.
 */
const CACHE_VERSION = "v1";
const STATIC_CACHE = `curf-static-${CACHE_VERSION}`;
const PAGES_CACHE  = `curf-pages-${CACHE_VERSION}`;
const OFFLINE_URL  = "/offline";

self.addEventListener("install", (event) => {
  // Pre-cache the offline fallback page so we have something to show
  // even on first install before any HTML lands in the pages cache.
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll([
      "/icon.svg",
      "/apple-icon.svg",
      "/manifest.webmanifest",
    ]).catch(() => null)),
  );
  // Skip waiting so the new SW activates immediately on install — the
  // 24h staleness rule is for production hygiene, not for shipping.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Purge old caches from previous CACHE_VERSIONs.
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith("curf-") && !n.endsWith(CACHE_VERSION))
        .map((n) => caches.delete(n)),
    );
    // Claim open clients so the active SW handles their next fetches.
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never intercept POST/PUT/DELETE
  const url = new URL(req.url);

  // Don't intercept cross-origin requests — let the browser handle them.
  if (url.origin !== self.location.origin) return;

  // API routes: network-only. The site is useless offline as far as
  // live data goes; the SW's job is to keep navigation chrome alive,
  // not to fake API responses.
  if (url.pathname.startsWith("/api/")) return;

  // SSE event stream — never intercept.
  if (url.pathname === "/api/realtime/events") return;

  // Static assets: cache-first.
  if (
    url.pathname.startsWith("/_next/static/") ||
    /\.(?:svg|png|jpg|jpeg|webp|woff2?|ttf|otf|ico)$/.test(url.pathname) ||
    url.pathname === "/manifest.webmanifest"
  ) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // Navigations (HTML routes): network-first with cache fallback.
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    event.respondWith(networkFirst(req));
    return;
  }
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) {
    // Stale-while-revalidate: refresh in the background, serve the
    // cached copy immediately. We don't await — next visitor gets the
    // refreshed response.
    fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone()).catch(() => null);
    }).catch(() => null);
    return hit;
  }
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone()).catch(() => null);
    return res;
  } catch {
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

async function networkFirst(req) {
  const cache = await caches.open(PAGES_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone()).catch(() => null);
    return res;
  } catch (e) {
    // Network down. Try the cache for this exact URL first; if that
    // misses, fall back to the cached offline shell.
    const hit = await cache.match(req);
    if (hit) return hit;
    const offline = await caches.match(OFFLINE_URL);
    if (offline) return offline;
    // Inline fallback so the app is never fully broken when offline.
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>Offline · Curf</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui;background:#0e0e0c;color:#fafaf9;margin:0;display:grid;place-items:center;min-height:100vh}main{max-width:32rem;text-align:center;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#a1a1aa;margin:0}a{color:#a78bfa}</style>
</head><body><main><h1>You're offline</h1>
<p>Reconnect and refresh — Curf needs the network for live data.</p></main></body></html>`,
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
}

// ---------------------------------------------------------------------------
// Push notifications. Payload shape (set by lib/push/dispatch.ts):
//   { title, body, url?, tag? }
// We surface a basic notification with an action URL the click handler
// opens. Tag deduplicates notifications when many fire in a short window.
// ---------------------------------------------------------------------------
self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch { payload = { title: "Curf", body: String(event.data.text()) }; }
  event.waitUntil(self.registration.showNotification(payload.title || "Curf", {
    body: payload.body || "",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: payload.tag || "curf-default",
    data: { url: payload.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil((async () => {
    // If a Curf tab is already open, focus it and navigate.
    const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of allClients) {
      if (new URL(client.url).origin === self.location.origin) {
        client.focus();
        client.navigate(url);
        return;
      }
    }
    // Otherwise open a new window.
    self.clients.openWindow(url);
  })());
});
