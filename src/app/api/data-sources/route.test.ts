/**
 * BE-CONN-05: a REST data source whose baseUrl pointed at the cloud
 * metadata endpoint (or any private address) saved with 200. Every request
 * to it was already refused at egress by guardedFetch, so nothing could be
 * reached — but the connection was stored in a state that could never work,
 * with no signal to the person who saved it. It's now refused at save time.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn(), requireUser: vi.fn(), tenantWhere: (u: any) => ({ tenantId: u.tenantId }) }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/featureGate", () => ({ featureGate: vi.fn(async () => null) }));

const create = vi.fn(async (...args: any[]) => ({ id: "ds1", ...args[0].data }));
vi.mock("@/lib/db", () => ({ prisma: { dataSource: { create: (...a: any[]) => create(...a) } } }));

import { requireAdmin } from "@/lib/auth";
import { restBaseUrlError } from "@/lib/connections/rest";
import { POST } from "./route";

const post = (body: unknown) =>
  POST(new NextRequest("http://localhost:3100/api/data-sources", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({ id: "u1", tenantId: "t1", role: "admin" } as any);
});

describe("restBaseUrlError", () => {
  it.each([
    ["http://169.254.169.254/latest/meta-data/", /private\/reserved/],
    ["http://10.0.0.5/api", /private\/reserved/],
    ["http://127.0.0.1:8080/", /private\/reserved|localhost/],
    ["http://localhost:3100/", /localhost/],
    ["ftp://files.example.com/", /not allowed/],
    ["not a url", /Invalid URL/],
  ])("refuses %s", async (url, reason) => {
    expect(await restBaseUrlError(url)).toMatch(reason);
  });

  it("allows a public address", async () => {
    expect(await restBaseUrlError("https://93.184.216.34/v1")).toBe("");
  });
});

describe("POST /api/data-sources — REST base URL is checked at save", () => {
  it("refuses the metadata endpoint and stores nothing", async () => {
    const res = await post({ name: "meta", kind: "rest", baseUrl: "http://169.254.169.254/" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues[0].path).toEqual(["baseUrl"]);
    expect(create).not.toHaveBeenCalled();
  });
});
