/**
 * Every export capture used to launch its own Chromium. Four concurrent xlsx
 * exports of a small report got the 1Gi production pod OOMKilled
 * (2026-09-23). These pin down the limiter that replaced that: a bounded
 * number of pages at once in one shared browser, a bounded queue behind
 * them, and a clear BrowserBusyError instead of another browser once
 * that's full.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const realSetImmediate = setImmediate;
/** Let every pending promise chain run (setImmediate fires after microtasks). */
async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((r) => realSetImmediate(r));
}

const h = vi.hoisted(() => {
  type FakeContext = { newPage: any; close: any; cookies: Map<string, string> };
  function fakeBrowser() {
    const onDisconnect: Array<() => void> = [];
    const contexts: FakeContext[] = [];
    const b = {
      connected: true,
      contexts,
      createBrowserContext: vi.fn(async () => {
        const ctx: FakeContext = {
          cookies: new Map(),
          // A page's cookies live in its context, as in Chromium.
          newPage: vi.fn(async () => ({ setCookie: async (c: any) => { ctx.cookies.set(c.name, c.value); }, ctx })),
          close: vi.fn(async () => undefined),
        };
        contexts.push(ctx);
        return ctx;
      }),
      once: vi.fn((ev: string, fn: () => void) => { if (ev === "disconnected") onDisconnect.push(fn); }),
      close: vi.fn(async () => { b.connected = false; }),
      /** The browser process died (e.g. the kernel OOM-killed it). */
      crash() { b.connected = false; onDisconnect.forEach((fn) => fn()); },
    };
    return b;
  }
  return { fakeBrowser, launched: [] as ReturnType<typeof fakeBrowser>[], launch: vi.fn(), queueDepth: vi.fn() };
});
vi.mock("puppeteer", () => ({ default: { launch: h.launch } }));
vi.mock("@/lib/metrics", () => ({ reportQueueDepth: { set: h.queueDepth } }));

let mod: typeof import("./headlessBrowser");

beforeEach(async () => {
  vi.useFakeTimers();
  // Fresh module state for every test. It lives on globalThis (see the module).
  delete (globalThis as any).__curfHeadlessBrowser;
  vi.resetModules();
  h.launched.length = 0;
  h.queueDepth.mockReset();
  h.launch.mockReset().mockImplementation(async () => {
    const b = h.fakeBrowser();
    h.launched.push(b);
    return b;
  });
  mod = await import("./headlessBrowser");
});
afterEach(() => { vi.useRealTimers(); });

/** A capture that keeps its page until finish() (or fail()) is called. */
function hold(kind: "pdf" | "xlsx" = "xlsx") {
  let finish!: () => void, fail!: (e: Error) => void;
  const gate = new Promise<void>((res, rej) => { finish = res; fail = rej; });
  const job = { started: false, page: null as any, finish, fail, done: null as unknown as Promise<unknown> };
  job.done = mod.withBrowserPage(kind, async (page) => { job.started = true; job.page = page; await gate; return "ok"; });
  // Never an unhandled rejection. Tests that expect one assert on job.done directly.
  job.done.catch(() => {});
  return job;
}

describe("headless browser limiter", () => {
  it("never runs more than MAX_CONCURRENT_PAGES captures at once; the rest start in arrival order", async () => {
    const n = mod.MAX_CONCURRENT_PAGES;
    const jobs = Array.from({ length: n + 3 }, () => hold());
    await flush();
    expect(jobs.filter((j) => j.started)).toHaveLength(n);
    expect(jobs.slice(n).every((j) => !j.started)).toBe(true);

    // Finishing the first one lets exactly the next in line start.
    jobs[0].finish();
    await flush();
    expect(jobs.filter((j) => j.started)).toHaveLength(n + 1);
    expect(jobs[n].started).toBe(true);
    expect(jobs[n + 1].started).toBe(false);

    for (const j of jobs) j.finish();
    await flush();
    await expect(Promise.all(jobs.map((j) => j.done))).resolves.toEqual(jobs.map(() => "ok"));
    expect(jobs.every((j) => j.started)).toBe(true);
  });

  it("shares one browser across captures, giving each its own context (cookie jar), closed afterwards", async () => {
    const a = hold();
    const b = hold("pdf");
    await flush();
    expect(h.launch).toHaveBeenCalledTimes(1); // both arrived before the launch finished: still one browser
    const browser = h.launched[0];
    expect(browser.createBrowserContext).toHaveBeenCalledTimes(2);

    // One user's forwarded session cookie is invisible to the other capture.
    await a.page.setCookie({ name: "next-auth.session-token", value: "user-a" });
    await b.page.setCookie({ name: "next-auth.session-token", value: "user-b" });
    expect(a.page.ctx).not.toBe(b.page.ctx);
    expect(a.page.ctx.cookies.get("next-auth.session-token")).toBe("user-a");
    expect(b.page.ctx.cookies.get("next-auth.session-token")).toBe("user-b");

    a.finish(); b.finish();
    await Promise.all([a.done, b.done]);
    expect(browser.contexts.every((c) => c.close.mock.calls.length === 1)).toBe(true);
    expect(browser.close).not.toHaveBeenCalled(); // kept for the next capture…

    const c = hold();
    await flush();
    c.finish();
    await c.done;
    expect(h.launch).toHaveBeenCalledTimes(1); // …which reuses it
  });

  it("turns a caller away at once when the queue is full, without launching anything", async () => {
    const running = Array.from({ length: mod.MAX_CONCURRENT_PAGES }, () => hold());
    const queued = Array.from({ length: mod.MAX_QUEUED }, () => hold());
    await flush();

    const extra = hold();
    await expect(extra.done).rejects.toMatchObject({ name: "BrowserBusyError" });
    expect(extra.started).toBe(false);
    expect(h.launch).toHaveBeenCalledTimes(1);
    expect(h.queueDepth).toHaveBeenLastCalledWith({ kind: "xlsx" }, mod.MAX_QUEUED);

    [...running, ...queued].forEach((j) => j.finish());
    await flush();
    await Promise.all([...running, ...queued].map((j) => j.done));
    expect(h.queueDepth).toHaveBeenLastCalledWith({ kind: "xlsx" }, 0);
  });

  it("gives up after MAX_WAIT_MS with BrowserBusyError, and the queue keeps moving", async () => {
    const running = Array.from({ length: mod.MAX_CONCURRENT_PAGES }, () => hold());
    const waiting = hold();
    const behind = hold();
    await flush();

    await vi.advanceTimersByTimeAsync(mod.MAX_WAIT_MS);
    await expect(waiting.done).rejects.toMatchObject({ name: "BrowserBusyError" });
    await expect(behind.done).rejects.toMatchObject({ name: "BrowserBusyError" });

    // The timed-out callers left the queue. A slot that frees up now goes to
    // the next caller, not to a waiter that already gave up.
    running[0].finish();
    await flush();
    const next = hold();
    await flush();
    expect(next.started).toBe(true);
    expect(waiting.started).toBe(false);
    [running[1], next].forEach((j) => j.finish());
    await Promise.all([running[0].done, running[1].done, next.done]);
  });

  it("frees the slot and closes the context when the capture throws", async () => {
    const failing = hold();
    const others = Array.from({ length: mod.MAX_CONCURRENT_PAGES }, () => hold());
    await flush();
    expect(others.filter((j) => j.started)).toHaveLength(mod.MAX_CONCURRENT_PAGES - 1);

    failing.fail(new Error("Navigation timeout of 60000 ms exceeded"));
    await expect(failing.done).rejects.toThrow("Navigation timeout");
    await flush();
    expect(failing.page.ctx.close).toHaveBeenCalledTimes(1);
    expect(others.every((j) => j.started)).toBe(true);
    others.forEach((j) => j.finish());
    await Promise.all(others.map((j) => j.done));
  });

  it("frees the slot when the browser can't launch, and tries again on the next capture", async () => {
    h.launch.mockRejectedValueOnce(new Error("Failed to launch the browser process"));
    await expect(mod.withBrowserPage("pdf", async () => "never")).rejects.toThrow("Failed to launch");

    await expect(mod.withBrowserPage("pdf", async () => "ok")).resolves.toBe("ok");
    expect(h.launch).toHaveBeenCalledTimes(2);
  });

  it("launches a new browser after the shared one dies", async () => {
    await mod.withBrowserPage("xlsx", async () => "first");
    h.launched[0].crash();

    await expect(mod.withBrowserPage("xlsx", async () => "second")).resolves.toBe("second");
    expect(h.launch).toHaveBeenCalledTimes(2);
  });

  it("closes the browser once it has been idle for IDLE_CLOSE_MS, but never under a running capture", async () => {
    const long = hold();
    await flush();
    await mod.withBrowserPage("pdf", async () => "short"); // finishes while `long` still runs
    await vi.advanceTimersByTimeAsync(mod.IDLE_CLOSE_MS * 2);
    expect(h.launched[0].close).not.toHaveBeenCalled();

    long.finish();
    await long.done;
    await vi.advanceTimersByTimeAsync(mod.IDLE_CLOSE_MS - 1);
    expect(h.launched[0].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.launched[0].close).toHaveBeenCalledTimes(1);

    // Work after the idle close gets a fresh browser.
    await mod.withBrowserPage("pdf", async () => "later");
    expect(h.launch).toHaveBeenCalledTimes(2);
  });

  it("browserBusyResponse is a 503 with Retry-After for BrowserBusyError, null for anything else", async () => {
    const res = mod.browserBusyResponse(new mod.BrowserBusyError());
    expect(res?.status).toBe(503);
    expect(Number(res?.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await res!.json()).error).toMatch(/try again/i);
    expect(mod.browserBusyResponse(new Error("Navigation timeout"))).toBeNull();
    expect(mod.browserBusyResponse("nope")).toBeNull();
  });
});
