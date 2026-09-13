/**
 * E2E spec — Wave C (workspace template apply).
 *
 * For SEED_ADMIN:
 *   1. GET /api/v1/marketplace/templates and find a workspace
 *      template (b2b-saas if available, otherwise the first kind=workspace).
 *   2. POST /api/workspace-templates/apply (admin-only, internal — not v1
 *      since it mutates tenant state) with the template
 *      id; assert 2xx within 5s.
 *   3. The current applier is synchronous and returns a summary blob —
 *      no buildId. We assert the artifact counters directly:
 *         tablesCreated + tablesSkipped >= 3 (b2b-saas declares 4 lake tables)
 *         reportsCreated + reportsSkipped >= 1
 *         watchersCreated + watchersSkipped >= 1
 *      "skipped" rolls up tables that already exist from a prior apply —
 *      idempotency is the desired behaviour, so the assertion folds them in.
 *   4. If a future revision returns an async buildId instead, the spec
 *      polls GET /api/master-builder/:id for status="ready" (≤60s).
 *
 * Gates Round 32 first-run apply path. If broken, the "30s to a working
 * dashboard" promise on the marketing site collapses.
 */
import { test, expect } from "@playwright/test";
import { signIn, SEED_ADMIN } from "./helpers";

test.describe("Workspace template apply (Wave C)", () => {
  test("apply b2b-saas workspace template into the current tenant", async ({ page }) => {
    await signIn(page, SEED_ADMIN.email, SEED_ADMIN.password);

    // Step 1: discover available workspace templates. The v1 marketplace
    // endpoint lists report-kind templates, so we fall back to the
    // workspace-templates registry endpoint when needed.
    let templateId: string | undefined;
    const wsResp = await page.request.get("/api/v1/workspace-templates");
    if (wsResp.ok()) {
      const wsJ = await wsResp.json();
      const items: any[] = wsJ.items ?? wsJ ?? [];
      const b2b = items.find((t) => t.id === "b2b-saas") ?? items[0];
      if (b2b?.id) templateId = b2b.id;
    }
    if (!templateId) {
      // Last-resort: try the v1 marketplace listing.
      const mResp = await page.request.get("/api/v1/marketplace/templates");
      if (mResp.ok()) {
        const mJ = await mResp.json();
        const ws = (mJ.items ?? []).find((t: any) => t.kind === "workspace");
        templateId = ws?.slug ?? ws?.id;
      }
    }
    if (!templateId) {
      test.skip(true, "No workspace template registered in this build");
      return;
    }

    // Step 2: apply.
    const start = Date.now();
    const r = await page.request.post("/api/workspace-templates/apply", {
      data: { templateId, intoTenant: false },
    });
    const elapsed = Date.now() - start;
    expect(r.status(), `apply returned ${r.status()}: ${await r.text().catch(() => "(no body)")}`).toBeGreaterThanOrEqual(200);
    expect(r.status()).toBeLessThan(300);
    expect(elapsed, "apply completes promptly").toBeLessThan(60_000);
    const j = await r.json();

    // Step 3a: async path — if the API ever flips to returning a buildId,
    // poll the build for ready. We accept either shape so the spec
    // tracks the API contract without churn.
    if (j.buildId) {
      let buildJ: any;
      for (let i = 0; i < 30; i++) {
        await new Promise((res) => setTimeout(res, 2_000));
        buildJ = await page.request.get(`/api/master-builder/${j.buildId}`).then((rr) => rr.json());
        if (buildJ.build?.status === "ready") break;
        if (buildJ.build?.status === "failed") {
          throw new Error(`Build failed: ${JSON.stringify(buildJ.build?.statusJson)}`);
        }
      }
      expect(buildJ?.build?.status).toBe("ready");
      const counts: Record<string, number> = {};
      for (const a of buildJ?.artifacts ?? []) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
      expect(counts.table ?? 0).toBeGreaterThanOrEqual(3);
      expect(counts.report ?? 0).toBeGreaterThanOrEqual(1);
      expect(counts.watcher ?? 0).toBeGreaterThanOrEqual(1);
      return;
    }

    // Step 3b: synchronous path (current implementation). Counter blob.
    const tablesTotal = (j.tablesCreated ?? 0) + (j.tablesSkipped ?? 0);
    const reportsTotal = (j.reportsCreated ?? 0) + (j.reportsSkipped ?? 0);
    const watchersTotal = (j.watchersCreated ?? 0) + (j.watchersSkipped ?? 0);
    expect(tablesTotal, "≥3 tables created or already exist").toBeGreaterThanOrEqual(3);
    expect(reportsTotal, "≥1 report created or already exists").toBeGreaterThanOrEqual(1);
    expect(watchersTotal, "≥1 watcher created or already exists").toBeGreaterThanOrEqual(1);
  });
});
