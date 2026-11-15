/**
 * The vendored react-dom carries React's render-phase ping fix
 * (scripts/patch-react-render-ping.mjs, run from postinstall). Without it the
 * first client-side navigation on a page whose RSC payload streams in more
 * than one chunk can suspend forever in a production build.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { patchSource, reactDomFiles, UNFIXED } from "../../scripts/patch-react-render-ping.mjs";

const PROD = `(4 === workInProgressRootExitStatus ||
      (3 === workInProgressRootExitStatus &&
        300 > now() - globalMostRecentFallbackTime)
      ? 0 === (executionContext & 2) && prepareFreshStack(root, 0)
      : (workInProgressRootPingedLanes |= pingedLanes),`;
const DEV = `(4 === workInProgressRootExitStatus ||
          300 > now$1() - globalMostRecentFallbackTime)
          ? (executionContext & RenderContext) === NoContext &&
            prepareFreshStack(root, 0)
          : (workInProgressRootPingedLanes |= pingedLanes),`;

describe("react render-phase ping patch", () => {
  it("records the ping instead of dropping it, in both build shapes", () => {
    for (const src of [PROD, DEV]) {
      const out = patchSource(src);
      expect(out).toContain("? prepareFreshStack(root, 0) : (workInProgressRootPingedLanes |= pingedLanes)");
      expect(out).not.toMatch(/&&\s*prepareFreshStack\(root, 0\)/);
      expect(patchSource(out)).toBe(out); // idempotent
    }
  });

  it("leaves unrelated prepareFreshStack calls alone", () => {
    const other = "exitStatus === RootDidNotComplete && prepareFreshStack(root, 0);";
    expect(patchSource(other)).toBe(other);
  });

  it("every installed vendored react-dom build is patched", () => {
    const files: string[] = reactDomFiles();
    expect(files.length).toBeGreaterThan(0);
    const unpatched = files.filter((f) => { UNFIXED.lastIndex = 0; return UNFIXED.test(readFileSync(f, "utf8")); });
    expect(unpatched, "run `node scripts/patch-react-render-ping.mjs` (postinstall does)").toEqual([]);
  });
});
