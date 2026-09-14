#!/usr/bin/env node
/**
 * Creates the four Stripe prices billing.ts expects and prints the env
 * lines to paste in. Run this yourself, in your own shell, with your own
 * Stripe secret key — it is never handled by Claude or committed anywhere.
 *
 *   STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup-prices.mjs
 *   STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup-prices.mjs --dry-run
 *
 * Idempotent: each price gets a stable `lookup_key`
 * (growth_editor_monthly, growth_viewer_monthly, business_editor_monthly,
 * business_viewer_monthly). Re-running finds the existing active price by
 * that key instead of creating a duplicate, so it's safe to run again
 * after a partial failure or just to print the ids again.
 *
 * The four amounts below are asserted against src/lib/billing.ts's PLANS
 * array before anything is created — if pricing changes there and this
 * script isn't updated to match, it refuses to run rather than create a
 * price at the wrong amount.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const dryRun = process.argv.includes("--dry-run");

const PRICES = [
  { tier: "growth", kind: "editor", usd: 49, envVar: "STRIPE_PRICE_GROWTH_EDITOR", label: "Growth — editor seat" },
  { tier: "growth", kind: "viewer", usd: 9, envVar: "STRIPE_PRICE_GROWTH_VIEWER", label: "Growth — viewer seat" },
  { tier: "business", kind: "editor", usd: 99, envVar: "STRIPE_PRICE_BUSINESS_EDITOR", label: "Business — editor seat" },
  { tier: "business", kind: "viewer", usd: 15, envVar: "STRIPE_PRICE_BUSINESS_VIEWER", label: "Business — viewer seat" },
];

// ── Guard: these amounts must match the app's own source of truth ──────
function assertMatchesBillingTs() {
  const billingSrc = readFileSync(path.join(repoRoot, "src/lib/billing.ts"), "utf8");
  const seatsBlock = (tier) => {
    const m = billingSrc.match(new RegExp(`tier: "${tier}",[\\s\\S]*?seats: \\{ editorUsd: (\\d+), viewerUsd: (\\d+)`));
    if (!m) throw new Error(`Could not find a seats block for tier "${tier}" in src/lib/billing.ts — has PLANS changed shape? Update this script.`);
    return { editorUsd: Number(m[1]), viewerUsd: Number(m[2]) };
  };
  for (const tier of ["growth", "business"]) {
    const actual = seatsBlock(tier);
    for (const kind of ["editor", "viewer"]) {
      const expected = PRICES.find((p) => p.tier === tier && p.kind === kind).usd;
      const got = kind === "editor" ? actual.editorUsd : actual.viewerUsd;
      if (got !== expected) {
        throw new Error(
          `src/lib/billing.ts now says ${tier} ${kind} = $${got}, but this script has $${expected}. ` +
          `Pricing has moved since this script was written — update the PRICES table above before running.`,
        );
      }
    }
  }
  console.log("✓ Amounts match src/lib/billing.ts's PLANS.\n");
}
assertMatchesBillingTs();

if (dryRun) {
  console.log("--dry-run: would create/verify these prices —");
  for (const p of PRICES) console.log(`  ${p.envVar}  ${p.label}  $${p.usd}/month`);
  process.exit(0);
}

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("STRIPE_SECRET_KEY is not set. Run with:\n  STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup-prices.mjs");
  process.exit(1);
}
console.log(`Using a ${key.startsWith("sk_live_") ? "LIVE" : key.startsWith("sk_test_") ? "TEST" : "unrecognized-prefix"} key.\n`);

const { default: Stripe } = await import("stripe");
const stripe = new Stripe(key, { apiVersion: "2024-06-20" });

async function ensureProduct(tier) {
  const name = tier === "growth" ? "Curf — Growth" : "Curf — Business";
  const existing = await stripe.products.search({ query: `name:'${name}' AND active:'true'` });
  if (existing.data[0]) return existing.data[0];
  return stripe.products.create({ name, metadata: { curf_tier: tier } });
}

async function ensurePrice({ tier, kind, usd, label }) {
  const lookup_key = `${tier}_${kind}_monthly`;
  const found = await stripe.prices.list({ lookup_keys: [lookup_key], active: true, limit: 1 });
  if (found.data[0]) {
    console.log(`= exists  ${lookup_key}  ${found.data[0].id}`);
    return found.data[0];
  }
  const product = await ensureProduct(tier);
  const price = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: usd * 100,
    recurring: { interval: "month" },
    lookup_key,
    nickname: label,
    metadata: { curf_tier: tier, curf_kind: kind },
  });
  console.log(`+ created ${lookup_key}  ${price.id}`);
  return price;
}

const results = {};
for (const p of PRICES) {
  results[p.envVar] = await ensurePrice(p);
}

console.log("\nSet these on the app (Cloud env / DEPLOY-NOTES.md):\n");
for (const p of PRICES) {
  console.log(`${p.envVar}="${results[p.envVar].id}"`);
}
console.log("\nThen point the Stripe webhook at POST /api/stripe/webhook (STRIPE_WEBHOOK_SECRET),");
console.log("and do one real test checkout to confirm a tenant lands with stripeStatus=\"trialing\".");
