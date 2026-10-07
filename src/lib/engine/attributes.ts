/**
 * What people hold for the engine's row rules, kept in Curf and sent to every engine the workspace uses.
 *
 * Curf is the source of truth: an admin edits attributes in Curf (UserAttribute), and this sends them to the
 * engine's entitlement table, keyed by the person's Curf user id (the `sub` of the token Curf signs for them).
 * Changes are written through at once, so there is no sync lag; a full reconcile and a drift report cover an
 * engine that was changed by hand, restored from a backup, or unreachable when a change was made.
 *
 * Every database read is scoped to the workspace, and a person must be a member of it to hold anything in it.
 */
import { prisma } from "@/lib/db";
import { decodeEngineConnection, resolveEngineTarget, type EngineTarget } from "@/lib/connections/engine";
import { engineCall, engineJson, engineStatusError } from "@/lib/engine/client";
import type { EngineViewer } from "@/lib/engine/identity";
import {
  driftBetween, groupByPair, inBatches, isValidAttributeName, normaliseValues, reconcileEntries,
  type Drift, type EntitlementEntry, type EntitlementRow,
} from "@/lib/engine/attributeModel";

export type EngineEndpoint = { dataSourceId: string; name: string; target: EngineTarget };
export type SyncResult = { dataSourceId: string; name: string; ok: boolean; entries: number; error?: string };

const PAGE_SIZE = 200;
const MAX_PAGES = 50; // 10,000 entitlements; beyond that a drift report says it could not read them all

/** The engines this workspace's data sources point at, once each (two connections to one engine are one engine). */
export async function engineEndpoints(tenantId: string): Promise<EngineEndpoint[]> {
  const rows = await prisma.dataSource.findMany({ where: { tenantId, kind: "engine" }, select: { id: true, name: true, connection: true }, orderBy: { createdAt: "asc" } });
  const seen = new Set<string>();
  const out: EngineEndpoint[] = [];
  for (const row of rows) {
    let target: EngineTarget;
    try {
      target = resolveEngineTarget(decodeEngineConnection(row.connection));
    } catch {
      continue; // a connection with no usable URL has no engine to send to
    }
    const key = `${target.baseUrl}\u0000${target.audience ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ dataSourceId: row.id, name: row.name, target });
  }
  return out;
}

export type MemberAttributes = { userId: string; email: string; name: string | null; role: string; attributes: Record<string, string[]> };

export async function listMemberAttributes(tenantId: string): Promise<{ members: MemberAttributes[]; names: string[] }> {
  const [memberships, held] = await Promise.all([
    prisma.membership.findMany({ where: { tenantId }, select: { role: true, user: { select: { id: true, email: true, name: true } } }, orderBy: { createdAt: "asc" } }),
    prisma.userAttribute.findMany({ where: { tenantId }, select: { userId: true, name: true, value: true }, orderBy: [{ name: "asc" }, { value: "asc" }] }),
  ]);
  const byUser = new Map<string, Record<string, string[]>>();
  const names = new Set<string>();
  for (const h of held) {
    names.add(h.name);
    const attrs = byUser.get(h.userId) ?? {};
    (attrs[h.name] ??= []).push(h.value);
    byUser.set(h.userId, attrs);
  }
  const members = memberships.map((m) => ({ userId: m.user.id, email: m.user.email, name: m.user.name, role: m.role, attributes: byUser.get(m.user.id) ?? {} }));
  return { members, names: [...names].sort() };
}

export class AttributeError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) {
    super(message);
  }
}

/** Replaces everything one member holds for one attribute. An empty list removes it. */
export async function replaceAttribute(tenantId: string, userId: string, name: unknown, rawValues: unknown): Promise<{ name: string; values: string[] }> {
  if (!isValidAttributeName(name)) throw new AttributeError("An attribute name starts with a letter and uses letters, digits and underscores (at most 64).");
  const normal = normaliseValues(rawValues);
  if (!normal.ok) throw new AttributeError(normal.error);
  const member = await prisma.membership.findUnique({ where: { userId_tenantId: { userId, tenantId } }, select: { id: true } });
  if (!member) throw new AttributeError("That person is not a member of this workspace.", 404);

  await prisma.$transaction([
    prisma.userAttribute.deleteMany({ where: { tenantId, userId, name } }),
    ...(normal.values.length ? [prisma.userAttribute.createMany({ data: normal.values.map((value) => ({ tenantId, userId, name, value })) })] : []),
  ]);
  return { name, values: normal.values };
}

async function putEntitlements(endpoint: EngineEndpoint, actor: EngineViewer, tenantId: string, entries: EntitlementEntry[]): Promise<void> {
  for (const batch of inBatches(entries)) {
    const res = await engineCall({ target: endpoint.target, viewer: actor, tenantId, method: "PUT", path: "/policies/entitlements", body: { entries: batch } });
    const problem = await engineStatusError(res, "entitlements");
    if (problem) throw new Error(problem);
  }
}

/** One result per engine; a failure is reported, not thrown, because the change is already saved in Curf. */
async function pushTo(endpoints: EngineEndpoint[], actor: EngineViewer, tenantId: string, entries: EntitlementEntry[]): Promise<SyncResult[]> {
  return Promise.all(endpoints.map(async (endpoint): Promise<SyncResult> => {
    const base = { dataSourceId: endpoint.dataSourceId, name: endpoint.name, entries: entries.length };
    if (entries.length === 0) return { ...base, ok: true };
    try {
      await putEntitlements(endpoint, actor, tenantId, entries);
      return { ...base, ok: true };
    } catch (e: any) {
      return { ...base, ok: false, error: e?.message ?? "The engine did not accept the change." };
    }
  }));
}

/** After a change: send Curf's current set for these (person, attribute) pairs to every engine of the workspace. */
export async function pushPairs(tenantId: string, actor: EngineViewer, pairs: Array<{ userId: string; name: string }>): Promise<SyncResult[]> {
  if (pairs.length === 0) return [];
  const rows = await prisma.userAttribute.findMany({
    where: { tenantId, OR: pairs.map((p) => ({ userId: p.userId, name: p.name })) },
    select: { userId: true, name: true, value: true },
  });
  const grouped = groupByPair(rows.map((r) => ({ subject: r.userId, attribute: r.name, value: r.value })));
  const entries: EntitlementEntry[] = pairs.map((p) => ({ subject: p.userId, attribute: p.name, values: grouped.get(`${p.userId}\u0000${p.name}`)?.values ?? [] }));
  return pushTo(await engineEndpoints(tenantId), actor, tenantId, entries);
}

async function curfRows(tenantId: string): Promise<EntitlementRow[]> {
  const held = await prisma.userAttribute.findMany({ where: { tenantId }, select: { userId: true, name: true, value: true } });
  return held.map((h) => ({ subject: h.userId, attribute: h.name, value: h.value }));
}

/** Everything the engine holds for this workspace, or why it could not be read (and how much was). */
export async function fetchEngineRows(endpoint: EngineEndpoint, actor: EngineViewer, tenantId: string): Promise<{ rows: EntitlementRow[]; complete: boolean }> {
  const rows: EntitlementRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await engineCall({ target: endpoint.target, viewer: actor, tenantId, path: `/policies/entitlements?page=${page}&size=${PAGE_SIZE}` });
    const problem = await engineStatusError(res, "entitlements");
    if (problem) throw new Error(problem);
    const body = await engineJson(res);
    const content: any[] = Array.isArray(body?.content) ? body.content : [];
    for (const c of content) {
      if (typeof c?.subject === "string" && typeof c?.attribute === "string" && typeof c?.value === "string") rows.push({ subject: c.subject, attribute: c.attribute, value: c.value });
    }
    if (content.length < PAGE_SIZE) return { rows, complete: true };
  }
  return { rows, complete: false };
}

export type DriftReport = {
  dataSourceId: string;
  name: string;
  ok: boolean;
  error?: string;
  /** False when the engine holds more than could be read; the comparison is then partial. */
  complete?: boolean;
  inSync?: boolean;
  missingOnEngine?: number;
  extraOnEngine?: number;
  /** A few examples of each, for the screen. Attribute values are not secret but are not needed in bulk. */
  examples?: { missingOnEngine: EntitlementRow[]; extraOnEngine: EntitlementRow[] };
};

const EXAMPLES = 20;

export async function driftReports(tenantId: string, actor: EngineViewer): Promise<DriftReport[]> {
  const [endpoints, mine] = await Promise.all([engineEndpoints(tenantId), curfRows(tenantId)]);
  return Promise.all(endpoints.map(async (endpoint): Promise<DriftReport> => {
    const base = { dataSourceId: endpoint.dataSourceId, name: endpoint.name };
    try {
      const theirs = await fetchEngineRows(endpoint, actor, tenantId);
      const drift: Drift = driftBetween(mine, theirs.rows);
      // A partial read can show what is missing on the engine only if it saw everything; say so rather than guess.
      return {
        ...base, ok: true, complete: theirs.complete, inSync: drift.inSync && theirs.complete,
        missingOnEngine: drift.missingOnEngine.length, extraOnEngine: drift.extraOnEngine.length,
        examples: { missingOnEngine: drift.missingOnEngine.slice(0, EXAMPLES), extraOnEngine: drift.extraOnEngine.slice(0, EXAMPLES) },
      };
    } catch (e: any) {
      return { ...base, ok: false, error: e?.message ?? "The engine could not be read." };
    }
  }));
}

/** Makes every engine of the workspace hold exactly what Curf holds. Only what differs is sent. */
export async function reconcileAll(tenantId: string, actor: EngineViewer): Promise<SyncResult[]> {
  const [endpoints, mine] = await Promise.all([engineEndpoints(tenantId), curfRows(tenantId)]);
  return Promise.all(endpoints.map(async (endpoint): Promise<SyncResult> => {
    const base = { dataSourceId: endpoint.dataSourceId, name: endpoint.name };
    try {
      const theirs = await fetchEngineRows(endpoint, actor, tenantId);
      if (!theirs.complete) return { ...base, ok: false, entries: 0, error: "The engine holds more entitlements than could be compared; nothing was changed." };
      const entries = reconcileEntries(mine, theirs.rows);
      if (entries.length) await putEntitlements(endpoint, actor, tenantId, entries);
      return { ...base, ok: true, entries: entries.length };
    } catch (e: any) {
      return { ...base, ok: false, entries: 0, error: e?.message ?? "The engine did not accept the change." };
    }
  }));
}
