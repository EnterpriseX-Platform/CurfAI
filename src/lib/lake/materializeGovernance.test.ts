/**
 * refreshMaterializedView writes the mv_* table's catalog row from freshly
 * inferred (bare) columns. sourceGovernance.test.ts covers the inheritance rule
 * itself; this pins that the refresh actually goes through it — so
 * `SELECT email FROM customers` does not come out as a table whose email column
 * viewers can read raw — and that a failed lookup fails the refresh instead of
 * writing untagged columns.
 *
 * (Pipelines have the same wiring test, pipelinesGovernance.test.ts — apart
 * from this file because pipelines.ts is paid-only and its test has to be
 * excluded from the Community export with it.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  /** LakeTable catalog rows, keyed `${tenantId}::${name}`. */
  catalog: new Map<string, any>(),
  /** What the mocked runner hands back for the next refresh. */
  nextRows: [] as Array<Record<string, unknown>>,
  mv: null as any,
  findManyError: null as Error | null,
  nextId: 1,
}));

const key = (tenantId: string, name: string) => `${tenantId}::${name}`;

vi.mock("@/lib/db", () => ({
  prisma: {
    lakeTable: {
      findUnique: vi.fn(async ({ where }: any) => h.catalog.get(key(where.tenantId_name.tenantId, where.tenantId_name.name)) ?? null),
      // A missing tenant filter returns EVERY tenant's rows, like the real table would.
      findMany: vi.fn(async ({ where }: any) => {
        if (h.findManyError) throw h.findManyError;
        return [...h.catalog.values()].filter((r) => !where?.tenantId || r.tenantId === where.tenantId);
      }),
      upsert: vi.fn(async ({ where, update, create }: any) => {
        const k = key(where.tenantId_name.tenantId, where.tenantId_name.name);
        const existing = h.catalog.get(k);
        const row = existing ? Object.assign(existing, update) : { id: `lt${h.nextId++}`, ...create };
        h.catalog.set(k, row);
        return row;
      }),
    },
    materializedView: {
      findUnique: vi.fn(async () => h.mv),
      update: vi.fn(async () => h.mv),
    },
  },
}));

// Stands in for the real lake write: the BARE columns inferColumns() would
// produce — name/type only, never a governance field.
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
  return { ...actual, lakeFileSize: () => 0 };
});

import { refreshMaterializedView, mvTableName } from "./materialize";

const TENANT = "tenant-gov";
const MV_TABLE = mvTableName("mvgov");

/** A source table whose email is tagged pii (finance may see it), ssn secret. */
const CUSTOMERS = [
  { name: "id", type: "text" },
  { name: "email", type: "text", sensitivity: "pii", unredactedForRoles: ["finance"] },
  { name: "ssn", type: "text", sensitivity: "secret", unredactedForRoles: [] },
];

function seedCatalog(tenantId: string, name: string, schema: unknown[], acl: { ownerUserId?: string | null; visibleToRolesJson?: string } = {}) {
  h.catalog.set(key(tenantId, name), {
    id: `lt${h.nextId++}`, tenantId, name, sourceKind: "manual", schemaJson: JSON.stringify(schema),
    ownerUserId: acl.ownerUserId ?? null, visibleToRolesJson: acl.visibleToRolesJson ?? "[]",
  });
}
const cols = (name = MV_TABLE) => JSON.parse(h.catalog.get(key(TENANT, name))!.schemaJson) as any[];
const byName = (list: any[], n: string) => list.find((c) => c.name === n);
const setSql = (sql: string, rows: Array<Record<string, unknown>>) => { h.mv.sql = sql; h.nextRows = rows; };

beforeEach(() => {
  h.catalog.clear();
  h.findManyError = null;
  h.mv = { id: "mvid000000001", tenantId: TENANT, name: "mvgov", sql: "SELECT 1", dataSourceId: "ds1", createdById: null };
  seedCatalog(TENANT, "customers", CUSTOMERS);
});

describe("refreshMaterializedView — inheriting tags from the tables the SQL reads", () => {
  it("the FIRST refresh creates the mv_* row already tagged like its source", async () => {
    setSql("SELECT id, email FROM customers", [{ id: "1", email: "ada@example.com" }]);
    expect((await refreshMaterializedView(h.mv.id)).status).toBe("ok");
    expect(byName(cols(), "email")).toMatchObject({ sensitivity: "pii", unredactedForRoles: ["finance"] });
    expect(byName(cols(), "id").sensitivity).toBeUndefined();
  });

  it("flags a column it can't match by name (alias) at creation, and leaves it cleared once an admin clears it", async () => {
    setSql("SELECT email AS contact FROM customers", [{ contact: "ada@example.com" }]);
    await refreshMaterializedView(h.mv.id);
    expect(byName(cols(), "contact")).toMatchObject({ sensitivity: "pii", unredactedForRoles: ["finance"] });

    h.catalog.get(key(TENANT, MV_TABLE)).schemaJson = JSON.stringify([{ name: "contact", type: "text" }]); // admin clears it
    await refreshMaterializedView(h.mv.id); // the schedule fires again
    expect(byName(cols(), "contact").sensitivity).toBeUndefined();
  });

  it("picks up a tag added to the source after the view was first built", async () => {
    h.catalog.get(key(TENANT, "customers")).schemaJson = JSON.stringify([{ name: "id", type: "text" }, { name: "email", type: "text" }]);
    setSql("SELECT id, email FROM customers", [{ id: "1", email: "ada@example.com" }]);
    await refreshMaterializedView(h.mv.id);
    expect(byName(cols(), "email").sensitivity).toBeUndefined();

    h.catalog.get(key(TENANT, "customers")).schemaJson = JSON.stringify(CUSTOMERS); // admin tags the source
    await refreshMaterializedView(h.mv.id);
    expect(byName(cols(), "email")).toMatchObject({ sensitivity: "pii", unredactedForRoles: ["finance"] });
  });

  it("never weakens a stricter tag an admin set on the mv_* table itself", async () => {
    seedCatalog(TENANT, MV_TABLE, [{ name: "email", type: "text", sensitivity: "secret", unredactedForRoles: [] }]);
    setSql("SELECT email FROM customers", [{ email: "ada@example.com" }]);
    await refreshMaterializedView(h.mv.id);
    expect(byName(cols(), "email")).toMatchObject({ sensitivity: "secret", unredactedForRoles: [] });
  });

  it("inherits through a view over a view (the inner view's row carries its own inherited tags)", async () => {
    seedCatalog(TENANT, "mv_inner", [{ name: "email", type: "text", sensitivity: "pii", unredactedForRoles: ["finance"] }]);
    setSql("SELECT email FROM mv_inner", [{ email: "ada@example.com" }]);
    await refreshMaterializedView(h.mv.id);
    expect(byName(cols(), "email")).toMatchObject({ sensitivity: "pii", unredactedForRoles: ["finance"] });
  });

  it("does not consult another tenant's tables", async () => {
    h.catalog.clear();
    seedCatalog("other-tenant", "customers", CUSTOMERS);
    setSql("SELECT email FROM customers", [{ email: "ada@example.com" }]);
    await refreshMaterializedView(h.mv.id);
    expect(byName(cols(), "email").sensitivity).toBeUndefined();
  });

  it("fails the refresh — and writes no untagged catalog row — when the source lookup fails", async () => {
    setSql("SELECT email FROM customers", [{ email: "ada@example.com" }]);
    h.findManyError = new Error("db down");
    const result = await refreshMaterializedView(h.mv.id);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("db down");
    expect(h.catalog.has(key(TENANT, MV_TABLE))).toBe(false);
  });
});

describe("refreshMaterializedView — inheriting TABLE-LEVEL ACL from the tables the SQL reads", () => {
  it("an MV over a role-restricted source is role-restricted itself on its first refresh, not tenant-wide", async () => {
    h.catalog.get(key(TENANT, "customers"))!.visibleToRolesJson = JSON.stringify(["finance"]);
    setSql("SELECT email FROM customers", [{ email: "ada@example.com" }]);
    await refreshMaterializedView(h.mv.id);
    const row = h.catalog.get(key(TENANT, MV_TABLE))!;
    expect(JSON.parse(row.visibleToRolesJson)).toEqual(["finance"]);
    expect(row.ownerUserId).toBeNull();
  });

  it("an MV over an owner_only source inherits that exact owner", async () => {
    h.catalog.get(key(TENANT, "customers"))!.ownerUserId = "u1";
    setSql("SELECT email FROM customers", [{ email: "ada@example.com" }]);
    await refreshMaterializedView(h.mv.id);
    expect(h.catalog.get(key(TENANT, MV_TABLE))!.ownerUserId).toBe("u1");
  });

  it("never widens a restriction the admin already set on the MV itself — stays put across refreshes", async () => {
    seedCatalog(TENANT, MV_TABLE, [], { visibleToRolesJson: JSON.stringify(["exec"]) }); // admin's own, unrelated to the source
    h.catalog.get(key(TENANT, "customers"))!.ownerUserId = "u1";
    setSql("SELECT email FROM customers", [{ email: "ada@example.com" }]);
    await refreshMaterializedView(h.mv.id);
    // Already restricted (by the admin, not inheritance) — governDerivedTableAcl treats
    // any existing restriction as sticky and leaves it exactly as it was.
    const row = h.catalog.get(key(TENANT, MV_TABLE))!;
    expect(JSON.parse(row.visibleToRolesJson)).toEqual(["exec"]);
    expect(row.ownerUserId).toBeNull();
  });

  it("re-inherits if an admin reopens the MV while its source is still restricted — matches R1's column-tag stickiness, not a permanent override", async () => {
    seedCatalog(TENANT, MV_TABLE, []); // exists, currently open (e.g. admin cleared it earlier)
    h.catalog.get(key(TENANT, "customers"))!.ownerUserId = "u1";
    setSql("SELECT email FROM customers", [{ email: "ada@example.com" }]);
    await refreshMaterializedView(h.mv.id);
    // Same "to declassify, declassify the source" rule column tags already document —
    // an open derived row with a still-restricted source gets re-inherited, not left open.
    expect(h.catalog.get(key(TENANT, MV_TABLE))!.ownerUserId).toBe("u1");
  });
});
