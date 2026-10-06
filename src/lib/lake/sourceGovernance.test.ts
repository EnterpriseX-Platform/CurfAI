/**
 * The inheritance rule for derived lake tables (see the header of
 * sourceGovernance.ts for the rule itself): a materialized-view output or
 * pipeline step output must not come out less redacted than the tables it was
 * derived from.
 *
 * inheritSourceGovernance() is pure and covered directly; the loader and
 * governDerivedColumns() run against a fake catalog so tenant scoping and the
 * fail-closed lookup can be asserted. That materialize.ts / pipelines.ts
 * actually call it is pinned beside each of them (materializeGovernance.test.ts,
 * pipelinesGovernance.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  /** LakeTable catalog rows, keyed `${tenantId}::${name}`. */
  catalog: new Map<string, any>(),
  findManyError: null as Error | null,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    lakeTable: {
      findMany: vi.fn(async ({ where }: any) => {
        if (h.findManyError) throw h.findManyError;
        // A missing tenant filter returns EVERY tenant's rows, like the real table would.
        return [...h.catalog.values()].filter((r) => !where?.tenantId || r.tenantId === where.tenantId);
      }),
      findUnique: vi.fn(async ({ where }: any) =>
        h.catalog.get(`${where.tenantId_name.tenantId}::${where.tenantId_name.name}`) ?? null),
    },
  },
}));

import { prisma } from "@/lib/db";
import {
  governDerivedColumns,
  governDerivedTableAcl,
  inheritSourceGovernance,
  inheritTableAcl,
  loadDerivationSources,
  TABLE_ACL_DENY_ALL_SENTINEL,
  type SourceTable,
} from "./sourceGovernance";
import type { LakeColumn } from "./tables";

const col = (name: string, extra: Partial<LakeColumn> = {}): LakeColumn => ({ name, type: "text", ...extra });
const byName = (list: LakeColumn[], n: string) => list.find((c) => c.name === n)!;

const CUSTOMERS: SourceTable = {
  name: "customers",
  columns: [
    col("id"),
    col("region"),
    col("amount", { type: "number" }),
    col("email", { sensitivity: "pii", unredactedForRoles: ["finance", "hr"] }),
    col("ssn", { sensitivity: "secret", unredactedForRoles: ["hr"] }),
  ],
ownerUserId: null,
visibleToRolesJson: "[]",
};

function inherit(over: Partial<Parameters<typeof inheritSourceGovernance>[0]> & { columns: LakeColumn[] }) {
  return inheritSourceGovernance({ sources: [CUSTOMERS], sql: "SELECT * FROM customers", priorColumnNames: [], ...over });
}

describe("inheritSourceGovernance — R1: same-named columns inherit", () => {
  it("copies the tag and allowlist of a passthrough column", () => {
    const out = inherit({ sql: "SELECT id, email FROM customers", columns: [col("id"), col("email")] });
    expect(byName(out, "email")).toMatchObject({ sensitivity: "pii", unredactedForRoles: ["finance", "hr"] });
    expect(byName(out, "id").sensitivity).toBeUndefined();
  });

  it("covers SELECT * — every same-named tagged column, nothing else", () => {
    const out = inherit({ columns: CUSTOMERS.columns.map((c) => col(c.name, { type: c.type })) });
    expect(out.map((c) => [c.name, c.sensitivity])).toEqual([
      ["id", undefined], ["region", undefined], ["amount", undefined], ["email", "pii"], ["ssn", "secret"],
    ]);
  });

  it("matches names case-insensitively", () => {
    const out = inherit({ sql: 'SELECT email AS "Email" FROM customers', columns: [col("Email")] });
    expect(byName(out, "Email")).toMatchObject({ sensitivity: "pii", unredactedForRoles: ["finance", "hr"] });
  });

  it("across several tagged sources: most severe label, INTERSECTION of allowlists", () => {
    const orders: SourceTable = {
      name: "orders",
      columns: [col("email", { sensitivity: "financial", unredactedForRoles: ["hr", "legal"] })],
    ownerUserId: null,
    visibleToRolesJson: "[]",
    };
    const out = inherit({
      sources: [CUSTOMERS, orders], sql: "SELECT email FROM customers JOIN orders USING (id)", columns: [col("email")],
    });
    // financial outranks pii; only hr is allowed by BOTH sources.
    expect(byName(out, "email")).toMatchObject({ sensitivity: "financial", unredactedForRoles: ["hr"] });
  });

  it("disjoint allowlists collapse to nobody (empty list = default deny)", () => {
    const orders: SourceTable = { name: "orders", columns: [col("email", { sensitivity: "pii", unredactedForRoles: ["legal"] })], ownerUserId: null, visibleToRolesJson: "[]" };
    const out = inherit({ sources: [CUSTOMERS, orders], sql: "SELECT email FROM customers, orders", columns: [col("email")] });
    expect(byName(out, "email").unredactedForRoles).toEqual([]);
  });

  it("a tagged source with no allowlist (nobody) makes the derived column nobody-visible", () => {
    const strict: SourceTable = { name: "customers", columns: [col("email", { sensitivity: "pii" })], ownerUserId: null, visibleToRolesJson: "[]" };
    const out = inherit({ sources: [strict], sql: "SELECT email FROM customers", columns: [col("email", { unredactedForRoles: ["finance"] })] });
    // (own allowlist alone, with no sensitivity, restricts nothing — the source's tag is what applies)
    expect(byName(out, "email")).toMatchObject({ sensitivity: "pii", unredactedForRoles: [] });
  });

  it("an untagged same-named column in another source does not dilute a tagged one (strictest wins)", () => {
    const leads: SourceTable = { name: "leads", columns: [col("email")], ownerUserId: null, visibleToRolesJson: "[]" };
    const out = inherit({ sources: [CUSTOMERS, leads], sql: "SELECT email FROM customers UNION ALL SELECT email FROM leads", columns: [col("email")] });
    expect(byName(out, "email")).toMatchObject({ sensitivity: "pii", unredactedForRoles: ["finance", "hr"] });
  });

  it("with nothing tagged in any source there is nothing to inherit — the same columns come back", () => {
    const leads: SourceTable = { name: "leads", columns: [col("email"), col("city")], ownerUserId: null, visibleToRolesJson: "[]" };
    const columns = [col("email"), col("contact")];
    expect(inherit({ sources: [leads], sql: "SELECT email, email AS contact FROM leads", columns })).toBe(columns);
  });

  it("keeps the column's other fields (type, sample, syntheticHint)", () => {
    const out = inherit({
      sql: "SELECT email FROM customers",
      columns: [col("email", { sample: "a@b.co", syntheticHint: "fk:people" })],
    });
    expect(byName(out, "email")).toMatchObject({ type: "text", sample: "a@b.co", syntheticHint: "fk:people", sensitivity: "pii" });
  });
});

describe("inheritSourceGovernance — own tags on the derived column", () => {
  it("never loosens: the admin's stricter own tag survives inheritance", () => {
    const out = inherit({
      sql: "SELECT email FROM customers",
      columns: [col("email", { sensitivity: "secret", unredactedForRoles: [] })],
    });
    expect(byName(out, "email")).toMatchObject({ sensitivity: "secret", unredactedForRoles: [] });
  });

  it("never lets the derived table grant a role the source withheld", () => {
    const out = inherit({
      sql: "SELECT email FROM customers",
      columns: [col("email", { sensitivity: "pii", unredactedForRoles: ["finance", "marketing"] })],
    });
    expect(byName(out, "email").unredactedForRoles).toEqual(["finance"]);
  });

  it("never grants the source's roles to a column the admin restricted harder", () => {
    const out = inherit({
      sql: "SELECT email FROM customers",
      columns: [col("email", { sensitivity: "pii", unredactedForRoles: ["hr"] })],
    });
    expect(byName(out, "email").unredactedForRoles).toEqual(["hr"]);
  });

  it("raises the label when the source is more severe than the admin's own", () => {
    const out = inherit({
      sql: "SELECT ssn FROM customers",
      columns: [col("ssn", { sensitivity: "pii", unredactedForRoles: ["hr"] })],
    });
    expect(byName(out, "ssn").sensitivity).toBe("secret");
  });

  it("is idempotent — re-applying to its own output changes nothing", () => {
    const columns = [col("id"), col("email"), col("contact")];
    const sql = "SELECT id, email, email AS contact FROM customers";
    const once = inherit({ sql, columns });
    const twice = inherit({ sql, columns: once, priorColumnNames: once.map((c) => c.name) });
    expect(twice).toEqual(once);
  });

  it("does not mutate its inputs", () => {
    const columns = [col("email", { unredactedForRoles: ["finance"] })];
    const frozen = JSON.stringify([columns, CUSTOMERS]);
    inherit({ sql: "SELECT email FROM customers", columns });
    expect(JSON.stringify([columns, CUSTOMERS])).toBe(frozen);
  });
});

describe("inheritSourceGovernance — R2: fail closed on a column that can't be matched by name", () => {
  it("flags an aliased column", () => {
    const out = inherit({ sql: "SELECT email AS contact FROM customers", columns: [col("contact")] });
    expect(byName(out, "contact")).toMatchObject({ sensitivity: "pii", unredactedForRoles: ["finance", "hr"] });
  });

  it("flags an expression over a tagged column", () => {
    const out = inherit({ sql: "SELECT lower(email) AS e FROM customers", columns: [col("e")] });
    expect(byName(out, "e").sensitivity).toBe("pii");
  });

  it("flags a column built from several tagged ones with their combined restriction", () => {
    const out = inherit({ sql: "SELECT concat(email, ssn) AS blob FROM customers", columns: [col("blob")] });
    expect(byName(out, "blob")).toMatchObject({ sensitivity: "secret", unredactedForRoles: ["hr"] });
  });

  it("leaves a column alone when the SQL never mentions a tagged column", () => {
    const out = inherit({ sql: "SELECT region, SUM(amount) AS total FROM customers GROUP BY region", columns: [col("region"), col("total")] });
    expect(out.every((c) => c.sensitivity === undefined)).toBe(true);
  });

  it("does not treat a longer identifier as a mention (email_domain ≠ email)", () => {
    const out = inherit({ sql: "SELECT split_part(email_domain, '.', 1) AS d FROM customers", columns: [col("d")] });
    expect(byName(out, "d").sensitivity).toBeUndefined();
  });

  it("leaves a column that matches an untagged source column by name alone, even if a tagged one is mentioned", () => {
    const out = inherit({ sql: "SELECT region FROM customers WHERE email IS NOT NULL", columns: [col("region")] });
    expect(byName(out, "region").sensitivity).toBeUndefined();
  });

  it("applies once, at first appearance: a column the table already had is not re-flagged after an admin cleared it", () => {
    const sql = "SELECT COUNT(email) AS n FROM customers";
    const first = inherit({ sql, columns: [col("n", { type: "number" })] });
    expect(byName(first, "n").sensitivity).toBe("pii"); // the false positive, at creation
    const afterClear = inherit({ sql, columns: [col("n", { type: "number" })], priorColumnNames: ["n"] });
    expect(byName(afterClear, "n").sensitivity).toBeUndefined(); // cleared, stays cleared
  });

  it("does not let R2 weaken an existing tag", () => {
    const out = inherit({
      sql: "SELECT email AS contact FROM customers",
      columns: [col("contact", { sensitivity: "secret", unredactedForRoles: [] })],
    });
    expect(byName(out, "contact")).toMatchObject({ sensitivity: "secret", unredactedForRoles: [] });
  });
});

describe("loadDerivationSources / governDerivedColumns", () => {
  const seed = (tenantId: string, name: string, schema: LakeColumn[], acl: { ownerUserId?: string | null; visibleToRolesJson?: string } = {}) =>
    h.catalog.set(`${tenantId}::${name}`, {
      tenantId, name, schemaJson: JSON.stringify(schema),
      ownerUserId: acl.ownerUserId ?? null, visibleToRolesJson: acl.visibleToRolesJson ?? "[]",
    });

  beforeEach(() => {
    h.catalog.clear();
    h.findManyError = null;
    vi.mocked(prisma.lakeTable.findMany).mockClear();
  });

  it("returns only the referenced tables, with their parsed schemas, scoped to the tenant", async () => {
    seed("t1", "customers", CUSTOMERS.columns);
    seed("t1", "unrelated", [col("email", { sensitivity: "pii" })]);
    const out = await loadDerivationSources("t1", "SELECT email FROM customers");
    expect(out.map((s) => s.name)).toEqual(["customers"]);
    expect(byName(out[0].columns, "email").sensitivity).toBe("pii");
    expect(vi.mocked(prisma.lakeTable.findMany).mock.calls[0][0]).toMatchObject({ where: { tenantId: "t1" } });
  });

  it("never reads another tenant's tags", async () => {
    seed("other-tenant", "customers", CUSTOMERS.columns);
    const columns = await governDerivedColumns({ tenantId: "t1", tableName: "mv_x", sql: "SELECT email FROM customers", columns: [col("email")] });
    expect(byName(columns, "email").sensitivity).toBeUndefined();
  });

  it("throws when the lookup fails, rather than silently returning untagged columns", async () => {
    h.findManyError = new Error("db down");
    await expect(
      governDerivedColumns({ tenantId: "t1", tableName: "mv_x", sql: "SELECT email FROM customers", columns: [col("email")] }),
    ).rejects.toThrow("db down");
  });

  it("carries the table's own existing tags AND inherits, using its previous schema for R2's first-appearance test", async () => {
    seed("t1", "customers", CUSTOMERS.columns);
    seed("t1", "mv_x", [col("email", { sensitivity: "secret", unredactedForRoles: [] }), col("n", { type: "number" })]); // n was cleared earlier
    const columns = await governDerivedColumns({
      tenantId: "t1", tableName: "mv_x",
      sql: "SELECT email, COUNT(email) AS n, lower(email) AS e FROM customers",
      columns: [col("email"), col("n", { type: "number" }), col("e")],
    });
    expect(byName(columns, "email")).toMatchObject({ sensitivity: "secret", unredactedForRoles: [] }); // own, stricter
    expect(byName(columns, "n").sensitivity).toBeUndefined(); // existed before → not re-flagged
    expect(byName(columns, "e").sensitivity).toBe("pii");     // new → flagged
  });
});

describe("inheritTableAcl — table-level ACL inheritance", () => {
  const tenantOnly: SourceTable = { name: "public_ref", columns: [], ownerUserId: null, visibleToRolesJson: "[]" };
  const ownedByU1: SourceTable = { name: "priv1", columns: [], ownerUserId: "u1", visibleToRolesJson: "[]" };
  const ownedByU2: SourceTable = { name: "priv2", columns: [], ownerUserId: "u2", visibleToRolesJson: "[]" };
  const financeOnly: SourceTable = { name: "fin", columns: [], ownerUserId: null, visibleToRolesJson: JSON.stringify(["finance", "hr"]) };
  const hrOnly: SourceTable = { name: "hrdata", columns: [], ownerUserId: null, visibleToRolesJson: JSON.stringify(["hr", "legal"]) };
  const financeOnlyNoOverlap: SourceTable = { name: "fin2", columns: [], ownerUserId: null, visibleToRolesJson: JSON.stringify(["finance"]) };

  it("no restricted source — nothing to inherit", () => {
    expect(inheritTableAcl([tenantOnly])).toBeNull();
  });

  it("a single owner_only source — the derived table inherits that exact owner", () => {
    expect(inheritTableAcl([tenantOnly, ownedByU1])).toEqual({ ownerUserId: "u1", visibleToRolesJson: "[]" });
  });

  it("two owner_only sources with the SAME owner — inherits that owner", () => {
    expect(inheritTableAcl([ownedByU1, { ...ownedByU1, name: "priv1b" }])).toEqual({ ownerUserId: "u1", visibleToRolesJson: "[]" });
  });

  it("two owner_only sources with DIFFERENT owners — fails closed to deny-all (nobody could satisfy both)", () => {
    expect(inheritTableAcl([ownedByU1, ownedByU2])).toEqual({ ownerUserId: TABLE_ACL_DENY_ALL_SENTINEL, visibleToRolesJson: "[]" });
  });

  it("a single roles source — the derived table inherits that role list", () => {
    expect(inheritTableAcl([tenantOnly, financeOnly])).toEqual({ ownerUserId: null, visibleToRolesJson: JSON.stringify(["finance", "hr"]) });
  });

  it("two roles sources with overlapping roles — intersection, not union", () => {
    const out = inheritTableAcl([financeOnly, hrOnly])!;
    expect(JSON.parse(out.visibleToRolesJson)).toEqual(["hr"]);
    expect(out.ownerUserId).toBeNull();
  });

  it("two roles sources with NO overlap — fails closed to deny-all, not an open empty-roles table", () => {
    expect(inheritTableAcl([financeOnlyNoOverlap, hrOnly])).toEqual({ ownerUserId: TABLE_ACL_DENY_ALL_SENTINEL, visibleToRolesJson: "[]" });
  });

  it("mixed owner_only + roles sources — fails closed to deny-all (no single row expresses both)", () => {
    expect(inheritTableAcl([ownedByU1, financeOnly])).toEqual({ ownerUserId: TABLE_ACL_DENY_ALL_SENTINEL, visibleToRolesJson: "[]" });
  });
});

describe("governDerivedTableAcl", () => {
  const seedTable = (tenantId: string, name: string, acl: { ownerUserId?: string | null; visibleToRolesJson?: string } = {}) =>
    h.catalog.set(`${tenantId}::${name}`, {
      tenantId, name, schemaJson: "[]",
      ownerUserId: acl.ownerUserId ?? null, visibleToRolesJson: acl.visibleToRolesJson ?? "[]",
    });

  beforeEach(() => { h.catalog.clear(); });

  it("applies the inherited restriction when the derived table is currently open (no prior row)", async () => {
    const sources: SourceTable[] = [{ name: "customers", columns: [], ownerUserId: "u1", visibleToRolesJson: "[]" }];
    const out = await governDerivedTableAcl({ tenantId: "t1", tableName: "mv_x", sources });
    expect(out).toEqual({ ownerUserId: "u1", visibleToRolesJson: "[]" });
  });

  it("applies the inherited restriction when the derived table exists but is still open", async () => {
    seedTable("t1", "mv_x"); // exists, no ACL of its own
    const sources: SourceTable[] = [{ name: "customers", columns: [], ownerUserId: "u1", visibleToRolesJson: "[]" }];
    const out = await governDerivedTableAcl({ tenantId: "t1", tableName: "mv_x", sources });
    expect(out).toEqual({ ownerUserId: "u1", visibleToRolesJson: "[]" });
  });

  it("never touches a derived table that already has its own restriction — sticky, admin's choice wins", async () => {
    seedTable("t1", "mv_x", { visibleToRolesJson: JSON.stringify(["exec"]) }); // admin's own choice
    const sources: SourceTable[] = [{ name: "customers", columns: [], ownerUserId: "u1", visibleToRolesJson: "[]" }];
    const out = await governDerivedTableAcl({ tenantId: "t1", tableName: "mv_x", sources });
    expect(out).toBeNull();
  });

  it("returns null when nothing is restricted, whether or not the row exists yet", async () => {
    const sources: SourceTable[] = [{ name: "customers", columns: [], ownerUserId: null, visibleToRolesJson: "[]" }];
    expect(await governDerivedTableAcl({ tenantId: "t1", tableName: "mv_x", sources })).toBeNull();
  });
});
