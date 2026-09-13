/**
 * Per-tenant Server-Sent-Events bus for live UI updates.
 *
 *   const handle = subscribe(tenantId, send);
 *   // ... later
 *   handle.close();
 *
 *   broadcastToTenant(tenantId, { kind: "lake.bust", dataSourceId });
 *
 * Why home-grown instead of Redis pub/sub: Curf is single-process in the
 * common deploy (1-2 Node containers behind a load balancer); the rare
 * customer running 10+ replicas can route the SSE endpoint through a
 * sticky session, or we add Redis later. For now the registry is in-
 * process and lives on globalThis to survive HMR.
 *
 * Event shapes:
 *   - { kind: "lake.bust"; dataSourceId; tableName?; ts }
 *       Lake mutation invalidated the named data source.
 *   - { kind: "watcher.fired"; watcherId; reportId; severity }
 *       A watcher detected an anomaly.
 *   - { kind: "activation.done"; activationId; status; rowsSent }
 *       An activation finished a run.
 *   - { kind: "ping"; ts }
 *       Keep-alive heartbeat (every 25s) so reverse proxies don't reap.
 */

export type RealtimeEvent =
  | { kind: "lake.bust"; dataSourceId: string; tableName?: string | null; ts: number }
  | { kind: "watcher.fired"; watcherId: string; reportId: string; severity: string; ts: number }
  | { kind: "activation.done"; activationId: string; status: string; rowsSent: number; ts: number }
  | { kind: "ping"; ts: number };

type Subscriber = {
  /** Send a serialised event to the client. Returns true if write succeeded. */
  send: (event: RealtimeEvent) => boolean;
};

const G = globalThis as any;
const REGISTRY: Map<string, Set<Subscriber>> =
  G.__curfRealtimeRegistry ?? (G.__curfRealtimeRegistry = new Map());

export function subscribe(tenantId: string, send: Subscriber["send"]): { close: () => void } {
  const sub: Subscriber = { send };
  let set = REGISTRY.get(tenantId);
  if (!set) {
    set = new Set();
    REGISTRY.set(tenantId, set);
  }
  set.add(sub);
  return {
    close: () => {
      const s = REGISTRY.get(tenantId);
      if (!s) return;
      s.delete(sub);
      if (s.size === 0) REGISTRY.delete(tenantId);
    },
  };
}

export function broadcastToTenant(tenantId: string, event: RealtimeEvent): void {
  const set = REGISTRY.get(tenantId);
  if (!set || set.size === 0) return;
  for (const sub of set) {
    try {
      const ok = sub.send(event);
      if (!ok) set.delete(sub);
    } catch {
      // Detached subscriber — purge silently.
      set.delete(sub);
    }
  }
}

export function subscriberCount(tenantId?: string): number {
  if (tenantId) return REGISTRY.get(tenantId)?.size ?? 0;
  let total = 0;
  for (const s of REGISTRY.values()) total += s.size;
  return total;
}
