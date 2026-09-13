/**
 * Vitest config for Curf — runs alongside Next.js without conflicting with
 * the dev server.
 *
 * What's tested here:
 *   - Pure functions in lib/* (no React, no Prisma, no network)
 *   - Integration tests in tests/audit (use a real Prisma client against
 *     an ephemeral SQLite DB — opt-in via VITEST_INTEGRATION=1)
 *
 * Why two-tier: the unit-test suite must stay fast (sub-second) so devs
 * actually run it locally. Integration tests cost more and run on CI.
 */
import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  // Chart renderer modules (src/components/blocks/charts/*.tsx) rely on
  // Next's automatic JSX runtime and don't import React themselves — match
  // that here so a renderer can be unit-tested directly (renderToStaticMarkup)
  // instead of every test needing its own React import shim.
  esbuild: {
    jsx: "automatic",
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["node_modules", ".next", "dist", "tests/e2e/**"],
    // Each test file owns its own state; no shared fixtures.
    isolate: true,
    pool: "forks",
    // Coverage opt-in. Run `vitest run --coverage` to see line-by-line.
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/lib/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts", "src/lib/db.ts"],
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
});
