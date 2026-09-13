/**
 * Helpers shared across Curf E2E specs. Sign-in, sign-up, fixture creation,
 * and small utilities. Keeps each spec readable.
 */
import { type APIRequestContext, type Page, expect } from "@playwright/test";

export const SEED_ADMIN = {
  email: "admin@curf.local",
  password: "admin123",
};

/** Sign in via the next-auth credentials provider. */
export async function signIn(page: Page, email: string, password: string) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    // Clear any existing session cookies so we always start fresh.
    await page.context().clearCookies();
    await page.goto("/login");
    await page.locator('input[name="email"], input[type="email"]').fill(email);
    await page.locator('input[name="password"], input[type="password"]').fill(password);
    await page.locator('button[type="submit"]').first().click();
    
    // Wait for NextAuth to redirect us away from the login form
    await page.waitForURL((url) => url.pathname.startsWith("/brief") || url.pathname.startsWith("/reports") || url.pathname === "/", { timeout: 45_000 });
    
    // Poll for the session cookie
    for (let i = 0; i < 100; i++) {
      if (await getSession(page)) return;
      await page.waitForTimeout(100);
    }
    
    // eslint-disable-next-line no-console
    console.log(`[signIn] attempt ${attempt} failed, session cookie did not land.`);
  }
  throw new Error(`signIn: session cookie for ${email} did not land within timeout after 2 attempts`);
}

/** Sign up a brand-new tenant + admin user via /api/signup. Returns ids. */
export async function signupTenant(req: APIRequestContext, args: {
  workspace: string;
  email: string;
  password: string;
  name?: string;
}): Promise<{ tenantId: string; userId: string; slug: string }> {
  const r = await req.post("/api/signup", {
    data: {
      workspace: args.workspace,
      email: args.email,
      password: args.password,
      name: args.name ?? args.email.split("@")[0],
    },
  });
  expect(r.status()).toBe(200);
  const j = await r.json();
  expect(j.ok).toBe(true);
  return { tenantId: j.tenant.id, userId: j.user.id, slug: j.tenant.slug };
}

/** Switch the NextAuth session into another workspace — what the nav rail's
 *  switcher does via useSession().update({ activeTenantId }). Matches on
 *  the FIRST membership whose tenantSlug starts with the given prefix
 *  (fixture tenants get a random suffix, e.g. "a3-verify-1788590724797").
 *  Returns null (never throws) when the signed-in user has no such
 *  membership, so callers can test.skip() rather than fail when a fixture
 *  workspace isn't present on this environment. */
export async function switchWorkspace(page: Page, tenantSlugPrefix: string): Promise<{ tenantId: string; tenantName: string } | null> {
  const session = await page.evaluate(() => fetch("/api/auth/session", { cache: "no-store" }).then((r) => r.json()));
  const m = (session?.user?.memberships ?? []).find((x: any) => String(x.tenantSlug).startsWith(tenantSlugPrefix));
  if (!m) return null;
  await page.evaluate(async (activeTenantId) => {
    const { csrfToken } = await fetch("/api/auth/csrf").then((r) => r.json());
    await fetch("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csrfToken, data: { activeTenantId } }),
    });
  }, m.tenantId);
  return { tenantId: m.tenantId, tenantName: m.tenantName };
}

/** Returns the current next-auth session (or null if signed out). */
export async function getSession(page: Page): Promise<any | null> {
  const cookies = await page.context().cookies();
  // eslint-disable-next-line no-console
  console.log("Cookies in browser:", cookies);
  const data = await page.evaluate(async () => {
    const res = await fetch("/api/auth/session", { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  });
  // eslint-disable-next-line no-console
  console.log("[getSession] returned data:", data);
  if (!data) return null;
  return Object.keys(data).length > 0 ? data : null;
}
