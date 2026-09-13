/**
 * Real-time viewer presence — in-process, per-process registry.
 *
 * Why in-memory (and not Redis / database-backed)? Presence is ephemeral by
 * definition — the absolute worst case of losing it is "the chip flickers
 * for a few seconds after a redeploy, until clients reconnect." Trading a
 * dependency for that resilience isn't worth it at our current scale. When
 * Curf goes multi-instance, swapping this module for a Redis pub/sub
 * implementation is a single-file change.
 *
 * Per-report-presence shape:
 *   reportId → Map<userKey, { user, lastSeenAt, subscribers }>
 *
 * Each SSE connection is a `subscriber`: a callback that the registry
 * fires whenever the per-report set changes. Heartbeats refresh `lastSeenAt`;
 * idle viewers (no heartbeat in 30s) are reaped on next read.
 */

export type PresenceUser = {
  /** Stable key — the userId for logged-in viewers, or a session token for anon. */
  key: string;
  /** Display name (defaults to email or "Anonymous"). */
  name: string;
  email?: string;
  /** Initials for avatar fallback. */
  initials: string;
  /** Stable hue for the avatar so two browsers see the same colour for "Alex". */
  hue: number;
};

type Entry = {
  user: PresenceUser;
  lastSeenAt: number;
};

type Subscriber = (snapshot: PresenceUser[]) => void;

// Stash on globalThis so HMR (Next dev) doesn't lose the in-memory state on
// every file save. Production builds get a single fresh instance.
const G = globalThis as any;
const REPORTS: Map<string, Map<string, Entry>> = G.__curfPresenceReports ?? (G.__curfPresenceReports = new Map());
const SUBS: Map<string, Set<Subscriber>> = G.__curfPresenceSubs ?? (G.__curfPresenceSubs = new Map());

/** Idle viewers older than this are considered gone. ~3x the heartbeat. */
const IDLE_MS = 30_000;

function reportFor(reportId: string): Map<string, Entry> {
  let m = REPORTS.get(reportId);
  if (!m) { m = new Map(); REPORTS.set(reportId, m); }
  return m;
}

function reapIdle(reportId: string): boolean {
  const m = reportFor(reportId);
  const now = Date.now();
  let changed = false;
  for (const [k, v] of m) {
    if (now - v.lastSeenAt > IDLE_MS) { m.delete(k); changed = true; }
  }
  return changed;
}

function snapshot(reportId: string): PresenceUser[] {
  reapIdle(reportId);
  const out: PresenceUser[] = [];
  for (const [, v] of reportFor(reportId)) out.push(v.user);
  // Stable sort by name so the chip order doesn't churn on re-renders.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function notify(reportId: string) {
  const subs = SUBS.get(reportId);
  if (!subs || subs.size === 0) return;
  const snap = snapshot(reportId);
  for (const cb of subs) {
    try { cb(snap); } catch { /* one bad subscriber shouldn't take the room down */ }
  }
}

export function heartbeat(reportId: string, user: PresenceUser): void {
  const m = reportFor(reportId);
  const existed = m.has(user.key);
  m.set(user.key, { user, lastSeenAt: Date.now() });
  // We always notify on the first hello so other viewers see the new chip
  // immediately. Subsequent heartbeats only notify if anyone aged out.
  if (!existed || reapIdle(reportId)) notify(reportId);
}

export function leave(reportId: string, key: string): void {
  const m = reportFor(reportId);
  if (m.delete(key)) notify(reportId);
}

export function listViewers(reportId: string): PresenceUser[] {
  return snapshot(reportId);
}

/**
 * Subscribe to presence changes for a report. Returns the unsubscribe
 * function — the SSE route closes the connection by calling it.
 */
export function subscribe(reportId: string, cb: Subscriber): () => void {
  let set = SUBS.get(reportId);
  if (!set) { set = new Set(); SUBS.set(reportId, set); }
  set.add(cb);
  // Fire once immediately so the new connection gets the current room state.
  try { cb(snapshot(reportId)); } catch { /* no-op */ }
  return () => {
    set!.delete(cb);
    if (set!.size === 0) SUBS.delete(reportId);
  };
}

/** Build a stable hue from a key so each user gets a consistent color. */
export function hashHue(seed: string): number {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h) % 360;
}

/** Initials from a display name or email. Two-letter cap. */
export function deriveInitials(name?: string | null, email?: string | null): string {
  const src = (name && name.trim()) || (email ? email.split("@")[0] : "?");
  const parts = src.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
