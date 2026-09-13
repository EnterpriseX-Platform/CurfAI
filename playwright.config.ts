/**
 * Playwright config — Curf E2E suite.
 *
 * Each spec codifies a journey we manually verified during the pre-launch
 * QA waves. Run locally:
 *   npm run test:e2e          # headless run
 *   npm run test:e2e:ui       # Playwright UI explorer
 *
 * Specs target the same Next.js dev server the user runs locally
 * (`npm run dev` on :3100). In CI, .github/workflows/e2e.yml seeds a
 * fresh test DB and starts the server before invoking Playwright.
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = process.env.CURF_E2E_PORT ?? "3100";
const BASE_URL = process.env.CURF_E2E_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false, // tenant-scoped tests share a DB; serialise to avoid race
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Single worker locally too — tests share a dev DB + a single next-auth
  // server-side session map, and 2-worker runs surface 401s on auth-sensitive
  // endpoints (master-builder/plan, master-builder/apply). Slower but reliable.
  workers: 1,
  reporter: process.env.CI
    ? [["html", { open: "never" }], ["github"]]
    : [["html", { open: "never" }], ["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: process.env.CURF_E2E_AUTOSTART === "1" ? {
    command: "npm run dev",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  } : undefined,
});
