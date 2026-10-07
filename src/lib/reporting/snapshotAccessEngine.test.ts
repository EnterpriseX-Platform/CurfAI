/**
 * Engine rows are answered per person, so a saved run is never replayed with them — even if one was stored by a
 * route that predates this rule. Defence in depth behind lib/reporting/runSnapshot.ts, which stops them being stored.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { dataSource: { findUnique: vi.fn(), findFirst: vi.fn() }, metric: { findFirst: vi.fn() } },
}));
vi.mock("@/lib/reporting/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reporting/runner")>()),
  lakeGate: vi.fn(async () => ({ ok: true, redacts: false, redact: (rows: any) => rows })),
}));

import { prisma } from "@/lib/db";
import { ENGINE_NOT_STORED_NOTE } from "@/lib/reporting/runSnapshot";
import { savedRunReader } from "./snapshotAccess";

const db = prisma as any;
const SOURCES: Record<string, any> = {
  Engine: { id: "ds_e", kind: "engine", ownerUserId: null, visibleToRolesJson: "[]" },
  Warehouse: { id: "ds_w", kind: "postgres", ownerUserId: null, visibleToRolesJson: "[]" },
};
const reader = { id: "u_low", isAdmin: false, roles: [] as string[] };
const report = (ids: string[]): any => ({ version: 1, name: "R", parameters: [], dataSources: ids.map((id) => ({ id, name: id, dataSourceId: "ds" })), pages: [{ id: "p", size: "A4", orientation: "portrait", blocks: [] }] });
const prov = (queryId: string, dataSourceName: string, kind: string, extra: object = {}): any => ({
  queryId, queryName: queryId, queryHash: "h", runAt: "2026-09-01T00:00:00Z", durationMs: 1, rowCount: 1, dataHash: "d", dataSourceName, dataSourceKind: kind, ...extra,
});
const ADMINS_ROWS = [{ id: 1, email: "unmasked-for-admin@x.test" }];

beforeEach(() => {
  vi.clearAllMocks();
  db.dataSource.findUnique.mockImplementation(async ({ where }: any) => SOURCES[where.tenantId_name.name] ?? null);
});

describe("a saved run read by someone else", () => {
  it("never shows engine rows an admin's load left behind, and says why", async () => {
    const read = savedRunReader("t1", report(["e"]), reader);
    const out = await read({ dataset: { e: ADMINS_ROWS }, provenance: { e: prov("e", "Engine", "engine") }, params: {} });
    expect(out.dataset.e).toEqual([]);
    expect(out.provenance.e.accessDeniedNote).toBe(ENGINE_NOT_STORED_NOTE);
    expect(out.provenance.e.rowCount).toBe(0);
    expect(JSON.stringify(out)).not.toContain("unmasked-for-admin");
  });

  it("nor rows of a query that joined an engine query, whose own source looks harmless", async () => {
    const read = savedRunReader("t1", report(["j"]), reader);
    const out = await read({
      dataset: { j: ADMINS_ROWS },
      provenance: { j: prov("j", "Warehouse", "postgres", { attachedSources: [{ name: "Engine", kind: "engine", alias: "e" }] }) },
      params: {},
    });
    expect(out.dataset.j).toEqual([]);
    expect(out.provenance.j.accessDeniedNote).toBe(ENGINE_NOT_STORED_NOTE);
  });

  it("still shows other sources' rows, unchanged", async () => {
    const read = savedRunReader("t1", report(["w", "e"]), reader);
    const out = await read({
      dataset: { w: [{ n: 1 }], e: ADMINS_ROWS },
      provenance: { w: prov("w", "Warehouse", "postgres"), e: prov("e", "Engine", "engine") },
      params: {},
    });
    expect(out.dataset.w).toEqual([{ n: 1 }]);
    expect(out.dataset.e).toEqual([]);
  });
});
