/**
 * E2E spec — Round 32 onboarding (sign-up → empty state → first action).
 *
 * Verifies the full first-touch journey for a brand-new user:
 *   1. /api/signup creates tenant + admin + auto-provisioned data sources
 *   2. Sign-in lands on a sensible page
 *   3. /reports and /tables render for the new admin with create affordances
 *
 * The paid surfaces of the same journey (/build, /brief, workspace templates)
 * live in signup-onboarding-paid.spec.ts — that file is not part of the
 * Community edition export.
 *
 * If this fails, the new-user demo collapses. First impression = retention.
 */
import { test, expect } from "@playwright/test";
import { signupTenant, signIn } from "./helpers";

test.describe("New-user onboarding (Round 32)", () => {
  let email: string;
  let password: string;

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now().toString(36);
    email = `onboard-${stamp}@tenantnew.test`;
    password = "OnboardPass" + stamp;
    const res = await signupTenant(request, {
      workspace: `Onboard New ${stamp}`,
      email,
      password,
    });
    expect(res.tenantId).toBeTruthy();
    expect(res.slug).toBeTruthy();
  });

  // Note: /api/signup calls provisionStarterPack, so newly-signed-up tenants
  // are NOT empty — they land on a populated workspace. The previous "empty
  // state" assertions tested an unreachable code path. Re-aimed at the
  // actual launch surface: do the pages render correctly for a brand-new
  // admin, with the create affordances they'd need to grow the workspace?
  // The genuine empty-state branch should be verified separately by a
  // spec that signs up + deletes the starter pack first; tracked as a
  // TODO in HARNESS_ROADMAP.md.

  test("/reports renders for a new admin with create affordances", async ({ page }) => {
    await signIn(page, email, password);
    await page.goto("/reports");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/reports(\?|$)/);
    // Page header — confirms server-side render reached the Reports route.
    await expect(page.getByRole("heading", { name: /^Reports$/i }).first()).toBeVisible({ timeout: 10_000 });
    // Admin sees a "New report" CTA (the canCreate path in EmptyState +
    // the AppShell action button both render this label).
    await expect(page.getByRole("button", { name: /New report/i }).first()).toBeVisible();
  });

  test("/tables renders for a new admin with upload affordance", async ({ page }) => {
    await signIn(page, email, password);
    await page.goto("/tables");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/tables(\?|$)/);
    // Page header — confirms server-side render reached the Tables route.
    // The /tables h1 is "Curf Tables" (the brand prefix is intentional —
    // distinguishes it from "Tables" in the catalog view).
    await expect(page.getByRole("heading", { name: /Curf Tables/i }).first()).toBeVisible({ timeout: 10_000 });
    // The Upload affordance renders unconditionally above the list — its
    // primary "Upload" button is a dependable anchor for "page rendered".
    await expect(page.getByRole("button", { name: /^Upload$/i }).first()).toBeVisible();
  });

  test("session contains tenantId + admin role for newly-signed-up user", async ({ page }) => {
    await signIn(page, email, password);
    const session = await page.request.get("/api/auth/session").then((r) => r.json());
    expect(session.user.email).toBe(email);
    expect(session.user.tenantId).toBeTruthy();
    expect(session.user.role).toBe("admin");
  });
});
