import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  change: null as any, updates: [] as any[], applied: [] as any[], modelExists: true,
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    platformModelChange: {
      findUnique: async () => h.change,
      update: async (a: any) => { h.updates.push(a); },
      updateMany: async () => ({ count: 0 }),
      create: async (a: any) => a.data,
    },
    platformModel: { findUnique: async () => (h.modelExists ? { id: "m1" } : null) },
    platformTierModel: { upsert: async (a: any) => { h.applied.push(a); }, deleteMany: async (a: any) => { h.applied.push({ clear: a.where.tier }); } },
  },
}));
vi.mock("@/lib/llm/platformModels", () => ({ clearPlatformModelCache: () => {} }));

import { mayDecide, decideTierChange } from "./platformTier";

beforeEach(() => { h.change = { id: "c1", tier: "business", platformModelId: "m1", status: "pending", proposedBy: "a@curf.app" }; h.updates = []; h.applied = []; h.modelExists = true; });

describe("mayDecide", () => {
  it("lets another operator approve or reject, never the proposer, and only the proposer withdraw", () => {
    expect(mayDecide("approve", "a@curf.app", "B@curf.app")).toBe(true);
    expect(mayDecide("approve", "a@curf.app", "A@curf.app")).toBe(false);
    expect(mayDecide("reject", "a@curf.app", "a@curf.app")).toBe(false);
    expect(mayDecide("cancel", "a@curf.app", "a@curf.app")).toBe(true);
    expect(mayDecide("cancel", "a@curf.app", "b@curf.app")).toBe(false);
  });
});

describe("decideTierChange", () => {
  it("applies the model only when a second operator approves", async () => {
    expect(await decideTierChange("c1", "approve", "a@curf.app")).toMatchObject({ ok: false, code: 403 });
    expect(h.applied).toEqual([]);
    expect(await decideTierChange("c1", "approve", "b@curf.app")).toEqual({ ok: true, status: "approved" });
    expect(h.applied[0]).toMatchObject({ where: { tier: "business" }, update: { platformModelId: "m1" } });
    expect(h.updates[0].data.status).toBe("approved");
  });
  it("clears the tier when the change was back to the env model", async () => {
    h.change.platformModelId = null;
    await decideTierChange("c1", "approve", "b@curf.app");
    expect(h.applied).toEqual([{ clear: "business" }]);
  });
  it("rejecting or withdrawing changes nothing on the tier", async () => {
    expect(await decideTierChange("c1", "reject", "b@curf.app")).toEqual({ ok: true, status: "rejected" });
    expect(await decideTierChange("c1", "cancel", "a@curf.app")).toEqual({ ok: true, status: "cancelled" });
    expect(h.applied).toEqual([]);
  });
  it("refuses a change already decided, a missing one, and a model that has gone", async () => {
    h.change.status = "approved";
    expect(await decideTierChange("c1", "approve", "b@curf.app")).toMatchObject({ code: 409 });
    h.change = null;
    expect(await decideTierChange("c1", "approve", "b@curf.app")).toMatchObject({ code: 404 });
    h.change = { id: "c1", tier: "business", platformModelId: "m1", status: "pending", proposedBy: "a@curf.app" };
    h.modelExists = false;
    expect(await decideTierChange("c1", "approve", "b@curf.app")).toMatchObject({ code: 409 });
    expect(h.updates).toEqual([]);
  });
});
