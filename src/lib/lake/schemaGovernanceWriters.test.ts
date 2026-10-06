/**
 * Wiring coverage for LakeTable.schemaJson writers that overwrite an EXISTING
 * catalog row from freshly inferred columns — restore-from-backup and
 * materialized view refresh. Each of them used to write the bare
 * `inferColumns()` output straight back, silently dropping `sensitivity` /
 * `unredactedForRoles` / `syntheticHint` and so un-redacting a tagged column
 * (redaction fails OPEN). schemaGovernance.test.ts covers the merge itself;
 * this file pins that each writer actually goes through it.
 *
 * (The other two writers are covered beside their own code: pipeline re-runs in
 * pipelinesGovernance.test.ts — pipelines.ts is paid-only, so its test can't
 * live in a Community-shipped file — and POST /api/lake/tables/:name/bind next
 * to its route.)
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

const h = vi.hoisted(() => {
  const nodePath = require("node:path");
  const nodeOs = require("node:os");
  const nodeFs = require("node:fs");
  // backup.ts reads CURF_LAKE_BACKUP_DIR into a module-level const at import
  // time, so it has to be set before the imports below resolve.
  const root = nodePath.join(nodeOs.tmpdir(), `curf-gov-writers-test-${Date.now()}`);
  nodeFs.mkdirSync(root, { recursive: true });
  process.env.CURF_LAKE_BACKUP_DIR = nodePath.join(root, "backups");
  return {
    root,
    /** LakeTable catalog rows, keyed `${tenantId}::${name}`. */
    catalog: new Map<string, any>(),
    backups: new Map<string, any>(),
    /** What the mocked runner / snapshot read hands back for the next call. */
    nextRows: [] as Array<Record<string, unknown>>,
    /** The snapshot table's meta config, for the next snapshot read. */
    nextConfig: {} as Record<string, unknown>,
    mv: null as any,
    nextId: 1,
  };
});

const key = (tenantId: string, name: string) => `${tenantId}::${name}`;

vi.mock("@/lib/db", () => ({
  prisma: {
    lakeTable: {
      findUnique: vi.fn(async ({ where }: any) => h.catalog.get(key(where.tenantId_name.tenantId, where.tenantId_name.name)) ?? null),
      findFirst: vi.fn(async ({ where }: any) => h.catalog.get(key(where.tenantId, where.name)) ?? null),
      // sourceGovernance.ts's loadDerivationSources — refreshMaterializedView now
      // also inherits tags from the tables its SQL reads, not just its own prior row.
      findMany: vi.fn(async ({ where }: any) => [...h.catalog.values()].filter((r) => !where?.tenantId || r.tenantId === where.tenantId)),
      update: vi.fn(async ({ where, data }: any) => {
        const row = [...h.catalog.values()].find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `lt${h.nextId++}`, ...data };
        h.catalog.set(key(data.tenantId, data.name), row);
        return row;
      }),
      upsert: vi.fn(async ({ where, update, create }: any) => {
        const k = key(where.tenantId_name.tenantId, where.tenantId_name.name);
        const existing = h.catalog.get(k);
        const row = existing ? Object.assign(existing, update) : { id: `lt${h.nextId++}`, ...create };
        h.catalog.set(k, row);
        return row;
      }),
    },
    lakeBackup: {
      create: vi.fn(async ({ data }: any) => {
        const id = `backup${h.nextId++}`;
        h.backups.set(id, { id, ...data });
        return h.backups.get(id);
      }),
      update: vi.fn(async ({ where, data }: any) => Object.assign(h.backups.get(where.id), data)),
      delete: vi.fn(async ({ where }: any) => { h.backups.delete(where.id); }),
      findFirst: vi.fn(async ({ where }: any) => h.backups.get(where.id) ?? null),
    },
    materializedView: {
      findUnique: vi.fn(async () => h.mv),
      update: vi.fn(async () => h.mv),
    },
  },
}));

// Stands in for the real lake write: returns the BARE columns inferColumns()
// would produce (name/type only — never a governance field).
vi.mock("./tables", () => ({
  createOrReplaceTable: vi.fn(async ({ rows }: any) => ({
    rowCount: rows.length,
    columns: Object.keys(rows[0] ?? {}).map((name) => ({ name, type: "text" })),
  })),
}));
vi.mock("@/lib/reporting/runner", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/reporting/runner")>()),
  runReportWithProof: vi.fn(async ({ report }: any) => ({
    dataset: { [report.dataSources[0].id]: h.nextRows },
    provenance: { [report.dataSources[0].id]: {} },
  })),
}));
vi.mock("./bust", () => ({ bustLakeCacheForTenant: vi.fn(async () => {}) }));
vi.mock("@/lib/webhooks", () => ({ emitWebhook: vi.fn() }));
vi.mock("./storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./storage")>();
  return { ...actual, lakeFileSize: () => 0, closeLake: vi.fn(), openLake: vi.fn() };
});
vi.mock("@/ee", () => ({
  ee: {
    lake: {
      paidLiveLakeFile: vi.fn(async () => ({ path: path.join(h.root, "t.duckdb"), exists: true })),
      cloneLakeFileIfPaidEngine: vi.fn(async (_t: string, dest: string) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, "fake snapshot bytes");
        return { sizeBytes: 19 };
      }),
      countTablesInFileIfPaidEngine: vi.fn(async () => 1),
      integrityCheckIfPaidEngineFile: vi.fn(async () => null),
      shipSnapshotToDestinations: vi.fn(async () => {}),
      readTableFromSnapshotIfPaidEngine: vi.fn(async () => ({ rows: h.nextRows, sourceKind: "manual", sourceConfig: h.nextConfig })),
    },
  },
}));

import { snapshotTenant, restoreTableFromBackup } from "./backup";
import { createOrReplaceTable } from "./tables";
import { refreshMaterializedView, mvTableName } from "./materialize";

const TENANT = "tenant-gov";

/** What an admin has tagged: a pii column with a role allowlist, and a Master Builder join hint. */
const TAGGED = [
  { name: "name", type: "text" },
  { name: "email", type: "text", sensitivity: "pii", unredactedForRoles: ["finance"] },
  { name: "city", type: "text", syntheticHint: "fk:cities" },
];
const ROWS = [{ name: "Ada", email: "ada@example.com", city: "London" }];

function seedCatalog(name: string, schema: unknown[] = TAGGED) {
  h.catalog.set(key(TENANT, name), {
    id: `lt${h.nextId++}`, tenantId: TENANT, name, sourceKind: "manual", schemaJson: JSON.stringify(schema),
  });
}
const cols = (name: string) => JSON.parse(h.catalog.get(key(TENANT, name))!.schemaJson) as any[];
const byName = (list: any[], n: string) => list.find((c) => c.name === n);

function expectTagsIntact(list: any[]) {
  expect(byName(list, "email")).toMatchObject({ sensitivity: "pii", unredactedForRoles: ["finance"] });
  expect(byName(list, "city")).toMatchObject({ syntheticHint: "fk:cities" });
}

beforeEach(() => {
  h.catalog.clear();
  h.backups.clear();
  h.nextRows = ROWS;
  h.nextConfig = {};
  h.mv = { id: "mvid000000001", tenantId: TENANT, name: "mvgov", sql: "SELECT 1", dataSourceId: "ds1", createdById: null };
});
afterAll(() => { fs.rmSync(h.root, { recursive: true, force: true }); });

describe("restoreTableFromBackup — governance metadata", () => {
  async function restore() {
    const snap = await snapshotTenant({ tenantId: TENANT, kind: "manual" });
    return restoreTableFromBackup({ tenantId: TENANT, backupId: snap.backupId, tableName: "people" });
  }

  it("keeps the redaction tags and join hints on the existing catalog row", async () => {
    seedCatalog("people");
    await restore();
    expectTagsIntact(cols("people"));
  });

  it("carries a column that only exists in the snapshot through untagged, and does not resurrect a dropped one", async () => {
    seedCatalog("people");
    h.nextRows = [{ name: "Ada", email: "ada@example.com", zip: "N1" }]; // city gone, zip new
    await restore();
    const after = cols("people");
    expect(after.map((c) => c.name)).toEqual(["name", "email", "zip"]);
    expect(byName(after, "email")).toMatchObject({ sensitivity: "pii" });
    expect(byName(after, "zip").sensitivity).toBeUndefined();
  });

  it("brings the snapshot's formula columns back as formulas, not as the values they had then", async () => {
    const formulas = { email_domain: { formula: "RIGHT(email, 11)", type: "text" } };
    h.nextRows = [{ ...ROWS[0], email_domain: "example.com" }];
    h.nextConfig = { filename: "people.csv", __formulas: formulas };
    await restore();
    expect(vi.mocked(createOrReplaceTable).mock.calls.at(-1)![0]).toMatchObject({
      rows: ROWS, sourceConfig: { filename: "people.csv" }, formulas,
    });
    expect(vi.mocked(createOrReplaceTable).mock.calls.at(-1)![0].sourceConfig).not.toHaveProperty("__formulas");
  });

  it("creates a bare row when there is no catalog row to inherit from", async () => {
    await restore();
    const after = cols("people");
    expect(after.map((c) => c.name)).toEqual(["name", "email", "city"]);
    expect(after.every((c) => c.sensitivity === undefined && c.syntheticHint === undefined)).toBe(true);
  });
});

describe("refreshMaterializedView — governance metadata", () => {
  it("keeps tags an admin set on the mv_* table since the last refresh", async () => {
    await refreshMaterializedView(h.mv.id);          // first refresh: creates the row, bare
    expect(byName(cols(mvTableName("mvgov")), "email").sensitivity).toBeUndefined();
    h.catalog.get(key(TENANT, mvTableName("mvgov"))).schemaJson = JSON.stringify(TAGGED); // admin tags it
    await refreshMaterializedView(h.mv.id);          // the scheduled refresh fires again
    expectTagsIntact(cols(mvTableName("mvgov")));
  });

  it("follows the query's new shape: added column untagged, dropped column gone", async () => {
    seedCatalog(mvTableName("mvgov"));
    h.nextRows = [{ name: "Ada", email: "ada@example.com", zip: "N1" }];
    await refreshMaterializedView(h.mv.id);
    const after = cols(mvTableName("mvgov"));
    expect(after.map((c) => c.name)).toEqual(["name", "email", "zip"]);
    expect(byName(after, "email")).toMatchObject({ sensitivity: "pii" });
    expect(byName(after, "zip").sensitivity).toBeUndefined();
  });
});
