/**
 * Fire-and-forget notices between replicas over Redis pub/sub — "drop what you remember about X".
 *
 * Each process keeps its own small caches (the query-result cache, a workspace's open/closed status, the realtime event bus's
 * subscribers). A change made in one process has to reach the others, or a replica serves stale answers until its TTL ends
 * (or, for a suspension, keeps a closed workspace's public links alive). `publishNotice` tells every other process;
 * `onNotice` says what to do when told. A process never hears its own notices: it applied the change locally already.
 *
 * Best effort by design: a lost notice costs one TTL of staleness, which is what every cache here already tolerates, so
 * nothing waits on delivery and nothing fails when Redis is down. Without Redis configured both functions do nothing and
 * the in-process behaviour is unchanged.
 */
import { duplicate, redis, redisWarn, sharedStateEnabled } from "./index";

type Handler = (payload: any) => void;

const ORIGIN = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const shared = globalThis as unknown as {
  __curfNoticeHandlers?: Map<string, Handler[]>;
  __curfNoticeSub?: Promise<import("ioredis").Redis>;
};

const channel = (topic: string) => `notice:${topic}`;

export function publishNotice(topic: string, payload: unknown): void {
  if (!sharedStateEnabled()) return;
  redis("cache")
    .then((r) => r.publish(channel(topic), JSON.stringify({ o: ORIGIN, p: payload })))
    .catch((e) => redisWarn("notice-publish", `[notice] could not publish ${topic}: ${e?.message ?? e}`));
}

export function onNotice(topic: string, handler: Handler): void {
  if (!sharedStateEnabled()) return;
  const handlers = (shared.__curfNoticeHandlers ??= new Map());
  const list = handlers.get(topic) ?? [];
  handlers.set(topic, list);
  if (list.includes(handler)) return; // a module loaded twice (HMR) registers once
  list.push(handler);

  const sub = (shared.__curfNoticeSub ??= duplicate("cache").then((c) => {
    c.on("message", (ch: string, raw: string) => {
      try {
        const m = JSON.parse(raw) as { o: string; p: unknown };
        if (m.o === ORIGIN) return;
        for (const h of handlers.get(ch.slice("notice:".length)) ?? []) h(m.p);
      } catch { /* a malformed notice is ignored */ }
    });
    return c;
  }));
  sub.then((c) => c.subscribe(channel(topic))).catch((e) => {
    shared.__curfNoticeSub = undefined;
    redisWarn("notice-sub", `[notice] could not subscribe to ${topic}, this replica won't hear about it: ${e?.message ?? e}`);
  });
}
