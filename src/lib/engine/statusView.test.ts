import { describe, it, expect } from "vitest";
import { hintSettings, splitHint, statusSteps, type StatusInput } from "./statusView";

const base: StatusInput = { ok: true, latencyMs: 42, source: "platform", reachable: true, acceptsIdentity: true, workspaceMatches: true, views: 3 };
const states = (s: StatusInput) => statusSteps(s).map((x) => x.state);

describe("statusSteps", () => {
  it("passes everything when the engine is healthy, with latency and view count", () => {
    const steps = statusSteps(base);
    expect(steps.map((s) => s.state)).toEqual(["pass", "pass", "pass", "pass"]);
    expect(steps[0].value).toBe(42);
    expect(steps[3].value).toBe(3);
  });
  it("fails reachability and does not check the rest", () => {
    expect(states({ ...base, ok: false, reachable: false, acceptsIdentity: false, workspaceMatches: null, views: undefined })).toEqual(["fail", "skipped", "skipped", "skipped"]);
  });
  it("fails the identity step when the engine refuses Curf's token", () => {
    expect(states({ ...base, ok: false, acceptsIdentity: false, workspaceMatches: null, views: undefined })).toEqual(["pass", "fail", "skipped", "skipped"]);
  });
  it("fails the workspace step when the engine put the person elsewhere", () => {
    expect(states({ ...base, ok: false, workspaceMatches: false, views: undefined })).toEqual(["pass", "pass", "fail", "skipped"]);
  });
  it("does not trust a view count after an earlier failure", () => {
    expect(states({ ...base, workspaceMatches: false, views: 5 })[3]).toBe("skipped");
  });
  it("asks for attention, not failure, when there are no views yet", () => {
    expect(states({ ...base, views: 0 })).toEqual(["pass", "pass", "pass", "attention"]);
  });
  it("skips views when the engine did not say", () => {
    expect(states({ ...base, views: undefined })[3]).toBe("skipped");
  });
  it("skips workspace when it is unknown", () => {
    expect(states({ ...base, workspaceMatches: null, views: undefined })).toEqual(["pass", "pass", "skipped", "skipped"]);
  });
});

describe("splitHint", () => {
  it("picks out setting names", () => {
    expect(splitHint("Set CURF_ENGINE_SECURITY_CLAIMS_TENANT to workspace, then restart.")).toEqual([
      { text: "Set ", code: false },
      { text: "CURF_ENGINE_SECURITY_CLAIMS_TENANT", code: true },
      { text: " to workspace, then restart.", code: false },
    ]);
  });
  it("leaves ordinary words and plain capitals alone", () => {
    expect(splitHint("Check the URL and JWKS.")).toEqual([{ text: "Check the URL and JWKS.", code: false }]);
    expect(splitHint("")).toEqual([]);
  });
  it("lists each setting once", () => {
    expect(hintSettings("A_B and A_B and C_D_E")).toEqual(["A_B", "C_D_E"]);
  });
});
