/**
 * The Sidebar's badge counts on the client (lib/navCounts.ts): one request
 * serves every Sidebar mount for a while, and a burst of refreshNavCounts()
 * calls makes one request that skips the route's own cache.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let calls: string[] = [];
let answers: Array<(v: unknown) => void> = [];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  calls = [];
  answers = [];
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    calls.push(url);
    return new Promise((resolve) => answers.push(resolve));
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const reply = (i: number, body: unknown) => answers[i]!({ ok: true, json: async () => body });
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("navCounts", () => {
  it("shares one request between mounts, and reuses the answer for 30 seconds", async () => {
    const { loadNavCounts, peekNavCounts } = await import("./navCounts");
    const a = loadNavCounts("u1:t1:admin");
    const b = loadNavCounts("u1:t1:admin");
    expect(calls).toEqual(["/api/nav/counts"]);
    reply(0, { reports: 3 });
    expect(await a).toEqual({ reports: 3 });
    expect(await b).toEqual({ reports: 3 });
    expect(peekNavCounts("u1:t1:admin")).toEqual({ reports: 3 });

    await vi.advanceTimersByTimeAsync(29_000);
    expect(await loadNavCounts("u1:t1:admin")).toEqual({ reports: 3 });
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_000);
    void loadNavCounts("u1:t1:admin");
    expect(calls).toHaveLength(2);
  });

  it("keeps each workspace's counts apart", async () => {
    const { loadNavCounts, peekNavCounts } = await import("./navCounts");
    const a = loadNavCounts("u1:t1:admin");
    reply(0, { reports: 3 });
    await a;
    void loadNavCounts("u1:t2:viewer");
    expect(calls).toHaveLength(2);
    expect(peekNavCounts("u1:t2:viewer")).toBeUndefined();
  });

  it("turns a burst of refreshes into one event and one fresh request", async () => {
    const { loadNavCounts, refreshNavCounts, onNavCountsRefresh } = await import("./navCounts");
    const first = loadNavCounts("k");
    reply(0, { dashboards: 1 });
    await first;

    const heard = vi.fn(() => void loadNavCounts("k"));
    onNavCountsRefresh(heard);
    refreshNavCounts();
    refreshNavCounts();
    refreshNavCounts();
    await settle();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["/api/nav/counts", "/api/nav/counts?fresh=1"]);
  });

  it("drops an answer a refresh overtook, and keeps what was shown when a request fails", async () => {
    const { loadNavCounts, refreshNavCounts, peekNavCounts } = await import("./navCounts");
    const old = loadNavCounts("k");
    refreshNavCounts();                 // e.g. a dashboard was deleted meanwhile
    const fresh = loadNavCounts("k");
    reply(1, { dashboards: 4 });
    expect(await fresh).toEqual({ dashboards: 4 });
    reply(0, { dashboards: 5 });        // the older answer lands last
    expect(await old).toEqual({ dashboards: 4 });
    expect(peekNavCounts("k")).toEqual({ dashboards: 4 });

    refreshNavCounts();
    const failed = loadNavCounts("k");
    answers[2]!({ ok: false, json: async () => ({}) });
    expect(await failed).toEqual({ dashboards: 4 });
  });
});
