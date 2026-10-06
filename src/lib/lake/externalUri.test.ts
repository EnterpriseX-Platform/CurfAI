/**
 * Live finding: POST /api/lake/external-tables accepted
 * `http://169.254.169.254/latest/meta-data/` and `/var/lib/curf/secret.parquet`
 * with a 200 and no guard of any kind, then handed the URI to
 * probeExternalSchema — which fetches it. Registering a table was a
 * server-side request the tenant aimed, and a read of the server's own disk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/security/ssrfGuard", () => ({
  assertPublicHttpUrl: vi.fn(),
}));

import { assertPublicHttpUrl } from "@/lib/security/ssrfGuard";
import { validateExternalUri } from "./externalUri";

const ROOT = process.env.CURF_EXTERNAL_TABLE_ROOT;
beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CURF_EXTERNAL_TABLE_ROOT;
  (assertPublicHttpUrl as any).mockResolvedValue(undefined);
});
afterEach(() => {
  if (ROOT === undefined) delete process.env.CURF_EXTERNAL_TABLE_ROOT;
  else process.env.CURF_EXTERNAL_TABLE_ROOT = ROOT;
});

describe("http(s) URIs go through the SSRF guard", () => {
  it("rejects a URL the guard refuses, quoting its reason", async () => {
    (assertPublicHttpUrl as any).mockRejectedValue(
      new Error("Refusing to connect to private/reserved address 169.254.169.254"),
    );
    const err = await validateExternalUri("parquet", "http://169.254.169.254/latest/meta-data/");
    expect(err).toMatch(/private\/reserved/);
  });

  it("guards csv_url and json_url too, not just parquet", async () => {
    (assertPublicHttpUrl as any).mockRejectedValue(new Error("nope"));
    expect(await validateExternalUri("csv_url", "http://127.0.0.1/x.csv")).toBe("nope");
    expect(await validateExternalUri("json_url", "http://10.0.0.5/x.json")).toBe("nope");
  });

  it("accepts a public URL and actually calls the guard", async () => {
    expect(await validateExternalUri("parquet", "https://data.example.com/t.parquet")).toBe("");
    expect(assertPublicHttpUrl).toHaveBeenCalledWith("https://data.example.com/t.parquet");
  });

  it("leaves object-store URIs to the storage layer's own credentials", async () => {
    expect(await validateExternalUri("parquet", "s3://bucket/t.parquet")).toBe("");
    expect(await validateExternalUri("iceberg", "abfss://c@a.dfs.core.windows.net/t")).toBe("");
    expect(assertPublicHttpUrl).not.toHaveBeenCalled();
  });
});

describe("local filesystem paths are opt-in and contained", () => {
  it("refuses any absolute path when no root is configured", async () => {
    const err = await validateExternalUri("parquet", "/etc/passwd");
    expect(err).toMatch(/not enabled on this deployment/);
  });

  it("allows a path inside the configured root", async () => {
    process.env.CURF_EXTERNAL_TABLE_ROOT = "/data/lake";
    expect(await validateExternalUri("parquet", "/data/lake/sales.parquet")).toBe("");
  });

  it("refuses a path outside the configured root", async () => {
    process.env.CURF_EXTERNAL_TABLE_ROOT = "/data/lake";
    expect(await validateExternalUri("parquet", "/etc/passwd")).toMatch(/must sit under/);
  });

  it("refuses a sibling directory that merely shares the root's prefix", async () => {
    process.env.CURF_EXTERNAL_TABLE_ROOT = "/data";
    expect(await validateExternalUri("parquet", "/data-secrets/creds.parquet")).toMatch(/must sit under/);
  });

  it("refuses a traversal that climbs out of the root", async () => {
    process.env.CURF_EXTERNAL_TABLE_ROOT = "/data/lake";
    expect(await validateExternalUri("parquet", "/data/lake/../../etc/passwd")).toMatch(/must sit under/);
  });
});

describe("shape rules still hold", () => {
  it("rejects a scheme nobody supports", async () => {
    expect(await validateExternalUri("parquet", "file:///etc/passwd")).toMatch(/must start with/);
    expect(await validateExternalUri("parquet", "ftp://h/x.parquet")).toMatch(/must start with/);
  });

  it("rejects a non-http URI for csv_url", async () => {
    expect(await validateExternalUri("csv_url", "s3://bucket/x.csv")).toMatch(/must use http/);
  });
});
