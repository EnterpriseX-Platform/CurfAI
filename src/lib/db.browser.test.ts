/**
 * Client components used to reach lib/db transitively (UpgradeLock ->
 * lib/billing -> lib/db), so the module was evaluated in the browser with
 * @prisma/client's browser stub: `Prisma.dmmf` is absent and every property
 * access on a PrismaClient throws. Reading Prisma.dmmf at load crashed
 * /ask, /connections, /decisions, /operate/watchers, the report designer
 * and every other page that bundled UpgradeLock or featureGate ("Cannot
 * read properties of undefined (reading 'datamodel')").
 *
 * db.clientBundle.test.ts now keeps lib/db out of client bundles. This test
 * is the second line: if a client import slips past that walk, loading the
 * module in a browser must still do neither.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@prisma/client", () => {
  const browserStub = () =>
    new Proxy({}, {
      get() { throw new Error("PrismaClient is unable to run in this browser environment"); },
    });
  return {
    Prisma: {},
    PrismaClient: function PrismaClient() { return browserStub(); },
  };
});

afterEach(() => vi.unstubAllGlobals());

describe("lib/db in a browser bundle", () => {
  it("loads without touching Prisma's dmmf or the client", async () => {
    vi.stubGlobal("window", {});
    await expect(import("./db")).resolves.toHaveProperty("prisma");
  });
});
