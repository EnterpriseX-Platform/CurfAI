/**
 * The refusals of the pinned connection, against the real address guard. The point of pinning: the address that
 * is checked is the address the socket connects to, so a DNS record that answers differently the second time
 * has nothing to flip.
 */
import dns from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pinnedPublicFetch, publicOnlyLookup } from "./pinnedFetch";

afterEach(() => vi.restoreAllMocks());

const lookupVia = (answers: dns.LookupAddress[] | Error, options: any = {}) => {
  vi.spyOn(dns, "lookup").mockImplementation(((_h: string, _o: any, cb: any) => (answers instanceof Error ? cb(answers) : cb(null, answers))) as any);
  return new Promise<{ err: any; address?: any; family?: number }>((resolve) =>
    publicOnlyLookup("engine.example", options, (err: any, address: any, family: number) => resolve({ err, address, family })));
};

describe("publicOnlyLookup", () => {
  it("hands the checked address to the socket, as a single address or, when asked, a list", async () => {
    const answers = [{ address: "93.184.216.34", family: 4 }];
    expect(await lookupVia(answers)).toEqual({ err: null, address: "93.184.216.34", family: 4 });
    expect((await lookupVia(answers, { all: true })).address).toEqual(answers);
  });

  it.each(["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.9", "169.254.169.254", "100.64.0.1", "0.0.0.0"])(
    "refuses a name that resolves to %s", async (address) => {
      const { err } = await lookupVia([{ address, family: 4 }]);
      expect(err?.code).toBe("ESSRF");
      expect(err.message).toContain(address);
    });

  it("refuses private IPv6 addresses", async () => {
    for (const address of ["::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"]) {
      expect((await lookupVia([{ address, family: 6 }])).err?.code, address).toBe("ESSRF");
    }
  });

  it("refuses a name when ANY of its answers is private, not only the first", async () => {
    const { err } = await lookupVia([{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }]);
    expect(err?.code).toBe("ESSRF");
  });

  it("refuses a name that resolves to nothing, and passes a lookup failure on", async () => {
    expect((await lookupVia([])).err?.code).toBe("ESSRF");
    const failure = Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    expect((await lookupVia(failure)).err).toBe(failure);
  });
});

describe("pinnedPublicFetch refuses before it connects", () => {
  it.each([
    "http://127.0.0.1:8080/", "http://localhost:8080/", "http://LOCALHOST/", "http://[::1]:8080/", "http://10.1.2.3/",
    "http://169.254.169.254/latest/meta-data", "http://192.168.0.1/", "http://[fd00::1]/", "http://0.0.0.0/",
  ])("%s", async (url) => {
    await expect(pinnedPublicFetch(url)).rejects.toMatchObject({ code: "ESSRF" });
  });

  it("refuses a scheme that is not http(s), and a URL that is not a URL", async () => {
    await expect(pinnedPublicFetch("file:///etc/passwd")).rejects.toMatchObject({ code: "ESSRF" });
    await expect(pinnedPublicFetch("gopher://93.184.216.34")).rejects.toMatchObject({ code: "ESSRF" });
    await expect(pinnedPublicFetch("not a url")).rejects.toMatchObject({ code: "ESSRF" });
  });

  it("refuses a hostname whose lookup is private, through the real request path", async () => {
    vi.spyOn(dns, "lookup").mockImplementation(((_h: string, _o: any, cb: any) => cb(null, [{ address: "127.0.0.1", family: 4 }])) as any);
    await expect(pinnedPublicFetch("http://rebind.example/")).rejects.toMatchObject({ code: "ESSRF" });
  });
});
