/**
 * What the People panel shows, worked out from the server's lists. Pure and client-safe.
 */

export type Member = { userId: string; email: string; name: string | null; role: string; attributes: Record<string, string[]> };
export type SyncResult = { dataSourceId: string; name: string; ok: boolean; entries?: number; error?: string };

export type MemberSortKey = "name" | "email" | "role";
export type SortDirection = "asc" | "desc";

export function memberLabel(m: Pick<Member, "name" | "email">): string {
  return m.name?.trim() || m.email;
}

/** Members whose name, email, role or any held attribute name or value contains the search (case-insensitive). */
export function filterMembers(members: Member[], search: string): Member[] {
  const q = search.trim().toLowerCase();
  if (!q) return members;
  return members.filter((m) => {
    if ((m.name ?? "").toLowerCase().includes(q) || m.email.toLowerCase().includes(q) || m.role.toLowerCase().includes(q)) return true;
    return Object.entries(m.attributes).some(([name, values]) => name.toLowerCase().includes(q) || values.some((v) => v.toLowerCase().includes(q)));
  });
}

export function sortMembers(members: Member[], key: MemberSortKey, direction: SortDirection): Member[] {
  const value = (m: Member) => (key === "name" ? memberLabel(m) : key === "email" ? m.email : m.role).toLowerCase();
  const sign = direction === "asc" ? 1 : -1;
  return [...members].sort((a, b) => sign * value(a).localeCompare(value(b)) || a.email.localeCompare(b.email));
}

/** The attribute names a person holds with at least one value, sorted. */
export function heldAttributes(m: Pick<Member, "attributes">): string[] {
  return Object.keys(m.attributes).filter((n) => m.attributes[n]?.length).sort();
}

/** Every attribute name in use plus the workspace's list, sorted, each once. */
export function allAttributeNames(names: string[], members: Member[]): string[] {
  return [...new Set([...names, ...members.flatMap(heldAttributes)])].sort((a, b) => a.localeCompare(b));
}

/** Engines whose update failed: the change is saved in Curf, the engine does not have it yet. */
export function failedSyncs(sync: SyncResult[] | undefined): SyncResult[] {
  return (sync ?? []).filter((s) => !s.ok);
}

export type DriftRow = { subject: string; attribute: string; value: string };
export type DriftEngine = {
  dataSourceId: string;
  name: string;
  ok: boolean;
  error?: string;
  complete?: boolean;
  inSync?: boolean;
  missingOnEngine?: number;
  extraOnEngine?: number;
  examples?: { missingOnEngine: DriftRow[]; extraOnEngine: DriftRow[] };
};

export type DriftExample = { who: string; attribute: string; value: string };

/** An example with the person as their email (or the id when they are not a member any more). */
export function driftExamples(rows: DriftRow[] | undefined, members: Member[]): DriftExample[] {
  const byId = new Map(members.map((m) => [m.userId, m.email]));
  return (rows ?? []).map((r) => ({ who: byId.get(r.subject) ?? r.subject, attribute: r.attribute, value: r.value }));
}

export type DriftState = "unreachable" | "inSync" | "differs" | "incomplete";

/**
 * One engine's verdict: unreachable beats everything; known differences beat "incomplete" (the engine holds more
 * than could be compared, so "in sync" cannot be claimed, but the known differences are worth fixing first).
 */
export function driftState(e: DriftEngine): DriftState {
  if (!e.ok) return "unreachable";
  if ((e.missingOnEngine ?? 0) > 0 || (e.extraOnEngine ?? 0) > 0) return "differs";
  if (e.complete === false) return "incomplete";
  return e.inSync === false ? "differs" : "inSync";
}

/** Can "Sync now" help? Only when some engine was reached and is not known to be identical. */
export function syncWouldHelp(engines: DriftEngine[]): boolean {
  return engines.some((e) => {
    const s = driftState(e);
    return s === "differs" || s === "incomplete";
  });
}
