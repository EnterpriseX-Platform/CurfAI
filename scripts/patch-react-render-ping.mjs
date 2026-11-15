/**
 * Backport React's fix for a lost render-phase ping into the react-dom that
 * Next.js vendors (next/dist/compiled/react-dom*), run from `postinstall`.
 *
 * The bug (react/react#37805, #37830; fixed upstream by react/react#36134,
 * React 19.3 / Next 16.3): a transition that suspends on a Flight chunk in the
 * `resolved_model` state calls chunk.then(ping, ping), which initialises the
 * chunk and calls ping synchronously, still inside the render. If the root is
 * already "suspended with delay" at that moment, React 19.2's pingSuspendedRoot
 * skips prepareFreshStack (we're rendering) and records nothing, so the render
 * ends suspended with no listener left and the transition never commits.
 *
 * In Curf that was the first client-side navigation on a page whose RSC
 * payload streams in more than one network chunk (a table page, an
 * `?view=sheet` toggle): the request came back, the URL never changed, and
 * any later navigation worked. Next 15.5.29, the last 15.x, still ships
 * 19.2.0-canary-0bdb9206-20250818 with the bug.
 *
 * The fix is upstream's one expression: when the ping lands during the render,
 * record it in workInProgressRootPingedLanes instead of dropping it.
 *   before:  ? 0 === (executionContext & 2) && prepareFreshStack(root, 0)
 *            : (workInProgressRootPingedLanes |= pingedLanes),
 *   after:   ? 0 === (executionContext & 2) ? prepareFreshStack(root, 0) : (workInProgressRootPingedLanes |= pingedLanes)
 *            : (workInProgressRootPingedLanes |= pingedLanes),
 *
 * Idempotent. A file that already has the fixed shape is left alone; a Next
 * whose react-dom has neither shape (an upgrade that carries the fix) only
 * prints a note — tests/unit/react-render-ping.test.ts fails while any
 * vendored react-dom still has the unfixed shape. Remove this script, its
 * postinstall entry and that test once Next is on React 19.3+.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** Production/profiling builds use `0 === (executionContext & 2)`, development `(executionContext & RenderContext) === NoContext`. */
export const UNFIXED =
  /(0 === \(executionContext & 2\)|\(executionContext & RenderContext\) === NoContext)\s*&&\s*(prepareFreshStack\(root, 0\))(\s*:\s*\(workInProgressRootPingedLanes \|= pingedLanes\))/g;
const FIXED_MARK = "prepareFreshStack(root, 0) : (workInProgressRootPingedLanes |= pingedLanes)";

export function patchSource(code) {
  return code.replace(UNFIXED, "$1 ? $2 : (workInProgressRootPingedLanes |= pingedLanes)$3");
}

/** Every vendored react-dom CommonJS build under next/dist/compiled. */
export function reactDomFiles() {
  let nextDir;
  try { nextDir = path.dirname(require.resolve("next/package.json")); } catch { return []; }
  const compiled = path.join(nextDir, "dist", "compiled");
  if (!existsSync(compiled)) return [];
  return readdirSync(compiled)
    .filter((d) => d === "react-dom" || d.startsWith("react-dom-"))
    .flatMap((d) => {
      const cjs = path.join(compiled, d, "cjs");
      return existsSync(cjs) ? readdirSync(cjs).filter((f) => f.endsWith(".js")).map((f) => path.join(cjs, f)) : [];
    });
}

function main() {
  const files = reactDomFiles();
  if (files.length === 0) { console.log("[patch-react-render-ping] next not installed; nothing to do"); return; }
  let patched = 0, already = 0;
  for (const file of files) {
    const code = readFileSync(file, "utf8");
    const next = patchSource(code);
    if (next !== code) { writeFileSync(file, next); patched++; }
    else if (code.includes(FIXED_MARK)) already++;
  }
  if (patched + already === 0) console.log("[patch-react-render-ping] no vendored react-dom has the unfixed ping branch; this script can go");
  else console.log(`[patch-react-render-ping] patched ${patched} react-dom build(s), ${already} already patched`);
  // Webpack's persistent cache treats node_modules as immutable per package
  // version, so a build on an existing checkout would keep the unpatched
  // react-dom. Drop this project's webpack cache when something changed.
  const webpackCache = path.join(process.cwd(), ".next", "cache", "webpack");
  if (patched > 0 && existsSync(webpackCache)) {
    rmSync(webpackCache, { recursive: true, force: true });
    console.log("[patch-react-render-ping] cleared .next/cache/webpack so the next build picks it up");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
