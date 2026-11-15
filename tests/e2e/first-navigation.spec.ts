/**
 * E2E spec — the first client-side navigation after a full page load commits.
 *
 * In a production build the first navigation that stays inside the same
 * layout (a table page's "Open as spreadsheet" link, `/tables` -> `/tables?x=1`)
 * used to never commit: the RSC request came back, the URL never changed.
 * Cause: React 19.2's lost render-phase ping (react/react#37805) — the
 * navigation suspends on a streamed Flight row whose then() pings
 * synchronously mid-render, and the ping was dropped. Fixed by
 * scripts/patch-react-render-ping.mjs (postinstall), which backports React's
 * one-expression fix into Next's vendored react-dom.
 *
 * Only meaningful against `next build` + `next start` (dev races differently), e.g.
 *   CURF_E2E_PORT=3106 npx playwright test first-navigation --repeat-each=10
 * Signs in once as the seeded admin; every test then opens its own fresh
 * browser context with those cookies, so nothing (service worker, caches)
 * carries over between runs. Creates a small `first_nav_e2e` table when
 * there isn't one, so it runs on either edition's seed (CURF_E2E_TABLE to use another).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import { SEED_ADMIN } from "./helpers";

// A table of its own (both editions' seeds differ), unless CURF_E2E_TABLE names one.
const TABLE = process.env.CURF_E2E_TABLE ?? "first_nav_e2e";
type State = Awaited<ReturnType<BrowserContext["storageState"]>>;

/**
 * Signed in once per server, kept on disk: Playwright starts a new worker
 * after a failure, and signing in again each time trips the login limit
 * (10 per address per 5 minutes, lib/auth.ts).
 */
async function signedInState(browser: Browser, baseURL: string): Promise<State> {
  const file = path.join(os.tmpdir(), `curf-e2e-first-navigation-${new URL(baseURL).port}.json`);
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as State;
    const probe = await browser.newContext({ baseURL, storageState: saved });
    const who = await probe.request.get("/api/auth/session").then((r) => r.json()).catch(() => null);
    await probe.close();
    if (who?.user?.email === SEED_ADMIN.email) return saved;
  } catch { /* none saved yet, or unreadable: sign in */ }
  const ctx = await browser.newContext({ baseURL });
  const { csrfToken } = await ctx.request.get("/api/auth/csrf").then((r) => r.json());
  await ctx.request.post("/api/auth/callback/credentials", {
    form: { csrfToken, email: SEED_ADMIN.email, password: SEED_ADMIN.password, json: "true" },
    maxRedirects: 0,
  });
  const state = await ctx.storageState();
  await ctx.close();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
  return state;
}

test.beforeAll(async ({ browser, baseURL }) => {
  if (process.env.CURF_E2E_TABLE) return;
  const ctx = await browser.newContext({ baseURL, storageState: await signedInState(browser, baseURL!) });
  try {
    if ((await ctx.request.get(`/api/lake/tables/${TABLE}`)).ok()) return; // kept from an earlier run
    const rows = Array.from({ length: 120 }, (_, i) => ({ order_id: `FN-${i + 1}`, store: ["North", "South"][i % 2]!, revenue: 100 + i }));
    const made = await ctx.request.post("/api/lake/tables", { data: { name: TABLE, rows } });
    expect(made.ok(), await made.text()).toBeTruthy();
  } finally {
    await ctx.close();
  }
});

test("the first link clicked right after load navigates", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, storageState: await signedInState(browser, baseURL!) });
  const page = await ctx.newPage();
  try {
    await page.goto(`/tables/${encodeURIComponent(TABLE)}`);
    expect(new URL(page.url()).pathname, "signed in and on the table page").toBe(`/tables/${TABLE}`);
    // As soon as the link can be clicked — no settling time.
    await page.getByRole("link", { name: /Open as spreadsheet/ }).first().click();
    await expect(page).toHaveURL(/view=sheet/, { timeout: 10_000 });
    await expect(page.locator('[role="grid"]')).toBeVisible({ timeout: 30_000 });
  } finally {
    await ctx.close();
  }
});

test("the first same-page search-param push commits", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, storageState: await signedInState(browser, baseURL!) });
  const page = await ctx.newPage();
  try {
    await page.goto("/tables");
    await page.waitForFunction(() => (window as any).next?.router);
    await page.evaluate(() => (window as any).next.router.push("/tables?first-nav=1"));
    await expect(page).toHaveURL(/first-nav=1/, { timeout: 10_000 });
  } finally {
    await ctx.close();
  }
});
