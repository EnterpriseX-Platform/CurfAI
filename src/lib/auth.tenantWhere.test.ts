/**
 * tenantWhere() is the single primitive every tenant-scoped Prisma query in
 * the app is supposed to spread into its `where` clause. It had no direct
 * test of its own — pin its exact shape here so a future "helpful"
 * refactor (e.g. someone adds a default-tenant fallback, or renames the
 * field) can't silently widen or narrow every caller at once.
 */
import { describe, it, expect } from "vitest";
import { tenantWhere, type CurfSessionUser } from "./auth";

function user(overrides: Partial<CurfSessionUser> = {}): CurfSessionUser {
  return { id: "u1", email: "a@b.com", role: "viewer", tenantId: "t1", ...overrides };
}

describe("tenantWhere", () => {
  it("returns exactly { tenantId } — no other fields", () => {
    expect(tenantWhere(user())).toEqual({ tenantId: "t1" });
    expect(Object.keys(tenantWhere(user()))).toEqual(["tenantId"]);
  });

  it("uses the caller's own tenantId, not a hardcoded or default one", () => {
    expect(tenantWhere(user({ tenantId: "t2" }))).toEqual({ tenantId: "t2" });
    expect(tenantWhere(user({ tenantId: "t1" }))).not.toEqual({ tenantId: "t2" });
  });

  it("ignores role — admin gets the same tenant scoping as viewer/editor", () => {
    const admin = tenantWhere(user({ role: "admin" }));
    const viewer = tenantWhere(user({ role: "viewer" }));
    expect(admin).toEqual(viewer);
  });

  it("scopes identically for API-key-resolved users", () => {
    const apiKeyUser = tenantWhere(user({ viaApiKey: true, id: "apikey:k1" }));
    expect(apiKeyUser).toEqual({ tenantId: "t1" });
  });
});
