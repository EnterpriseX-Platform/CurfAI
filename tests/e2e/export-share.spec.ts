/**
 * E2E spec — Wave A (export + share).
 *
 * For a freshly-signed-up tenant (which auto-runs provisionStarterPack):
 *   1. Pick the first report from /api/reports
 *   2. For each format (pdf, xlsx, docx, csv) hit
 *      /api/reports/:id/export/:format and assert the response is 2xx
 *      with the right Content-Type and a non-trivial body
 *   3. Mint a public share token via POST /api/reports/:id/share
 *   4. Open /share/:token from a fresh page context (no cookies) and
 *      assert the public viewer renders without bouncing to /login
 *
 * If this spec ever fails, the demo flow that converts on the
 * marketing site ("export this PDF, send the link to your boss") is
 * broken — that's the most direct revenue path we have today.
 */
import { test, expect } from "@playwright/test";
import { signupTenant, signIn } from "./helpers";

const FORMAT_CONTENT_TYPES: Record<string, RegExp> = {
  pdf: /^application\/pdf/,
  xlsx: /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/,
  docx: /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/,
  csv: /^text\/csv/,
};

test.describe("Export + share (Wave A)", () => {
  let email: string;
  let password: string;

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now().toString(36);
    email = `export-${stamp}@tenantx.test`;
    password = "ExportPass" + stamp;
    await signupTenant(request, {
      workspace: `Export Test ${stamp}`,
      email,
      password,
    });
  });

  test("all four export formats return 2xx with correct content-type and body", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, email, password);
    const reports = await page.request.get("/api/reports").then((r) => r.json());
    let items: any[] = reports.items ?? reports;
    if (!items.length) {
      await page.evaluate(async () => {
        await fetch("/api/reports", { method: "POST" });
      });
      const list2 = await page.request.get("/api/reports").then((r) => r.json());
      items = list2.items ?? list2;
    }
    if (!items.length) throw new Error("Failed to create a report via POST /api/reports");
    const reportId: string = items[0].id;
    expect(reportId).toBeTruthy();

    for (const [format, ctRe] of Object.entries(FORMAT_CONTENT_TYPES)) {
      const r = await page.request.get(`/api/reports/${reportId}/export/${format}`);
      expect(r.status(), `${format} export status`).toBeGreaterThanOrEqual(200);
      expect(r.status(), `${format} export status`).toBeLessThan(300);
      const ct = r.headers()["content-type"] ?? "";
      expect(ct, `${format} content-type`).toMatch(ctRe);
      const buf = await r.body();
      expect(buf.length, `${format} body length`).toBeGreaterThan(100);
    }
  });

  test("POST /share mints a token and the public /share/:token page renders", async ({ page, browser }) => {
    await signIn(page, email, password);
    const reports = await page.request.get("/api/reports").then((r) => r.json());
    let items: any[] = reports.items ?? reports;
    if (!items.length) {
      await page.evaluate(async () => {
        await fetch("/api/reports", { method: "POST" });
      });
      const list2 = await page.request.get("/api/reports").then((r) => r.json());
      items = list2.items ?? list2;
    }
    if (!items.length) throw new Error("Failed to create a report via POST /api/reports");
    const reportId: string = items[0].id;

    const mint = await page.request.post(`/api/reports/${reportId}/share`, {
      data: {},
    });
    expect(mint.status()).toBeGreaterThanOrEqual(200);
    expect(mint.status()).toBeLessThan(300);
    const mintJ = await mint.json();
    const token: string | undefined = mintJ.token;
    expect(token, "share response includes a token").toBeTruthy();
    expect(typeof token).toBe("string");
    expect(token!.length).toBeGreaterThan(20);

    // Open the share URL in a brand-new browser context with no cookies.
    // This proves the public viewer is reachable without auth — the whole
    // point of a share link.
    const anonContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const anonPage = await anonContext.newPage();
    try {
      await anonPage.goto(`/share/${token}`);
      await anonPage.waitForLoadState("networkidle").catch(() => { /* tolerable */ });
      await expect(anonPage).toHaveURL(/\/share\//);
      // The "Public share" badge in the share page header is a stable
      // anchor for "page rendered, not 404'd or redirected".
      await expect(anonPage.getByText(/Public share/i).first()).toBeVisible({ timeout: 15_000 });
    } finally {
      await anonContext.close();
    }
  });
});
