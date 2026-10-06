/**
 * The designer ran its initial preview dataset with no viewer, which the
 * runner treats as the system: a developer opening a report in the editor
 * saw rows from role-restricted and owner-only sources, and unredacted lake
 * columns, that the viewer page and the designer's own Run button hid from
 * them. It now runs as the builder, via exportViewer(user).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ session: null as any, roles: [] as string[] }));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  redirect: vi.fn((to: string) => { throw new Error("NEXT_REDIRECT " + to); }),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    report: { findFirst: vi.fn() },
    tenant: { findUnique: vi.fn(async () => ({ brandJson: "{}" })) },
  },
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getSession: vi.fn(async () => h.session), getUserRoles: vi.fn(async () => h.roles) };
});
vi.mock("@/lib/reporting/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reporting/runner")>()),
  runReport: vi.fn(async () => ({})),
}));
vi.mock("./DesignerShell", () => ({ DesignerShell: () => null }));

import { prisma } from "@/lib/db";
import { runReport } from "@/lib/reporting/runner";
import EditorPage from "./page";

const DEFINITION = JSON.stringify({
  version: 1, name: "Sales", parameters: [], dataSources: [],
  pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [] }],
});
const edit = () => EditorPage({ params: { id: "r1" } }) as Promise<any>;
const ranAs = () => vi.mocked(runReport).mock.calls[0][0].viewer;

beforeEach(() => {
  vi.clearAllMocks();
  h.session = null;
  h.roles = [];
  vi.mocked(prisma.report.findFirst).mockResolvedValue({ id: "r1", tenantId: "t1", definition: DEFINITION } as any);
});

describe("designer page — who the initial preview runs as", () => {
  it("a developer's preview runs as them, with their custom roles and no admin bypass", async () => {
    h.session = { user: { id: "u-dev", email: "d@test.dev", role: "developer", tenantId: "t1" } };
    h.roles = ["finance"];
    await edit();
    expect(runReport).toHaveBeenCalledTimes(1);
    expect(ranAs()).toEqual({ id: "u-dev", isAdmin: false, roles: ["finance"] });
    expect(vi.mocked(prisma.report.findFirst).mock.calls[0][0]).toMatchObject({ where: { id: "r1", tenantId: "t1" } });
  });

  it("an admin's preview runs as an admin", async () => {
    h.session = { user: { id: "u-admin", email: "a@test.dev", role: "admin", tenantId: "t1" } };
    await edit();
    expect(ranAs()).toEqual({ id: "u-admin", isAdmin: true, roles: [] });
  });
});
