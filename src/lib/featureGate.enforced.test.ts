/**
 * Every FEATURE_TIERS key must either be READ somewhere, or be listed below
 * as deliberately not enforceable.
 *
 * A scan of the 62 keys found 16 that appeared nowhere outside this module.
 * Nine of them gated capabilities that fully shipped — cross-source joins,
 * threshold lines, embed tokens, custom roles, connection ACLs, signed
 * webhooks, streaming ingest — so the pricing page sold them while every
 * tier used them for free. The flag existing read as "this is gated"; only
 * grepping the whole tree showed otherwise.
 *
 * This test is that grep, run on every build. A new key with nothing reading
 * it fails here, and a key deliberately without an enforcement point has to
 * be named — with the reason — rather than quietly looking gated.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FEATURE_TIERS } from "./featureTiers";

/**
 * Keys with no enforcement point, and why. Audited 2026-09-21.
 *
 * "Pricing-only" means the capability does not exist in the product, so
 * there is nothing to gate — the key is a line on the plan comparison. If
 * one of these ever ships, delete its entry here and the test will insist
 * on a real gate.
 */
const NOT_ENFORCEABLE: Record<string, string> = {
  "ai.compare_mode":
    "No implementation. The only compare surfaces are the Analytic App brief window (already behind apps.publish/intelligence.brief) and the free KPI compareField.",
  "dashboard.anomaly_focus":
    "No implementation. Anomalies exist only in the Watcher/Brief pipeline, which is gated by intelligence.watchers / intelligence.brief.",
  "dashboard.kpi_ticker":
    "No implementation — there is no ticker surface anywhere in src/. This key read as enforced until 2026-09-21 only because a humanizeFeatureKey test named it; excluding *.test.ts from the scan exposed it.",
  "gov.sso_oidc_custom":
    "No implementation — getProviders() hardcodes Google + GitHub and there is no per-tenant OIDC config model.",
  "gov.sso_oidc_builtin":
    "Ships, but not gateable at its entry point: OAuth sign-in resolves the tenant only AFTER authentication, and provider availability is instance-wide (env vars), not per tenant.",
  "gov.audit_log_extended":
    "Nothing to unlock. Audit pruning is opt-in — with no rule configured every tier already keeps events forever — so the paid direction is a CAP on retention, not an extension. Capping plan.features.auditLogRetentionDays is separate product work.",
  "dashboard.tiled":
    "No capability by this name. The grid_*/custom dashboard layouts predate the key and are in use on every tier; gating them now would break existing dashboards. Needs a product decision before it becomes a gate.",
  "infra.dedicated_instance":
    "Pricing dimension only — single-tenant infra is provisioned in ops, not by the app. Its own comment in featureTiers.ts says so.",
  "ops.custom_retention":
    "No tenant-settable retention exists; backup windows come from a fixed tier table in lib/lake/backup.ts, which already keys on tier.",
};

/**
 * Keys enforced by an equivalent tier mechanism rather than by their own
 * string — a quota helper or a bare tierAtLeast. Naming the mechanism is
 * the point: it's what separates "gated a different way" from "not gated".
 */
const ENFORCED_ELSEWHERE: Record<string, string> = {
  "intelligence.watchers":
    "requireWatcherQuota — lib/billing.ts, plan.features.watchersMax === 0 returns the Growth-required 402.",
  "apps.unlimited":
    "requireAppQuota — lib/billing.ts, plan.features.apps caps Community at 0 and Growth at 3.",
  "apps.custom_brand":
    "app/(main)/apps/[slug]/page.tsx — tierAtLeast(tenant.tier, 'business') drives showCurfBadge and the accent colour.",
};

/**
 * Every .ts/.tsx under src/ that could hold a real enforcement point:
 * featureTiers.ts, which declares and labels every key, and featureGate.ts
 * are excluded (a key naming itself proves nothing), and so is every
 * *.test.ts(x) — a key that only appears in a test is asserted about, not
 * enforced, and counting those would let a test keep an ungated key
 * looking gated.
 */
const GATE_MODULES = new Set(["featureTiers.ts", "featureGate.ts"]);

function sourceBlobs(): string[] {
  const root = path.join(process.cwd(), "src");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !GATE_MODULES.has(entry.name)) {
        out.push(fs.readFileSync(p, "utf8"));
      }
    }
  };
  walk(root);
  return out;
}

describe("FEATURE_TIERS — every key is enforced or declared unenforceable", () => {
  const blobs = sourceBlobs();
  const keys = Object.keys(FEATURE_TIERS);

  it("scans a plausible number of source files", () => {
    // Guards the guard: a broken walk would make every key look enforced.
    expect(blobs.length).toBeGreaterThan(500);
  });

  it.each(keys)("%s is read outside the gate modules, or listed as unenforceable", (key) => {
    for (const table of [NOT_ENFORCEABLE, ENFORCED_ELSEWHERE]) {
      if (key in table) {
        // A one-word excuse isn't a justification.
        expect(table[key].length).toBeGreaterThan(30);
        return;
      }
    }
    const referenced = blobs.some((b) => b.includes(`"${key}"`) || b.includes(`'${key}'`));
    expect(referenced, `"${key}" has no enforcement point. Gate it, or add it to NOT_ENFORCEABLE with the reason.`).toBe(true);
  });

  it("has no stale exemptions", () => {
    for (const key of [...Object.keys(NOT_ENFORCEABLE), ...Object.keys(ENFORCED_ELSEWHERE)]) {
      expect(keys, `"${key}" is exempted but is no longer a feature key.`).toContain(key);
    }
  });

  it("does not exempt a key that IS enforced by its own name", () => {
    // Stops an exemption from outliving the gap it documented.
    for (const key of Object.keys(NOT_ENFORCEABLE)) {
      const referenced = blobs.some((b) => b.includes(`"${key}"`) || b.includes(`'${key}'`));
      expect(referenced, `"${key}" is now gated — drop it from NOT_ENFORCEABLE.`).toBe(false);
    }
  });
});
