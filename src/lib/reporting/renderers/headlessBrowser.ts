/**
 * The one headless Chromium that every server-side capture shares: the
 * report PDF export, the xlsx renderer's chart screenshots, and the
 * roadmap-status PDF.
 *
 * Each of those used to call puppeteer.launch() for every request. One
 * Chromium costs a few hundred MB, and the app runs in a single 1Gi
 * container. On 2026-09-23 four concurrent xlsx exports of a small report
 * got the production pod OOMKilled (all four answered 502). Two concurrent
 * exports earlier that day had produced a file with its charts silently
 * missing. The same image under the same 1Gi limit, locally: 4 concurrent
 * exports pinned the container at its limit for ~95s, and 6 pinned it for
 * ~7 minutes. Every one of those requests answered 200, and every file but
 * one had no charts in it. So here:
 *
 *   - At most MAX_CONCURRENT_PAGES captures run at once, process-wide.
 *     Everything else waits its turn in arrival order: up to MAX_QUEUED
 *     callers, for up to MAX_WAIT_MS each. Past either limit a caller gets
 *     BrowserBusyError straight away instead of starting another browser.
 *     Routes turn that error into a 503 with Retry-After
 *     (browserBusyResponse).
 *   - One browser is launched on first use and then shared. It's relaunched
 *     if it dies, and closed after IDLE_CLOSE_MS without work so an idle
 *     pod doesn't carry it.
 *   - Every capture gets its own browser context, which has its own cookie
 *     jar. A session cookie forwarded for one user's export can't be seen
 *     by another user's export running at the same time in the same
 *     browser.
 *
 * The limit is per process: with more than one replica, each pod has its own.
 */
import puppeteer, { type Browser, type Page } from "puppeteer";
import { NextResponse } from "next/server";
import { reportQueueDepth } from "@/lib/metrics";

/** Pages rendering at once. Measured with the production image under the
 *  production pod's limits (1Gi, 1 CPU) on a small chart report's xlsx
 *  export. With two pages at a time, the container's anonymous memory
 *  peaked at about 500 MiB whether 4, 6 or 12 exports arrived at once. With
 *  a browser per export (four at once, the old behaviour) it peaked at
 *  835 MiB, 51 Chromium processes, and the container sat pinned at its limit. */
export const MAX_CONCURRENT_PAGES = 2;
/** Callers allowed to wait for a page. Past this they're turned away at
 *  once. Nobody gets parked only to be told to retry. */
export const MAX_QUEUED = 8;
/** Longest a caller waits for a page before giving up with BrowserBusyError.
 *  Sized so a full queue drains in time. On the production pod's single CPU
 *  one capture takes 25-30s, so eight callers, two at a time, need about
 *  two minutes. With 60s, callers past the fourth in line waited the full
 *  minute and were then told to retry. Well under the ingress's 300s read
 *  timeout. */
export const MAX_WAIT_MS = 120_000;
/** Close the shared browser after this long with nothing to do. */
export const IDLE_CLOSE_MS = 30_000;
const RETRY_AFTER_SEC = 30;

export type BrowserJobKind = "pdf" | "xlsx";

type Waiter = { kind: BrowserJobKind; grant: () => void };
type State = {
  active: number;
  queue: Waiter[];
  browser: Browser | null;
  launching: Promise<Browser> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

// On globalThis, not a module-level const, for the same reason as the lake
// file locks (lib/lake/engine/duckdb.ts): Next's dev HMR re-evaluates
// modules, and a second copy of this module would bring its own limit and
// its own browser. The limit would stop being process-wide, and a browser
// nothing references could no longer be closed.
const s: State = ((globalThis as any).__curfHeadlessBrowser ??= {
  active: 0, queue: [], browser: null, launching: null, idleTimer: null,
});

export class BrowserBusyError extends Error {
  readonly retryAfterSec = RETRY_AFTER_SEC;
  constructor() {
    super("Too many exports are rendering right now. Try again in a minute.");
    this.name = "BrowserBusyError";
  }
}

/** A route's 503 for a saturated renderer, or null for any other error.
 *  Matched by name rather than instanceof, because the route and the
 *  renderer can end up with different copies of this module. */
export function browserBusyResponse(e: unknown): NextResponse | null {
  if (!(e instanceof Error) || e.name !== "BrowserBusyError") return null;
  return NextResponse.json(
    { error: e.message },
    { status: 503, headers: { "Retry-After": String(RETRY_AFTER_SEC) } },
  );
}

/**
 * Run `fn` with a fresh page in its own browser context. Waits for a free
 * slot first, and throws BrowserBusyError if none frees up in time. The
 * context is closed afterwards whatever `fn` does.
 */
export async function withBrowserPage<T>(kind: BrowserJobKind, fn: (page: Page) => Promise<T>): Promise<T> {
  const release = await acquireSlot(kind);
  try {
    const browser = await getBrowser();
    const context = await browser.createBrowserContext();
    try {
      return await fn(await context.newPage());
    } finally {
      // If the browser has already died there's nothing left to free.
      await context.close().catch(() => {});
    }
  } finally {
    release();
  }
}

function acquireSlot(kind: BrowserJobKind): Promise<() => void> {
  if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
  if (s.active < MAX_CONCURRENT_PAGES) {
    s.active++;
    return Promise.resolve(releaseOnce());
  }
  if (s.queue.length >= MAX_QUEUED) return Promise.reject(new BrowserBusyError());
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      kind,
      grant: () => { clearTimeout(timer); resolve(releaseOnce()); },
    };
    const timer = setTimeout(() => {
      const i = s.queue.indexOf(waiter);
      if (i >= 0) s.queue.splice(i, 1);
      reportQueue(kind);
      reject(new BrowserBusyError());
    }, MAX_WAIT_MS);
    s.queue.push(waiter);
    reportQueue(kind);
  });
}

function releaseOnce(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Hand the slot straight to the next caller in line. If it went back to
    // the pool instead, a new arrival could take it ahead of callers who
    // were already waiting.
    const next = s.queue.shift();
    if (next) {
      reportQueue(next.kind);
      next.grant();
      return;
    }
    s.active--;
    if (s.active === 0) scheduleIdleClose();
  };
}

function reportQueue(kind: BrowserJobKind) {
  reportQueueDepth.set?.({ kind }, s.queue.filter((w) => w.kind === kind).length);
}

async function getBrowser(): Promise<Browser> {
  if (s.browser?.connected) return s.browser;
  // Callers that arrive while a launch is in progress wait on that launch
  // rather than starting a second browser.
  s.launching ??= puppeteer
    .launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] })
    .then((b) => {
      s.browser = b;
      // A crashed or killed browser is dropped, and the next capture launches a new one.
      b.once("disconnected", () => { if (s.browser === b) s.browser = null; });
      return b;
    })
    .finally(() => { s.launching = null; });
  return s.launching;
}

function scheduleIdleClose() {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    s.idleTimer = null;
    if (s.active > 0 || !s.browser) return;
    const b = s.browser;
    // Clear the reference before closing. A capture that starts during the
    // close then launches a new browser instead of reusing this one.
    s.browser = null;
    void b.close().catch(() => {});
  }, IDLE_CLOSE_MS);
  // Never keep the process alive just to close an idle browser.
  s.idleTimer.unref?.();
}
