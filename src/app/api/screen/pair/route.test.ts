import { describe, it, expect, vi, beforeEach } from "vitest";

const updateMany = vi.fn();
const findUnique = vi.fn();
const createToken = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { onScreenPairingCode: { updateMany: (a: any) => updateMany(a), findUnique: (a: any) => findUnique(a) }, onScreenDisplayKioskToken: { create: (a: any) => createToken(a) } },
}));
vi.mock("@/lib/dbContext", () => ({ withSystemDbContext: (fn: any) => fn() }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
const closed = vi.hoisted(() => new Set<string>());
vi.mock("@/lib/tenantGuard", () => ({ tenantIsOpen: async (id: string) => !closed.has(id), closedTenantIds: async () => [...closed], forgetTenantStatus: () => {} }));

import { POST } from "./route";
import { hashPairingCode } from "@/lib/onScreen/pairing";

let ipN = 0;
function call(body: unknown) {
  // A fresh address per call keeps the per-address limiter out of the way.
  return POST(new Request("http://x/api/screen/pair", { method: "POST", headers: { "x-forwarded-for": `198.51.100.${++ipN}` }, body: JSON.stringify(body) }) as any);
}

beforeEach(() => { updateMany.mockReset(); findUnique.mockReset(); createToken.mockReset(); closed.clear(); });

describe("POST /api/screen/pair", () => {
  it("refuses a malformed code without touching the database", async () => {
    const r = await call({ code: "nope" });
    expect(r.status).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("claims by hash, only if unused and unexpired, then hands back a kiosk link", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    findUnique.mockResolvedValue({ id: "pc1", tenantId: "t1", createdById: "u1", onScreen: { id: "d1", name: "Lobby", slug: "lobby" } });
    createToken.mockResolvedValue({ id: "k1" });
    const r = await call({ code: "abcd-efgh" });
    expect(r.status).toBe(200);
    const where = updateMany.mock.calls[0][0].where;
    expect(where.codeHash).toBe(hashPairingCode("ABCDEFGH"));
    expect(where.usedAt).toBeNull();
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
    const j = await r.json();
    expect(j.kioskUrl).toMatch(/^\/on-screen\/lobby\/kiosk\?token=[\w-]{43}$/);
    expect(createToken.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", onScreenId: "d1" });
  });

  it("a closed workspace's live code gets the same refusal as an invalid one, and no kiosk token is minted", async () => {
    closed.add("t1");
    updateMany.mockResolvedValue({ count: 1 });
    findUnique.mockResolvedValue({ id: "pc1", tenantId: "t1", createdById: "u1", onScreen: { id: "d1", name: "Lobby", slug: "lobby" } });
    const r = await call({ code: "abcd-efgh" });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "That code is not valid or has expired." });
    expect(createToken).not.toHaveBeenCalled();
  });

  it("a code that was already claimed (or expired) gets nothing", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    const r = await call({ code: "ABCDEFGH" });
    expect(r.status).toBe(400);
    expect(createToken).not.toHaveBeenCalled();
  });

  it("limits attempts per address", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    const same = () => POST(new Request("http://x/api/screen/pair", { method: "POST", headers: { "x-forwarded-for": "203.0.113.77" }, body: JSON.stringify({ code: "ABCDEFGH" }) }) as any);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await same()).status);
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
