import { describe, it, expect } from "vitest";
import { sourceFreshness, type PullLite } from "./freshness";

const pull = (over: Partial<PullLite> = {}): PullLite => ({ dataSourceId: "s1", enabled: true, lastRunAt: "2026-11-02T08:00:00.000Z", lastStatus: "ok", ...over });

describe("sourceFreshness", () => {
  it("is live when nothing pulls from the source (other sources' pulls do not count)", () => {
    expect(sourceFreshness("s1", [])).toEqual({ state: "live", lastRunAt: null, pulls: 0 });
    expect(sourceFreshness("s1", [pull({ dataSourceId: "s2" })]).state).toBe("live");
  });
  it("is fresh at the newest run across its pulls", () => {
    const r = sourceFreshness("s1", [pull({ lastRunAt: "2026-11-01T08:00:00.000Z" }), pull({ lastRunAt: "2026-11-02T09:30:00.000Z" })]);
    expect(r).toEqual({ state: "fresh", lastRunAt: "2026-11-02T09:30:00.000Z", pulls: 2 });
  });
  it("is failing when an enabled pull's last run failed, naming the newest failure", () => {
    const r = sourceFreshness("s1", [
      pull({ lastStatus: "failed", lastError: "old", lastRunAt: "2026-11-01T00:00:00.000Z" }),
      pull({ lastStatus: "failed", lastError: "401 from the API", lastRunAt: "2026-11-02T00:00:00.000Z" }),
      pull(),
    ]);
    expect(r).toMatchObject({ state: "failing", error: "401 from the API" });
  });
  it("ignores a failure on a pull that is switched off, and says paused when all are off", () => {
    expect(sourceFreshness("s1", [pull({ enabled: false, lastStatus: "failed" }), pull()]).state).toBe("fresh");
    expect(sourceFreshness("s1", [pull({ enabled: false })]).state).toBe("paused");
  });
  it("is waiting when pulls are on but none has run", () => {
    expect(sourceFreshness("s1", [pull({ lastRunAt: null, lastStatus: null })])).toEqual({ state: "waiting", lastRunAt: null, pulls: 1 });
  });
});
