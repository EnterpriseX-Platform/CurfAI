/**
 * The table page showed 50 raw rows and each column's sample value of ANY
 * lake table to any signed-in member: an owner-only or role-restricted table
 * was one URL away, and sensitivity-tagged columns rendered unmasked. It now
 * reads through lib/lake/readableRows.ts: a member who can't read the table
 * gets a 404, an admin outside its roles still reaches the page (to manage
 * its access) with no rows and no samples, and a reader sees masked values.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({ user: null as any, roles: [] as string[], row: null as any, meta: null as any, panelProps: null as any }));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  redirect: vi.fn((to: string) => { throw new Error("NEXT_REDIRECT " + to); }),
}));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => createElement("a", { href }, children) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    lakeTable: { findFirst: vi.fn(async () => h.row) },
    role: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireUser: vi.fn(async () => h.user), getUserRoles: vi.fn(async () => h.roles) };
});
vi.mock("@/lib/reporting/runner", () => ({ ANONYMOUS_VIEWER: { id: "anonymous", isAdmin: false, roles: [] } }));
vi.mock("@/lib/lake/tables", () => ({
  previewRows: vi.fn(),
  getTable: vi.fn(async () => h.meta),
  typedColumnsEnabled: vi.fn(() => false),
}));
vi.mock("@/lib/lake/freshness", () => ({ freshnessIssueForOne: vi.fn(async () => null) }));
vi.mock("@/ee", () => ({ ee: {} }));
vi.mock("@/lib/i18n/dict", () => ({ LOCALES: ["en"], t: (_l: string, k: string) => k }));
vi.mock("@/components/layout/AppShell", () => ({ AppShell: ({ children }: { children: ReactNode }) => createElement("div", null, children) }));
vi.mock("./DeleteTableButton", () => ({ DeleteTableButton: () => null }));
vi.mock("./AutoGenerateButton", () => ({ AutoGenerateButton: () => null }));
vi.mock("./AddColumnButton", () => ({ AddColumnButton: () => null }));
vi.mock("./SpreadsheetView", () => ({ SpreadsheetView: () => null }));
vi.mock("./TableManagePanel", () => ({ TableManagePanel: (props: any) => { h.panelProps = props; return null; } }));

import { previewRows } from "@/lib/lake/tables";
import TableDetailPage from "./page";

const SCHEMA = [
  { name: "email", type: "text", sample: "ann@example.com", sensitivity: "pii" },
  { name: "region", type: "text", sample: "North" },
];
const tableRow = (over: Record<string, unknown> = {}) => ({
  id: "lt1", tenantId: "t1", name: "people", sourceKind: "upload", sourceConfigJson: "{}", rowCount: 2,
  ownerUserId: null, visibleToRolesJson: "[]", schemaJson: JSON.stringify(SCHEMA), ...over,
});

const render = async () => renderToStaticMarkup(await TableDetailPage({ params: { name: "people" } }) as any);
/** The markup of the preview-rows section (after its heading). */
const previewSection = (html: string) => html.slice(html.indexOf("tableDetail.previewHeading"));
/** The markup of the schema section (column / type / sample). */
const schemaSection = (html: string) => html.slice(html.indexOf("tableDetail.schemaHeading"), html.indexOf("tableDetail.previewHeading"));

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { id: "u-member", role: "developer", tenantId: "t1", email: "m@test.dev" };
  h.roles = [];
  h.row = tableRow();
  h.meta = null;
  h.panelProps = null;
  vi.mocked(previewRows).mockImplementation(async () => [
    { email: "ann@example.com", region: "North" },
    { email: "bob@example.com", region: "South" },
  ]);
});

describe("/tables/[name] — what the page shows of a table's rows", () => {
  it("is a 404 for a viewer-role member on someone else's owner-only table, and reads no rows", async () => {
    h.user = { id: "u-viewer", role: "viewer", tenantId: "t1", email: "v@test.dev" };
    h.row = tableRow({ ownerUserId: "u-owner" });
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(previewRows).not.toHaveBeenCalled();
  });

  it("masks a pii column in the preview rows for a member of a tenant-wide table", async () => {
    const preview = previewSection(await render());
    expect(preview).toContain("•••••");
    expect(preview).not.toContain("ann@example.com");
    expect(preview).not.toContain("bob@example.com");
    expect(preview).toContain("North");
    expect(preview).toContain("South");
  });

  it("masks a pii column's sample in the schema for a member (catalog columns)", async () => {
    const schema = schemaSection(await render());
    expect(schema).not.toContain("ann@example.com");
    expect(schema).toContain("•••••");
    expect(schema).toContain("North");
    expect(h.panelProps.initialSchema.find((c: any) => c.name === "email").sample).toBe("•••••");
  });

  // Whenever the lake file exists the page takes its columns from getTable(),
  // whose on-disk schema carries each column's first value as `sample` but
  // none of the sensitivity tags (those live on LakeTable.schemaJson). The
  // mask has to come from the catalog row, or the raw value renders here.
  it("masks a pii column's sample in the schema for a member (on-disk columns from getTable, no tags)", async () => {
    h.meta = { name: "people", columns: [{ name: "email", type: "text", sample: "ann@example.com" }, { name: "region", type: "text", sample: "North" }] };
    const schema = schemaSection(await render());
    expect(schema).not.toContain("ann@example.com");
    expect(schema).toContain("•••••");
    expect(schema).toContain("North");
    expect(h.panelProps.initialSchema.find((c: any) => c.name === "email").sample).toBe("•••••");
  });

  it("shows an admin every value", async () => {
    h.user = { id: "u-admin", role: "admin", tenantId: "t1", email: "a@test.dev" };
    h.meta = { name: "people", columns: [{ name: "email", type: "text", sample: "ann@example.com" }, { name: "region", type: "text", sample: "North" }] };
    const html = await render();
    expect(previewSection(html)).toContain("ann@example.com");
    expect(schemaSection(html)).toContain("ann@example.com");
  });

  it("renders for an admin outside a role-restricted table's roles, with no preview rows and no samples", async () => {
    h.user = { id: "u-admin", role: "admin", tenantId: "t1", email: "a@test.dev" };
    h.roles = ["finance"];
    h.row = tableRow({ visibleToRolesJson: JSON.stringify(["hr"]) });
    const html = await render();
    expect(previewRows).not.toHaveBeenCalled();
    expect(previewSection(html)).toContain("tableDetail.noRowsYet");
    expect(html).not.toContain("ann@example.com");
    expect(html).not.toContain("North");
    // Still manageable: the panel gets the columns, without their samples.
    expect(h.panelProps.initialSchema.map((c: any) => [c.name, c.sample])).toEqual([["email", undefined], ["region", undefined]]);
    expect(h.panelProps.initialVisibleToRoles).toEqual(["hr"]);
  });

  it("is a 404 for a member outside a role-restricted table's roles", async () => {
    h.roles = ["finance"];
    h.row = tableRow({ visibleToRolesJson: JSON.stringify(["hr"]) });
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(previewRows).not.toHaveBeenCalled();
  });
});
