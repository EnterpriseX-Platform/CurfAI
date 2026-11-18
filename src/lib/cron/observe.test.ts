import { describe, expect, it } from "vitest";
import { registry } from "@/lib/metrics";
import { countFired, countSweepErrors, observeCronRun } from "./observe";

async function value(name: string, labels: Record<string, string>): Promise<number | undefined> {
  const text = await registry.metrics();
  const want = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  const line = text.split("\n").find((l) => l.startsWith(name + "{") && want.every((w) => l.includes(w)));
  return line ? Number(line.split(" ").pop()) : undefined;
}

describe("cron observation", () => {
  it("counts an ok run and records when it last finished", async () => {
    const before = (await value("curf_cron_runs_total", { run: "schedule_scan", status: "ok" })) ?? 0;
    await observeCronRun("schedule_scan", async () => "x");
    expect(await value("curf_cron_runs_total", { run: "schedule_scan", status: "ok" })).toBe(before + 1);
    const at = await value("curf_cron_last_success_timestamp_seconds", { run: "schedule_scan" });
    expect(Math.abs(at! - Date.now() / 1000)).toBeLessThan(5);
  });

  it("counts a run that throws as an error, rethrows, and leaves the last-success time alone", async () => {
    const at = await value("curf_cron_last_success_timestamp_seconds", { run: "platform_ticks" });
    await expect(observeCronRun("platform_ticks", async () => { throw new Error("db down"); })).rejects.toThrow("db down");
    expect(await value("curf_cron_runs_total", { run: "platform_ticks", status: "error" })).toBe(1);
    expect(await value("curf_cron_last_success_timestamp_seconds", { run: "platform_ticks" })).toBe(at);
  });

  it("counts sweeps that answered with an error, and what was fired", async () => {
    countSweepErrors({ scimRetries: { error: "boom" }, sla: { ok: 1 }, embed: "skipped", sync: null });
    expect(await value("curf_cron_tick_errors_total", { tick: "scimRetries" })).toBe(1);
    expect(await value("curf_cron_tick_errors_total", { tick: "sla" })).toBeUndefined();
    countFired([{ id: "1", kind: "delivery", status: "ok" }, { id: "2", kind: "delivery", status: "failed" }]);
    expect(await value("curf_cron_fired_total", { kind: "delivery", status: "failed" })).toBe(1);
  });
});
