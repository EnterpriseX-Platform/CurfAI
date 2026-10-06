/**
 * No "use client" module may reach lib/db.ts through its imports.
 *
 * Whatever a client component imports ships to the browser, transitively.
 * UpgradeLock and featureGate used to reach lib/db through lib/billing, so
 * Prisma's browser stub and db.ts's server code went out with fourteen
 * client modules — and when db.ts read Prisma.dmmf at load, every page that
 * bundled them crashed ("Cannot read properties of undefined (reading
 * 'datamodel')"). db.browser.test.ts keeps db.ts inert if it is loaded in a
 * browser anyway; this test keeps it from getting there. Client code takes
 * plans and gates from lib/plans.ts and lib/featureTiers.ts, which carry no
 * server imports; lib/billing.ts and lib/featureGate.ts re-export them for
 * the server.
 *
 * The same walk keeps the dictionaries out: lib/i18n/dict.ts and the
 * messages/<locale>.ts files it loads hold every language, 1.6 MB, and a page
 * gets only its reader's language from /i18n/<locale> (messageStore.ts).
 *
 * The walk follows what webpack follows: static imports and re-exports that
 * aren't type-only, plus import() and require(), resolved through the `@/`
 * alias and relative paths. Packages are leaves. It over-counts one case —
 * a plain import whose bindings are only used as types, which the compiler
 * would drop — and the fix for that is to write it as `import type`.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const SRC = path.resolve(__dirname, "..");
const DB = path.join(SRC, "lib", "db.ts");
const DICTIONARIES = ["dict.ts", "messages/en.ts", "messages/th.ts", "messages/zh.ts"].map((f) => path.join(SRC, "lib", "i18n", f));
const CODE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

const rel = (file: string) => path.relative(path.dirname(SRC), file).replace(/\\/g, "/");

function parse(code: string, fileName: string): ts.SourceFile {
  const kind = /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, false, kind);
}

/** Specifiers a module loads at runtime — everything but type-only imports and re-exports. */
function runtimeImports(code: string, fileName = "module.tsx"): string[] {
  const sf = parse(code, fileName);
  const out: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const clause = stmt.importClause;
      const named = clause?.namedBindings;
      const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!named && ts.isNamedImports(named)
        && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly)));
      if (!typeOnly) out.push((stmt.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
      const clause = stmt.exportClause;
      const typeOnly = stmt.isTypeOnly || (!!clause && ts.isNamedExports(clause)
        && clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) out.push((stmt.moduleSpecifier as ts.StringLiteral).text);
    }
  }
  if (/\b(import|require)\s*\(/.test(code)) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        out.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

function hasUseClient(code: string, fileName: string): boolean {
  for (const stmt of parse(code, fileName).statements) {
    if (!ts.isExpressionStatement(stmt) || !ts.isStringLiteral(stmt.expression)) return false;
    if (stmt.expression.text === "use client") return true;
  }
  return false;
}

const isFile = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

/** A file under src/, `undefined` for a package, `null` for a local path that doesn't resolve. */
function resolveLocal(spec: string, fromFile: string): string | null | undefined {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return undefined;
  const candidates = [base, ...CODE_EXTS.map((e) => base + e), ...CODE_EXTS.map((e) => path.join(base, "index" + e))];
  return candidates.find(isFile) ?? null;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(p, out);
    else if (CODE_EXTS.includes(path.extname(entry.name))) out.push(p);
  }
  return out;
}

/** Import graph over src/, built lazily from the files a walk actually visits. */
function importGraph() {
  const edges = new Map<string, string[]>();
  const unresolved: string[] = [];
  const importsOf = (file: string): string[] => {
    let next = edges.get(file);
    if (next) return next;
    next = [];
    // Stylesheets, JSON and other assets are leaves.
    if (CODE_EXTS.includes(path.extname(file))) {
      for (const spec of runtimeImports(fs.readFileSync(file, "utf8"), file)) {
        const target = resolveLocal(spec, file);
        if (target) next.push(target);
        else if (target === null) unresolved.push(`${rel(file)} -> ${spec}`);
      }
    }
    edges.set(file, next);
    return next;
  };
  /** Shortest import chain from `root` to `target`, or null. */
  const chain = (root: string, target: string): string[] | null => {
    const parent = new Map<string, string | null>([[root, null]]);
    const queue = [root];
    while (queue.length) {
      const file = queue.shift()!;
      if (file === target) {
        const out: string[] = [];
        for (let f: string | null = file; f; f = parent.get(f) ?? null) out.unshift(rel(f));
        return out;
      }
      for (const dep of importsOf(file)) {
        if (!parent.has(dep)) { parent.set(dep, file); queue.push(dep); }
      }
    }
    return null;
  };
  return { chain, unresolved };
}

describe("runtimeImports", () => {
  it("keeps value imports, re-exports, import() and require(), and drops type-only ones", () => {
    const code = `
      "use client";
      import type { A } from "type-only";
      import { type B, type C } from "all-inline-types";
      export type { D } from "type-reexport";
      export { type E } from "inline-type-reexport";
      import { type F, g } from "mixed";
      import h from "default";
      import * as ns from "namespace";
      import "side-effect";
      export { i } from "reexport";
      export * from "star";
      const lazy = () => import("dynamic");
      const legacy = require("required");
    `;
    expect(runtimeImports(code)).toEqual([
      "mixed", "default", "namespace", "side-effect", "reexport", "star", "dynamic", "required",
    ]);
  });

  it("recognises the directive only in the prologue", () => {
    expect(hasUseClient(`// header\n/** doc */\n"use client";\nimport x from "y";`, "a.tsx")).toBe(true);
    expect(hasUseClient(`"use strict";\n'use client';`, "a.ts")).toBe(true);
    expect(hasUseClient(`import x from "y";\n"use client";`, "a.tsx")).toBe(false);
    expect(hasUseClient(`const s = "use client";`, "a.ts")).toBe(false);
  });
});

const clientModules = () => sourceFiles(SRC).filter((f) => {
  const code = fs.readFileSync(f, "utf8");
  return code.includes("use client") && hasUseClient(code, f);
});

describe("lib/db stays out of client bundles", () => {
  it("no \"use client\" module imports lib/db.ts, directly or transitively", () => {
    const roots = clientModules();
    const graph = importGraph();

    // Guards the guard: a broken walk would make every client module look clean.
    expect(roots.length).toBeGreaterThan(100);
    expect(graph.chain(path.join(SRC, "lib", "billing.ts"), DB)).not.toBeNull();

    const leaks = roots.flatMap((root) => {
      const found = graph.chain(root, DB);
      return found ? [found.join("\n    -> ")] : [];
    });
    expect(graph.unresolved, "local imports the walk could not resolve").toEqual([]);
    expect(leaks, `client modules that bundle lib/db.ts:\n  ${leaks.join("\n  ")}\n`).toEqual([]);
  }, 60_000);
});

describe("the dictionaries stay out of client bundles", () => {
  it("no \"use client\" module imports lib/i18n/dict.ts or messages/, directly or transitively", () => {
    const roots = clientModules();
    const graph = importGraph();

    // Guards the guard: the server's own path to the words is still seen.
    expect(graph.chain(path.join(SRC, "app", "i18n", "[locale]", "route.ts"), DICTIONARIES[2]!)).not.toBeNull();

    const leaks = roots.flatMap((root) => DICTIONARIES.flatMap((target) => {
      const found = graph.chain(root, target);
      return found ? [found.join("\n    -> ")] : [];
    }));
    expect(leaks, `client modules that bundle the dictionaries:\n  ${leaks.join("\n  ")}\n`).toEqual([]);
  }, 60_000);
});
