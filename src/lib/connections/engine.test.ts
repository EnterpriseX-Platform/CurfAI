import { afterEach, describe, expect, it } from "vitest";
import {
  decodeEngineConnection,
  encodeEngineConnection,
  engineBaseUrlError,
  maskEngineConnectionForClient,
  resolveEngineTarget,
} from "./engine";

const saved = { url: process.env.CURF_ENGINE_URL, hosts: process.env.CURF_ENGINE_ALLOWED_HOSTS };
afterEach(() => {
  for (const [name, value] of [["CURF_ENGINE_URL", saved.url], ["CURF_ENGINE_ALLOWED_HOSTS", saved.hosts]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("engine connection", () => {
  it("round-trips, trims, and stores nothing when blank", () => {
    expect(decodeEngineConnection(encodeEngineConnection({ baseUrl: " https://engine.example/ ", audience: " eng " })))
      .toEqual({ baseUrl: "https://engine.example", audience: "eng" });
    expect(encodeEngineConnection({ baseUrl: "  ", audience: "" })).toBe("{}");
  });

  it("holds no secret: the stored JSON is only the URL and audience", () => {
    const json = encodeEngineConnection({ baseUrl: "https://engine.example", audience: "x" });
    expect(Object.keys(JSON.parse(json)).sort()).toEqual(["audience", "baseUrl"]);
  });

  it("masks for the client and says when the platform's engine is used", () => {
    expect(maskEngineConnectionForClient("{}")).toEqual({ baseUrl: "", audience: "", usesPlatformEngine: true });
    expect(maskEngineConnectionForClient('{"baseUrl":"https://e.example"}').usesPlatformEngine).toBe(false);
  });

  it("uses the workspace's own engine first, then the platform's, and says when there is neither", () => {
    delete process.env.CURF_ENGINE_URL;
    expect(() => resolveEngineTarget({})).toThrow(/No engine URL/);
    process.env.CURF_ENGINE_URL = "https://platform.example/";
    expect(resolveEngineTarget({})).toEqual({ baseUrl: "https://platform.example", audience: undefined, source: "platform" });
    expect(resolveEngineTarget({ baseUrl: "https://own.example", audience: "a" })).toEqual({ baseUrl: "https://own.example", audience: "a", source: "workspace" });
  });
});

describe("engine URL policy for a workspace's own URL", () => {
  it("refuses what the SSRF guard refuses: loopback, private ranges, cloud metadata", async () => {
    delete process.env.CURF_ENGINE_ALLOWED_HOSTS;
    for (const url of ["http://127.0.0.1:8080", "http://localhost:8080", "http://10.0.0.5", "http://192.168.1.10", "http://169.254.169.254/latest"]) {
      expect(await engineBaseUrlError(url), url).not.toBe("");
    }
  });

  it("refuses non-http schemes, credentials in the URL, and nonsense", async () => {
    expect(await engineBaseUrlError("file:///etc/passwd")).toMatch(/http/);
    expect(await engineBaseUrlError("https://user:pw@engine.example")).toMatch(/credentials/);
    expect(await engineBaseUrlError("not a url")).toMatch(/valid URL/);
  });

  it("allows a public address", async () => {
    expect(await engineBaseUrlError("http://93.184.216.34:8080")).toBe("");
  });

  it("lets an internal host through only when the operator allow-listed that host", async () => {
    expect(await engineBaseUrlError("http://engine.internal:8080")).not.toBe("");
    process.env.CURF_ENGINE_ALLOWED_HOSTS = "Other.internal, ENGINE.internal";
    expect(await engineBaseUrlError("http://engine.internal:8080")).toBe("");
    expect(await engineBaseUrlError("http://not-listed.internal:8080")).not.toBe("");
  });
});
