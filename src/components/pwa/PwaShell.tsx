"use client";
/**
 * PwaShell — registers the service worker, shows the install prompt
 * and offline indicator.
 *
 * Three jobs:
 *   1. Register /sw.js on mount. Browser auto-updates the SW via the
 *      24h check; in dev, devtools' "Update on reload" is your friend.
 *   2. Listen for `beforeinstallprompt`. Stash the deferred event so
 *      a button can call .prompt() on user gesture (Chrome's rule —
 *      the install dialog only fires inside a user-initiated handler).
 *   3. Watch navigator.onLine; render a slim banner at the top when
 *      offline so users know reads/writes will fail.
 *
 * The component is body-mounted from app/layout.tsx so it's available
 * on every route — including the marketing landing, where install
 * conversion is highest.
 */
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Download, WifiOff, X } from "lucide-react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const INSTALL_DISMISSED_KEY = "curf.pwa.install-dismissed";

export function PwaShell() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installDismissed, setInstallDismissed] = useState(false);
  const [online, setOnline] = useState(true);
  // A public app is the tenant's own branded surface — a "Install Curf"
  // card popping up over it reads as Curf hijacking someone else's
  // product moment. The offline banner stays: it's about the page the
  // visitor is on, not an upsell.
  const onPublicApp = usePathname()?.startsWith("/apps/") ?? false;

  // 1. Service worker registration. We do it lazily on idle so the
  // first paint isn't blocked by SW lifecycle.
  //
  // Production only. sw.js caches /_next/static/* cache-first (see
  // public/sw.js) — great for a shipped build whose asset hashes only
  // change on deploy, actively wrong in development: after any edit (or
  // a `rm -rf .next` restart, which changes every hash) a tab with the
  // worker installed keeps serving the previous build's chunks, which
  // shows up as 404s / MIME-type errors on `_next/static/*` or even a
  // stale cached error page, and needs the worker unregistered by hand
  // to clear. We used to register on :3100 anyway "to make the demo
  // work" — the demo doesn't need it; disabling here is what makes dev
  // reloads reliable. If a worker is already installed from before this
  // change, unregister it so an existing dev browser heals itself.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker.getRegistrations()
        .then((regs) => { for (const r of regs) r.unregister(); })
        .catch(() => { /* best-effort cleanup */ });
      return;
    }
    const onLoad = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch((e) => {
          console.warn("[pwa] sw register failed:", e);
        });
    };
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });
    return () => window.removeEventListener("load", onLoad);
  }, []);

  // 2. Install prompt handling.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (typeof localStorage !== "undefined" && localStorage.getItem(INSTALL_DISMISSED_KEY)) {
      setInstallDismissed(true);
    }
    function onBeforeInstall(ev: Event) {
      ev.preventDefault(); // stash, don't show the default mini-bar
      setInstallEvent(ev as BeforeInstallPromptEvent);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall as EventListener);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall as EventListener);
  }, []);

  // 3. Online/offline detection.
  useEffect(() => {
    if (typeof window === "undefined") return;
    setOnline(navigator.onLine);
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  async function handleInstall(): Promise<void> {
    if (!installEvent) return;
    await installEvent.prompt();
    const choice = await installEvent.userChoice.catch(() => ({ outcome: "dismissed" as const }));
    if (choice.outcome === "accepted") {
      setInstallEvent(null);
    } else {
      // User dismissed — stash so we don't pester them this session.
      try { localStorage.setItem(INSTALL_DISMISSED_KEY, "1"); } catch { /* ignore */ }
      setInstallDismissed(true);
    }
  }

  function dismissInstall(): void {
    try { localStorage.setItem(INSTALL_DISMISSED_KEY, "1"); } catch { /* ignore */ }
    setInstallDismissed(true);
    setInstallEvent(null);
  }

  return (
    <>
      {!online && (
        <div className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-2 bg-warning/95 px-4 py-1.5 text-xs font-medium text-warning shadow-md">
          <WifiOff className="h-3.5 w-3.5" />
          <span>You're offline — reads of cached pages still work, but data may be stale.</span>
        </div>
      )}

      {installEvent && !installDismissed && !onPublicApp && (
        <div className="fixed bottom-4 right-4 z-[60] flex max-w-sm items-start gap-3 rounded-lg border bg-card p-3 shadow-lg sm:bottom-6 sm:right-6">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Download className="h-5 w-5" />
          </span>
          <div className="flex-1">
            <p className="text-sm font-medium">Install Curf</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Add Curf to your home screen for one-tap access and faster loads.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <button
                className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground hover:opacity-90"
                onClick={handleInstall}
              >
                Install
              </button>
              <button
                className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
                onClick={dismissInstall}
              >
                Not now
              </button>
            </div>
          </div>
          <button
            className="rounded p-1 text-muted-foreground hover:bg-muted"
            onClick={dismissInstall}
            aria-label="Dismiss install prompt"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </>
  );
}
