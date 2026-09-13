/**
 * E2E spec — genuine empty-state coverage (tracked as a gap in
 * HARNESS_ROADMAP.md's Harness 3 section).
 *
 * signup-onboarding.spec.ts can't exercise this branch: /api/signup calls
 * provisionStarterPack, so a brand-new tenant is never actually empty —
 * its "empty state" assertions were re-aimed at "new admin lands on a
 * populated starter-pack workspace" instead. This spec reaches the real
 * empty-state UI the only way possible: sign up, then delete every
 * starter-pack report and lake table via the existing DELETE APIs, then
 * assert the copy that only renders when the tenant genuinely has zero
 * reports / zero tables.
 */
import { test, expect } from "@playwright/test";
import { signupTenant, signIn } from "./helpers";

test.describe("Genuine empty state (no reports, no tables)", () => {
  let email: string;
  let password: string;

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now().toString(36);
    email = `empty-${stamp}@tenantnew.test`;
    password = "EmptyPass" + stamp;
    const res = await signupTenant(request, {
      workspace: `Empty State ${stamp}`,
      email,
      password,
    });
    expect(res.tenantId).toBeTruthy();
  });

  test("deleting the starter pack empties both /reports and /tables", async ({ page }) => {
    await signIn(page, email, password);

    // Delete every starter-pack report.
    const reportsRes = await page.request.get("/api/reports");
    expect(reportsRes.ok()).toBeTruthy();
    const { items: reports } = await reportsRes.json();
    expect(reports.length).toBeGreaterThan(0); // sanity: starter pack really seeded something
    for (const r of reports) {
      const del = await page.request.delete(`/api/reports/${r.id}`);
      expect(del.ok()).toBeTruthy();
    }

    // The starter pack's reports query a demo DataSource (see
    // provisionStarterPack), not the tenant's own Curf Tables/lake — so a
    // brand-new tenant genuinely starts with zero LakeTable rows already.
    // Delete any that exist anyway (defensive, in case that ever changes)
    // and assert the empty state either way.
    const tablesRes = await page.request.get("/api/lake/tables");
    expect(tablesRes.ok()).toBeTruthy();
    const { items: tables } = await tablesRes.json();
    for (const tbl of tables) {
      const del = await page.request.delete(`/api/lake/tables/${encodeURIComponent(tbl.name)}`);
      expect(del.ok()).toBeTruthy();
    }

    // Confirm both catalogs are actually empty server-side before checking UI copy.
    const reportsAfter = await (await page.request.get("/api/reports")).json();
    expect(reportsAfter.items.length).toBe(0);
    const tablesAfter = await (await page.request.get("/api/lake/tables")).json();
    expect(tablesAfter.items.length).toBe(0);

    // /reports genuine empty state: admin + 0 reports renders the
    // "land your data first" headline + SuggestedTemplates (not the
    // plain viewer-role copy, and not a populated grid).
    await page.goto("/reports");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(/No reports yet — let's land your data first/i)).toBeVisible({ timeout: 10_000 });

    // /tables genuine empty state: the dashed-border EmptyState card,
    // not the populated table-card grid.
    await page.goto("/tables");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(/^No tables yet$/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Drop a file above, or mint a webhook token/i)).toBeVisible();
  });
});
