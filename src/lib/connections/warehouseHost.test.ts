/**
 * SEC-10 (audit 2026-09-27): Postgres/MySQL hosts had no SSRF check, so on
 * the hosted edition a workspace could point a source at Curf's own internal
 * network. Refused on cloud; a self-hosted Community install keeps reaching
 * its own private warehouses.
 */
import { describe, it, expect, vi } from "vitest";

const edition = vi.hoisted(() => ({ value: "cloud" as "cloud" | "community" }));
vi.mock("@/lib/ee/edition", () => ({ get EDITION() { return edition.value; } }));

import { assertWarehouseHost } from "./warehouseHost";

describe("assertWarehouseHost", () => {
  it("refuses private, loopback and metadata hosts on the cloud edition", async () => {
    edition.value = "cloud";
    for (const host of ["127.0.0.1", "10.0.0.5", "localhost", "169.254.169.254", "::1"]) {
      await expect(assertWarehouseHost(host)).rejects.toThrow();
    }
  });

  it("allows a public host on the cloud edition", async () => {
    edition.value = "cloud";
    await expect(assertWarehouseHost("8.8.8.8")).resolves.toBeUndefined();
  });

  it("lets a self-hosted Community install reach its own private network", async () => {
    edition.value = "community";
    await expect(assertWarehouseHost("10.0.0.5")).resolves.toBeUndefined();
  });
});
