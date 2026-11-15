/**
 * How fresh a connection's data is, from the scheduled pulls that feed the lake from it (LakePull). A source with no pull is
 * queried live, so it has no age to show. Pure and client-safe: the Connections page passes it what GET /api/lake/pulls
 * returns, and words the state (`connFresh.<state>`) in the reader's language. Only failure and age are reported, not a
 * verdict on whether the cadence is "late": the pull's cron is the owner's, and a guess would be wrong as often as right.
 */
export type PullLite = {
  dataSourceId: string;
  enabled: boolean;
  lastRunAt: string | Date | null;
  lastStatus: string | null;
  lastError?: string | null;
};

export type SourceFreshness = {
  /** live: no pull, read at question time. failing: a pull's last run failed. paused: every pull is off.
   *  waiting: pulls are on but none has run yet. fresh: the newest run, in `lastRunAt`. */
  state: "live" | "failing" | "paused" | "waiting" | "fresh";
  lastRunAt: string | null;
  error?: string;
  pulls: number;
};

const time = (v: string | Date | null) => (v ? new Date(v).getTime() : 0);

export function sourceFreshness(dataSourceId: string, pulls: PullLite[]): SourceFreshness {
  const mine = pulls.filter((p) => p.dataSourceId === dataSourceId);
  if (mine.length === 0) return { state: "live", lastRunAt: null, pulls: 0 };
  const on = mine.filter((p) => p.enabled);
  const newest = [...mine].sort((a, b) => time(b.lastRunAt) - time(a.lastRunAt))[0]!;
  const lastRunAt = newest.lastRunAt ? new Date(newest.lastRunAt).toISOString() : null;
  const failing = on.filter((p) => p.lastStatus === "failed").sort((a, b) => time(b.lastRunAt) - time(a.lastRunAt))[0];
  if (failing) return { state: "failing", lastRunAt, error: failing.lastError ?? undefined, pulls: mine.length };
  if (on.length === 0) return { state: "paused", lastRunAt, pulls: mine.length };
  if (!lastRunAt) return { state: "waiting", lastRunAt: null, pulls: mine.length };
  return { state: "fresh", lastRunAt, pulls: mine.length };
}
