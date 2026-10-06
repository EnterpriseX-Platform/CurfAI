/**
 * previewRows() reads a lake table raw, and the table page, instant views,
 * auto-generate, Master Builder and the report generator's inventory showed
 * or handed those rows to a model regardless of the table's ACL (owner-only,
 * role-restricted) and its columns' sensitivity tags. They now go through
 * readableRows: nothing from a table the viewer can't read (admins included),
 * and tagged columns masked the way the Tables API masks them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/lake/tables", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lake/tables")>()),
  previewRows: vi.fn(),
}));

import { previewRows } from "@/lib/lake/tables";
import { canReadTable, previewRowsFor, columnsFor } from "./readableRows";

const SCHEMA = [
  { name: "email", type: "text", sensitivity: "pii" },
  { name: "salary", type: "number", sensitivity: "financial", unredactedForRoles: ["hr"] },
  { name: "region", type: "text" },
];
const table = (over: Partial<{ ownerUserId: string | null; visibleToRolesJson: string; schemaJson: string }> = {}) => ({
  name: "people", tenantId: "t1", ownerUserId: null, visibleToRolesJson: "[]", schemaJson: JSON.stringify(SCHEMA), ...over,
});

const MEMBER = { id: "u-member", isAdmin: false, roles: [] as string[] };
const HR_MEMBER = { id: "u-hr", isAdmin: false, roles: ["hr"] };
const ADMIN = { id: "u-admin", isAdmin: true, roles: [] as string[] };

beforeEach(() => {
  vi.clearAllMocks();
  // A fresh array per call: applyRedaction masks in place.
  vi.mocked(previewRows).mockImplementation(async () => [
    { email: "ann@example.com", salary: 90000, region: "North" },
    { email: "bob@example.com", salary: 70000, region: "South" },
  ]);
});

describe("previewRowsFor — a tenant-wide table", () => {
  it("masks tagged columns for a member and leaves the rest", async () => {
    const rows = await previewRowsFor(table(), MEMBER, 10);
    expect(rows).toEqual([
      { email: "•••••", salary: "<redacted>", region: "North" },
      { email: "•••••", salary: "<redacted>", region: "South" },
    ]);
    expect(previewRows).toHaveBeenCalledWith("t1", "people", 10);
  });

  it("shows an admin every value", async () => {
    const rows = await previewRowsFor(table(), ADMIN);
    expect(rows?.[0]).toEqual({ email: "ann@example.com", salary: 90000, region: "North" });
  });

  it("unmasks a column for a member holding one of its unredactedForRoles, and only that column", async () => {
    const rows = await previewRowsFor(table(), HR_MEMBER);
    expect(rows?.[0]).toEqual({ email: "•••••", salary: 90000, region: "North" });
  });

  it("masks nothing when the schema has no tags or doesn't parse", async () => {
    expect((await previewRowsFor(table({ schemaJson: "not json" }), MEMBER))?.[0].email).toBe("ann@example.com");
  });
});

describe("previewRowsFor — a table the viewer can't read", () => {
  it("returns null for someone else's owner-only table, admin included, without reading it", async () => {
    const mine = table({ ownerUserId: "u-owner" });
    expect(await previewRowsFor(mine, MEMBER)).toBeNull();
    expect(await previewRowsFor(mine, ADMIN)).toBeNull();
    expect(previewRows).not.toHaveBeenCalled();
    expect(canReadTable(mine, ADMIN)).toBe(false);
  });

  it("gives the owner their own table", async () => {
    const mine = table({ ownerUserId: "u-member" });
    expect(canReadTable(mine, MEMBER)).toBe(true);
    expect(await previewRowsFor(mine, MEMBER)).toHaveLength(2);
  });

  it("returns null for a role-restricted table to an admin outside its roles, rows to a holder", async () => {
    const hrOnly = table({ visibleToRolesJson: JSON.stringify(["hr"]) });
    expect(canReadTable(hrOnly, ADMIN)).toBe(false);
    expect(await previewRowsFor(hrOnly, ADMIN)).toBeNull();
    expect(await previewRowsFor(hrOnly, MEMBER)).toBeNull();
    expect(previewRows).not.toHaveBeenCalled();

    expect(canReadTable(hrOnly, HR_MEMBER)).toBe(true);
    expect(await previewRowsFor(hrOnly, HR_MEMBER)).toEqual([
      { email: "•••••", salary: 90000, region: "North" },
      { email: "•••••", salary: 70000, region: "South" },
    ]);
  });
});

describe("columnsFor", () => {
  // The lake file's own column list (getTable's) — a sample per column, no
  // sensitivity tags. The tags live on the catalog row's schemaJson.
  const columns = [
    { name: "email", type: "text" as const, sample: "ann@example.com" },
    { name: "salary", type: "number" as const, sample: 90000 },
    { name: "region", type: "text" as const, sample: "North" },
    { name: "notes", type: "text" as const, sample: null },
  ];
  const catalog = {
    schemaJson: JSON.stringify([
      ...SCHEMA,
      { name: "notes", type: "text", sensitivity: "pii" },
    ]),
  };

  it("masks the sample of a column the catalog tags, for a member, and only that column", () => {
    const out = columnsFor(columns, catalog, MEMBER);
    expect(out.map((c) => c.sample)).toEqual(["•••••", "<redacted>", "North", null]);
    // The rest of each column is untouched, and so is the input.
    expect(out[0]).toEqual({ name: "email", type: "text", sample: "•••••" });
    expect(columns[0].sample).toBe("ann@example.com");
  });

  it("shows an admin every sample", () => {
    expect(columnsFor(columns, catalog, ADMIN).map((c) => c.sample)).toEqual(["ann@example.com", 90000, "North", null]);
  });

  it("follows the rows' rules for a role holder: the column their role unlocks shows, the rest stay masked", () => {
    expect(columnsFor(columns, catalog, HR_MEMBER).map((c) => c.sample)).toEqual(["•••••", 90000, "North", null]);
  });

  it("masks nothing when the catalog has no tags or doesn't parse", () => {
    expect(columnsFor(columns, { schemaJson: "[]" }, MEMBER)).toEqual(columns);
    expect(columnsFor(columns, { schemaJson: "not json" }, MEMBER)).toEqual(columns);
  });
});
