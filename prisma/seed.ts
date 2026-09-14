/**
 * Seed script — creates an admin user, a rich multi-table sample warehouse,
 * a DataSource pointing at it, and three fully-wired demo reports.
 *
 * Reports:
 *   1. "Sales Summary"    — revenue + units KPIs, revenue-by-region bar chart,
 *                           top-products table. Parameters: date range.
 *   2. "Financial P&L"    — revenue/COGS/margin KPIs, monthly trend chart,
 *                           breakdown by product category.
 *   3. "Inventory Status" — SKU/low-stock/inventory-value KPIs, store-level
 *                           stock table, and reorder candidates list.
 */
/**
 * Community edition's seed.ts — replaces the private repo's version wholesale
 * (see scripts/community-export/manifest.json rootOverrides). The private
 * seed.ts also calls seedDemoWorkspace() (prisma/seed-demo.ts) to fill the
 * Demo Workspace for docs screenshots and live testing; that file populates
 * paid-only surfaces (Master Builder, Operate, Metrics, Decisions,
 * Notebooks, Data Quality, Marketplace) that don't exist in a Community
 * install's schema and imports @/lib/dq/runner, which the export strips.
 * prisma/seed-demo.ts itself is excluded from the export (manifest.json).
 * This file is a snapshot of seed.ts as it stood before seed-demo.ts existed
 * — sample warehouse + one report per template + a second tenant for
 * isolation testing. Update it by hand if that base behaviour changes.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import type { Report } from "../src/lib/reporting/schema";

const prisma = new PrismaClient();

// -----------------------------------------------------------------------------
// Fake data generators
// -----------------------------------------------------------------------------

const REGIONS = ["North", "South", "East", "West"];
const CATEGORIES = ["Widget", "Gadget", "Gizmo", "Sprocket", "Thingamajig"];
const TIERS = ["Bronze", "Silver", "Gold", "Platinum"];
const DEPARTMENTS = ["Engineering", "Sales", "Marketing", "Operations", "Finance", "HR", "Support"];
const FIRST_NAMES = ["Alex","Jamie","Taylor","Morgan","Riley","Casey","Jordan","Avery","Quinn","Cameron","Skyler","Rowan","Emery","Reese","Sage","Dakota","Parker","Hayden","Logan","Finley"];
const LAST_NAMES = ["Chen","Patel","Garcia","Kim","Nguyen","Silva","Okafor","Johansson","Kowalski","Tanaka","Rossi","Dubois","Fischer","Morales","Lee","Singh","Khan","Ivanov","Martin","Petrov"];

function rand(min: number, max: number) { return min + Math.random() * (max - min); }
function randInt(min: number, max: number) { return Math.floor(rand(min, max + 1)); }
function pick<T>(arr: T[]): T { return arr[randInt(0, arr.length - 1)]; }
function dateISO(d: Date) { return d.toISOString().slice(0, 10); }

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  // --- Demo tenant (multi-tenancy) ---
  // Every tenant-scoped row in this seed is created inside this Tenant. A fresh
  // install therefore has a single tenant, and an admin who belongs to it.
  const demoOrg = await prisma.organization.upsert({
    where: { slug: "demo" },
    update: {},
    create: { slug: "demo", name: "Demo Workspace", accountType: "individual" },
  });
  const demoTenant = await (prisma as any).tenant.upsert({
    where: { slug: "demo" },
    update: { name: "Demo Workspace", organizationId: demoOrg.id },
    create: { slug: "demo", name: "Demo Workspace", organizationId: demoOrg.id },
  });

  // --- Admin user ---
  // One global User row per email; tenant access comes from Membership,
  // org-level oversight from OrgMembership (see src/lib/auth.ts).
  const passwordHash = await bcrypt.hash("admin123", 10);
  const admin = await prisma.user.upsert({
    where: { email: "admin@curf.local" },
    update: { passwordHash },
    create: { email: "admin@curf.local", name: "Admin", passwordHash },
  });
  const adminMembership = await prisma.membership.upsert({
    where: { userId_tenantId: { userId: admin.id, tenantId: demoTenant.id } },
    update: { role: "admin" },
    create: { userId: admin.id, tenantId: demoTenant.id, role: "admin" },
  });
  await prisma.orgMembership.upsert({
    where: { userId_organizationId: { userId: admin.id, organizationId: demoOrg.id } },
    update: { role: "platform_admin" },
    create: { userId: admin.id, organizationId: demoOrg.id, role: "platform_admin" },
  });

  // --- Default custom roles (Adapts-to-reader / RBAC) ---
  const defaultRoles = [
    { slug: "executive",    label: "Executive",    description: "Top-line KPIs only. CEOs and VPs." },
    { slug: "analyst",      label: "Analyst",      description: "Full detail, all blocks, raw tables." },
    { slug: "new_hire",     label: "New hire",     description: "Explanatory blocks, simplified numbers." },
    { slug: "finance_lead", label: "Finance lead", description: "Financial KPIs + audit detail." },
  ];
  for (const r of defaultRoles) {
    await (prisma as any).role.upsert({
      where: { tenantId_slug: { tenantId: demoTenant.id, slug: r.slug } },
      update: { label: r.label, description: r.description },
      create: { ...r, tenantId: demoTenant.id },
    });
  }
  // Give the seed admin every role so testing is easy.
  await prisma.membership.update({
    where: { id: adminMembership.id },
    data: { rolesJson: JSON.stringify(defaultRoles.map((r) => r.slug)) },
  });

  // --- Sample warehouse (SQLite file) ---
  // Written into the lake directory (same CURF_LAKE_DIR the app already
  // mounts on a persistent volume in production — see lib/lake/storage.ts)
  // rather than prisma/sample.db. The old path resolved under process.cwd()
  // inside the app container's own (ephemeral, gitignored) filesystem: no
  // deploy step ever runs `db:seed` there, so every tenant's cloned
  // "sample_warehouse" DataSource pointed at a file that never existed in
  // the running pod, failing with "unable to open database file" the first
  // time anyone queried it. The lake dir survives pod restarts/rollouts.
  const lakeDir = process.env.CURF_LAKE_DIR ?? path.join(process.cwd(), "lake");
  if (!fs.existsSync(lakeDir)) fs.mkdirSync(lakeDir, { recursive: true });
  const sampleDbPath = path.join(lakeDir, "_seed-sample-warehouse.db");
  if (fs.existsSync(sampleDbPath)) fs.unlinkSync(sampleDbPath);
  const sample = new Database(sampleDbPath);
  sample.pragma("journal_mode = WAL");

  sample.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      region TEXT NOT NULL,
      tier TEXT NOT NULL,
      signup_date TEXT NOT NULL
    );
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      sku TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      unit_price REAL NOT NULL,
      unit_cost REAL NOT NULL
    );
    CREATE TABLE stores (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      region TEXT NOT NULL,
      manager TEXT NOT NULL
    );
    CREATE TABLE employees (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      department TEXT NOT NULL,
      hire_date TEXT NOT NULL,
      end_date TEXT,
      salary REAL NOT NULL
    );
    CREATE TABLE sales (
      id INTEGER PRIMARY KEY,
      sale_date TEXT NOT NULL,
      customer_id INTEGER NOT NULL,
      store_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      units INTEGER NOT NULL,
      revenue REAL NOT NULL,
      cost REAL NOT NULL
    );
    CREATE TABLE inventory (
      store_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      on_hand INTEGER NOT NULL,
      reorder_point INTEGER NOT NULL,
      PRIMARY KEY (store_id, product_id)
    );
    CREATE INDEX idx_sales_date ON sales(sale_date);
    CREATE INDEX idx_sales_store ON sales(store_id);
    CREATE INDEX idx_sales_product ON sales(product_id);
    CREATE TABLE branches (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL
    );
    CREATE TABLE banking_monthly (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT NOT NULL, branch_id INTEGER NOT NULL,
      deposits REAL NOT NULL, loans REAL NOT NULL,
      npl_rate REAL NOT NULL, avg_loan_rate REAL NOT NULL
    );
    CREATE TABLE loan_products (
      id INTEGER PRIMARY KEY,
      product TEXT NOT NULL, accounts INTEGER NOT NULL,
      balance REAL NOT NULL, avg_rate REAL NOT NULL, npl REAL NOT NULL
    );
    CREATE TABLE policies (
      id INTEGER PRIMARY KEY,
      line TEXT NOT NULL, status TEXT NOT NULL, premium REAL NOT NULL,
      start_date TEXT NOT NULL
    );
    CREATE TABLE claims (
      id INTEGER PRIMARY KEY,
      policy_id INTEGER NOT NULL, claim_date TEXT NOT NULL,
      amount REAL NOT NULL, line TEXT NOT NULL
    );
    CREATE TABLE departments (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL,
      budget REAL NOT NULL, spent REAL NOT NULL, services INTEGER NOT NULL
    );
    CREATE TABLE campaigns (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      channel TEXT NOT NULL,
      spend REAL NOT NULL,
      leads INTEGER NOT NULL,
      roi REAL NOT NULL,
      started_at TEXT NOT NULL
    );
    CREATE INDEX idx_campaigns_started ON campaigns(started_at);
    CREATE INDEX idx_campaigns_channel ON campaigns(channel);
    CREATE INDEX idx_claims_date ON claims(claim_date);
    CREATE INDEX idx_banking_month ON banking_monthly(month);
    CREATE INDEX idx_policies_line ON policies(line);
  `);

  // --- Seed customers ---
  const insCustomer = sample.prepare(
    "INSERT INTO customers (id, name, region, tier, signup_date) VALUES (?, ?, ?, ?, ?)"
  );
  for (let i = 1; i <= 80; i++) {
    const signup = new Date(Date.now() - randInt(30, 1400) * 86400000);
    insCustomer.run(
      i,
      `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
      pick(REGIONS),
      pick(TIERS),
      dateISO(signup),
    );
  }

  // --- Seed products ---
  const insProduct = sample.prepare(
    "INSERT INTO products (id, sku, name, category, unit_price, unit_cost) VALUES (?, ?, ?, ?, ?, ?)"
  );
  let pid = 0;
  for (const cat of CATEGORIES) {
    for (let j = 1; j <= 6; j++) {
      pid++;
      const unitPrice = +rand(20, 300).toFixed(2);
      const unitCost = +(unitPrice * rand(0.4, 0.75)).toFixed(2);
      insProduct.run(pid, `${cat.slice(0, 3).toUpperCase()}-${String(j).padStart(3, "0")}`,
                     `${cat} ${String.fromCharCode(64 + j)}`, cat, unitPrice, unitCost);
    }
  }
  const productCount = pid;

  // --- Seed stores ---
  const insStore = sample.prepare(
    "INSERT INTO stores (id, name, region, manager) VALUES (?, ?, ?, ?)"
  );
  const storeNames = ["Downtown", "Riverside", "Northgate", "Eastview", "Southpark", "Westfield", "Midtown", "Lakeside"];
  for (let i = 1; i <= 8; i++) {
    insStore.run(i, `${storeNames[i - 1]} Store`, pick(REGIONS), `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`);
  }

  // --- Seed employees ---
  const insEmp = sample.prepare(
    "INSERT INTO employees (id, name, department, hire_date, end_date, salary) VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (let i = 1; i <= 140; i++) {
    const dept = pick(DEPARTMENTS);
    const hire = new Date(Date.now() - randInt(60, 2000) * 86400000);
    // ~12% attrition
    const terminated = Math.random() < 0.12;
    const end = terminated ? new Date(Date.now() - randInt(1, 360) * 86400000) : null;
    const salary = dept === "Engineering" ? randInt(90, 180) * 1000
                 : dept === "Sales"       ? randInt(60, 140) * 1000
                 : dept === "Finance"     ? randInt(70, 160) * 1000
                 : randInt(45, 110) * 1000;
    insEmp.run(
      i,
      `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
      dept, dateISO(hire), end ? dateISO(end) : null, salary,
    );
  }

  // --- Seed sales (12 months × ~60/day) ---
  const insSale = sample.prepare(
    "INSERT INTO sales (sale_date, customer_id, store_id, product_id, units, revenue, cost) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const start = new Date("2025-06-01").getTime();
  const days = 365;
  const products: Array<{ id: number; price: number; cost: number }> = sample
    .prepare("SELECT id, unit_price AS price, unit_cost AS cost FROM products")
    .all() as any;
  const tx = sample.transaction(() => {
    for (let d = 0; d < days; d++) {
      const date = dateISO(new Date(start + d * 86400000));
      // Weekly seasonality + slight upward trend
      const seasonality = 1 + 0.25 * Math.sin((d / 7) * 2 * Math.PI);
      const trend = 1 + d / 1500;
      const perDay = Math.max(20, Math.round(60 * seasonality * trend));
      for (let i = 0; i < perDay; i++) {
        const p = pick(products);
        const units = randInt(1, 8);
        const revenue = +(units * p.price * rand(0.9, 1.0)).toFixed(2);
        const cost = +(units * p.cost).toFixed(2);
        insSale.run(date, randInt(1, 80), randInt(1, 8), p.id, units, revenue, cost);
      }
    }
  });
  tx();

  // --- Seed inventory (each store × each product) ---
  const insInv = sample.prepare(
    "INSERT INTO inventory (store_id, product_id, on_hand, reorder_point) VALUES (?, ?, ?, ?)"
  );
  for (let s = 1; s <= 8; s++) {
    for (let p = 1; p <= productCount; p++) {
      const onHand = randInt(0, 320);
      const reorder = randInt(25, 80);
      insInv.run(s, p, onHand, reorder);
    }
  }


  // --- Banking: branches + monthly metrics ---
  const BANK_BRANCHES = ["Main St", "Harbor", "Uptown", "Greenfield", "Riverpark", "Elmwood"];
  const insBr = sample.prepare("INSERT INTO branches (id, name, region) VALUES (?, ?, ?)");
  BANK_BRANCHES.forEach((n, i) => insBr.run(i + 1, `${n} Branch`, pick(REGIONS)));
  const insBM = sample.prepare(
    "INSERT INTO banking_monthly (month, branch_id, deposits, loans, npl_rate, avg_loan_rate) VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (let m = 0; m < 12; m++) {
    const month = `2025-${String(m + 1).padStart(2, "0")}`;
    for (let b = 1; b <= BANK_BRANCHES.length; b++) {
      const dep = +rand(50_000_000, 220_000_000).toFixed(0);
      const loans = +rand(40_000_000, 180_000_000).toFixed(0);
      insBM.run(month, b, dep, loans, +rand(0.01, 0.06).toFixed(4), +rand(0.04, 0.09).toFixed(4));
    }
  }
  const LOAN_PRODUCTS = [
    { product: "Mortgage",    accts: 2800, bal: 540_000_000, rate: 0.045, npl: 0.015 },
    { product: "Auto",        accts: 5400, bal: 180_000_000, rate: 0.062, npl: 0.028 },
    { product: "Personal",    accts: 7100, bal:  95_000_000, rate: 0.129, npl: 0.048 },
    { product: "Credit card", accts: 21500, bal:  62_000_000, rate: 0.189, npl: 0.072 },
    { product: "SME",         accts: 1200, bal: 210_000_000, rate: 0.071, npl: 0.036 },
  ];
  const insLP = sample.prepare(
    "INSERT INTO loan_products (id, product, accounts, balance, avg_rate, npl) VALUES (?, ?, ?, ?, ?, ?)"
  );
  LOAN_PRODUCTS.forEach((p, i) =>
    insLP.run(i + 1, p.product, p.accts, p.bal, p.rate, p.npl)
  );

  // --- Insurance: policies + claims ---
  const LINES = ["Auto", "Home", "Life", "Health", "Commercial"];
  const insPol = sample.prepare(
    "INSERT INTO policies (id, line, status, premium, start_date) VALUES (?, ?, ?, ?, ?)"
  );
  for (let i = 1; i <= 600; i++) {
    insPol.run(
      i,
      pick(LINES),
      Math.random() < 0.9 ? "active" : "lapsed",
      +rand(300, 9000).toFixed(2),
      dateISO(new Date(Date.now() - randInt(30, 1000) * 86400000)),
    );
  }
  const insClaim = sample.prepare(
    "INSERT INTO claims (id, policy_id, claim_date, amount, line) VALUES (?, ?, ?, ?, ?)"
  );
  for (let i = 1; i <= 450; i++) {
    const line = pick(LINES);
    insClaim.run(
      i,
      randInt(1, 600),
      dateISO(new Date(Date.now() - randInt(5, 360) * 86400000)),
      +rand(200, 25000).toFixed(2),
      line,
    );
  }

  // --- Government: departments + budget ---
  const GOV_DEPTS = ["Education","Health","Transport","Public Works","Housing","Safety","Environment","Culture"];
  const insDept = sample.prepare(
    "INSERT INTO departments (id, name, budget, spent, services) VALUES (?, ?, ?, ?, ?)"
  );
  GOV_DEPTS.forEach((n, i) => {
    const budget = +rand(80_000_000, 750_000_000).toFixed(0);
    const spent = +(budget * rand(0.6, 0.98)).toFixed(0);
    const services = randInt(1500, 42000);
    insDept.run(i + 1, n, budget, spent, services);
  });

  // --- Marketing: campaigns -------------------------------------------------
  //
  // Story-driven seed (replacing the previous random generator). The 24 rows
  // tell a coherent narrative across 5 quarters that the dashboard surfaces
  // through the filter bar, pivot, and drill-through:
  //
  //   * Search and Social are growing channels - lower spend, climbing ROI
  //   * Email is in steady decline - the spend keeps creeping up but ROI is flat
  //   * Events are expensive but reliable - high spend, mid ROI
  //   * Partner is the dark horse - small bets paying off in 2026
  //   * One catastrophic Display campaign in 2026 burns $185K with negative ROI
  //     (the anomaly the watcher catches and the drill-through pinpoints)
  //
  // Spend feels enterprise-scale (~$2.6M total). Names are realistic enough to
  // pass for a real business deck.
  const insCamp = sample.prepare(
    "INSERT INTO campaigns (id, name, channel, spend, leads, roi, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  type CampaignRow = [
    name: string,
    channel: "Search" | "Social" | "Email" | "Display" | "Events" | "Partner",
    spend: number, leads: number, roi: number, startedAt: string,
  ];
  const CAMPAIGN_ROWS: CampaignRow[] = [
    // ---------- Q4 2024 (warm-up) ----------
    ["Holiday Brand Awareness 2024", "Display", 42_300, 1_840, 1.4, "2024-10-12"],
    ["Black Friday Push 2024",       "Search", 168_000, 9_240, 3.6, "2024-11-04"],
    ["Cyber Week Promotion 2024",    "Social",  92_500, 5_120, 2.9, "2024-11-25"],
    ["Year-End Webinar Series 2024", "Events", 187_400, 3_410, 2.2, "2024-12-02"],

    // ---------- Q1 2025 (steady) ----------
    ["Spring Product Launch 2025",   "Search", 110_200, 7_180, 3.9, "2025-02-10"],
    ["B2B Newsletter Refresh 2025",  "Email",   34_700, 1_220, 1.8, "2025-02-18"],
    ["Partner Co-Marketing Q1 2025", "Partner", 58_900, 3_640, 4.1, "2025-03-04"],

    // ---------- Q2 2025 (growth) ----------
    ["Summer Lead Gen Push 2025",    "Search", 142_800, 9_720, 4.4, "2025-05-08"],
    ["Influencer Collab Wave 2025",  "Social", 121_300, 6_840, 3.7, "2025-05-19"],
    ["Mid-Year Retention 2025",      "Email",   46_900, 1_390, 1.5, "2025-06-02"],
    ["EMEA Roadshow 2025",           "Events", 215_700, 4_180, 2.4, "2025-06-15"],

    // ---------- Q3 2025 (mixed) ----------
    ["Back-to-School Campaign 2025", "Display", 88_400, 3_290, 2.1, "2025-08-12"],
    ["Search Intent Expansion 2025", "Search", 156_500, 11_340, 4.6, "2025-08-26"],
    ["Loyalty Program Reboot 2025",  "Email",   52_300, 1_280, 1.2, "2025-09-09"],
    ["APAC Webinar Series 2025",     "Events", 168_200, 3_640, 2.5, "2025-09-22"],

    // ---------- Q4 2025 (peak) ----------
    ["Black Friday Mega Push 2025",  "Search", 218_400, 13_920, 4.8, "2025-11-03"],
    ["Cyber Week Social Burst 2025", "Social", 184_600, 9_240, 4.0, "2025-11-24"],
    ["Holiday Email Drip 2025",      "Email",   71_200, 1_510, 1.0, "2025-12-01"],
    ["Year-End Partner Push 2025",   "Partner", 96_400, 5_730, 4.3, "2025-12-08"],

    // ---------- Q1 2026 (recent + the anomaly) ----------
    ["New Year Search Refresh 2026", "Search", 134_800, 9_460, 4.5, "2026-01-12"],
    ["Q1 Social Always-On 2026",     "Social", 158_900, 8_120, 3.9, "2026-01-20"],
    ["Spring Tease Email 2026",      "Email",   68_500, 1_180, 0.9, "2026-02-09"],
    ["Partner Account-Based Q1 2026","Partner", 84_300, 5_240, 4.2, "2026-02-23"],
    // The bomb. Watcher catches this. Drill-through pinpoints it.
    ["Display Retargeting Push 2026","Display", 184_600, 720, -0.4, "2026-03-18"],
  ];
  CAMPAIGN_ROWS.forEach((row, i) => insCamp.run(i + 1, ...row));

  sample.close();
  console.log(`Sample warehouse ready: ${sampleDbPath}`);

  // --- DataSource pointing at it ---
  const ds = await (prisma as any).dataSource.upsert({
    where: { tenantId_name: { tenantId: demoTenant.id, name: "sample_warehouse" } },
    update: { connection: sampleDbPath },
    create: { tenantId: demoTenant.id, name: "sample_warehouse", kind: "sqlite", connection: sampleDbPath },
  });

  // --- Reports ---
  await upsertReport({ id: "seed-sales-summary",    tenantId: demoTenant.id, adminId: admin.id, def: salesSummary(ds.id) });
  await upsertReport({ id: "seed-financial-pnl",    tenantId: demoTenant.id, adminId: admin.id, def: financialPnl(ds.id) });
  await upsertReport({ id: "seed-inventory-status", tenantId: demoTenant.id, adminId: admin.id, def: inventoryStatus(ds.id) });

  // Also seed one report per template so every starter template is visible in
  // the catalog from day 1. Uses the template's own build(sampleWarehouseId)
  // so queries point at the seeded tables.
  const { TEMPLATES } = await import("../src/lib/templates/registry");
  let seededActions = 0;
  for (const tpl of TEMPLATES) {
    const def = tpl.build({ sampleWarehouseId: ds.id });
    // Count any row-level actions bundled with the template so we can surface
    // them in the summary — this makes "ship a demo action" verifiable on
    // every re-seed, not just the initial install.
    for (const page of def.pages) {
      for (const block of page.blocks) {
        if (block.type === "table") {
          const acts = (block.config as any)?.actions;
          if (Array.isArray(acts)) seededActions += acts.length;
        }
      }
    }
    await upsertReport({
      id: `seed-tpl-${tpl.slug}`,
      tenantId: demoTenant.id,
      adminId: admin.id,
      def: {
        ...def,
        name: `${def.name} (Demo)`,
        description: def.description ?? tpl.description.en,
      },
    });
  }

  // --- Second tenant for isolation testing ---
  // An Acme tenant with its own admin user (admin@acme.local / admin123). The
  // Demo tenant and Acme tenant MUST NOT see each other's data - this is the
  // acceptance bar for multi-tenancy.
  const acmeOrg = await prisma.organization.upsert({
    where: { slug: "acme" },
    update: {},
    create: { slug: "acme", name: "Acme Workspace", accountType: "individual" },
  });
  const acmeTenant = await (prisma as any).tenant.upsert({
    where: { slug: "acme" },
    update: { name: "Acme Workspace", organizationId: acmeOrg.id },
    create: { slug: "acme", name: "Acme Workspace", organizationId: acmeOrg.id },
  });
  const acmePasswordHash = await bcrypt.hash("admin123", 10);
  const acmeAdmin = await prisma.user.upsert({
    where: { email: "admin@acme.local" },
    update: { passwordHash: acmePasswordHash },
    create: { email: "admin@acme.local", name: "Acme Admin", passwordHash: acmePasswordHash },
  });
  await prisma.membership.upsert({
    where: { userId_tenantId: { userId: acmeAdmin.id, tenantId: acmeTenant.id } },
    update: { role: "admin" },
    create: { userId: acmeAdmin.id, tenantId: acmeTenant.id, role: "admin" },
  });
  await prisma.orgMembership.upsert({
    where: { userId_organizationId: { userId: acmeAdmin.id, organizationId: acmeOrg.id } },
    update: { role: "platform_admin" },
    create: { userId: acmeAdmin.id, organizationId: acmeOrg.id, role: "platform_admin" },
  });
  // One placeholder report so the new tenant's catalog isn't empty. Notice: no
  // data source and no template contents - this tenant sees NONE of Demo's reports.
  await (prisma as any).report.upsert({
    where: { id: "acme-hello" },
    update: { name: "Acme Hello" },
    create: {
      id: "acme-hello",
      tenantId: acmeTenant.id,
      name: "Acme Hello",
      description: "A fresh report for a fresh tenant.",
      category: "Onboarding",
      definition: JSON.stringify({
        version: 1,
        name: "Acme Hello",
        parameters: [],
        dataSources: [],
        pages: [{
          id: crypto.randomUUID(),
          size: "A4",
          orientation: "portrait",
          blocks: [
            { id: "b_title", type: "title", x: 0, y: 0, w: 12, h: 2,
              config: { text: "Welcome to Acme", align: "left" } },
            { id: "b_text", type: "text", x: 0, y: 2, w: 12, h: 4,
              config: { text: "This tenant should see only its own data. Try `admin@curf.local` in another browser and you'll see a completely different set of reports.", align: "left" } },
          ],
        }],
      }),
      published: true,
      createdById: acmeAdmin.id,
    },
  });

  console.log("Seed complete.");
  console.log(`  Login:    admin@curf.local / admin123`);
  console.log(`  Reports:  3 seed + ${TEMPLATES.length} template demos`);
  console.log(`  Actions:  ${seededActions} row-level table actions wired into templates`);
}

async function upsertReport({ id, tenantId, adminId, def }: { id: string; tenantId: string; adminId: string; def: Report }) {
  await (prisma as any).report.upsert({
    where: { id },
    update: { definition: JSON.stringify(def), name: def.name, description: def.description, category: def.category },
    create: {
      id,
      tenantId,
      name: def.name,
      description: def.description,
      category: def.category,
      definition: JSON.stringify(def),
      published: true,
      createdById: adminId,
    },
  });
}

// -----------------------------------------------------------------------------
// Report definitions
// -----------------------------------------------------------------------------

function salesSummary(dsId: string): Report {
  return {
    version: 1,
    name: "Sales Summary",
    description: "Revenue by region and top products over the selected period.",
    category: "Sales",
    parameters: [
      { name: "from", label: "From", type: "date", default: "2025-06-01", required: true },
      { name: "to",   label: "To",   type: "date", default: "2026-05-31", required: true },
    ],
    dataSources: [
      {
        id: "ds_by_region", name: "Revenue by region",
        dataSourceId: dsId,
        sql: `SELECT region, SUM(revenue) AS revenue, SUM(units) AS units
              FROM sales s JOIN stores st ON st.id = s.store_id
              WHERE sale_date BETWEEN :from AND :to
              GROUP BY region ORDER BY revenue DESC`,
      },
      {
        id: "ds_top_products", name: "Top products",
        dataSourceId: dsId,
        sql: `SELECT p.name AS product, p.category, SUM(s.units) AS units, SUM(s.revenue) AS revenue
              FROM sales s JOIN products p ON p.id = s.product_id
              WHERE sale_date BETWEEN :from AND :to
              GROUP BY p.id ORDER BY revenue DESC LIMIT 15`,
      },
      {
        id: "ds_total", name: "Totals",
        dataSourceId: dsId,
        sql: `SELECT SUM(revenue) AS revenue, SUM(units) AS units, COUNT(DISTINCT customer_id) AS customers
              FROM sales WHERE sale_date BETWEEN :from AND :to`,
      },
    ],
    pages: [{
      id: crypto.randomUUID(), size: "A4", orientation: "portrait",
      blocks: [
        { id: "b_title", type: "title", x: 0, y: 0, w: 12, h: 2,
          config: { text: "Sales Summary", subtitle: "{{param.from}} to {{param.to}}", align: "left" } },
        { id: "b_kpi_rev", type: "kpi", x: 0, y: 2, w: 4, h: 3,
          config: { queryId: "ds_total", label: "Total revenue", valueField: "revenue", format: "currency" } },
        { id: "b_kpi_units", type: "kpi", x: 4, y: 2, w: 4, h: 3,
          config: { queryId: "ds_total", label: "Units sold", valueField: "units", format: "number" } },
        { id: "b_kpi_cust", type: "kpi", x: 8, y: 2, w: 4, h: 3,
          config: { queryId: "ds_total", label: "Customers", valueField: "customers", format: "number" } },
        { id: "b_chart", type: "chart", x: 0, y: 5, w: 12, h: 6,
          config: { queryId: "ds_by_region", chartType: "bar", xField: "region",
                    yFields: ["revenue"], title: "Revenue by region", stacked: false, showLegend: true } },
        { id: "b_table", type: "table", x: 0, y: 11, w: 12, h: 10,
          config: { queryId: "ds_top_products", title: "Top 15 products",
                    pageSize: 50, stripe: true, showTotals: true,
                    columns: [
                      { key: "product",  label: "Product",  type: "string",   total: "none" },
                      { key: "category", label: "Category", type: "string",   total: "none" },
                      { key: "units",    label: "Units",    type: "number",   total: "sum"  },
                      { key: "revenue",  label: "Revenue",  type: "currency", total: "sum"  },
                    ], actions: [] } },
      ],
    }],
  };
}

function financialPnl(dsId: string): Report {
  return {
    version: 1,
    name: "Financial P&L",
    description: "Revenue, COGS, and margin by month with category breakdown.",
    category: "Finance",
    parameters: [
      { name: "from", label: "From", type: "date", default: "2025-06-01", required: true },
      { name: "to",   label: "To",   type: "date", default: "2026-05-31", required: true },
    ],
    dataSources: [
      {
        id: "ds_monthly", name: "P&L by month",
        dataSourceId: dsId,
        sql: `SELECT substr(sale_date, 1, 7) AS month,
                     SUM(revenue) AS revenue,
                     SUM(cost)    AS cogs,
                     SUM(revenue - cost) AS margin
              FROM sales
              WHERE sale_date BETWEEN :from AND :to
              GROUP BY month ORDER BY month`,
      },
      {
        id: "ds_by_category", name: "By category",
        dataSourceId: dsId,
        sql: `SELECT p.category,
                     SUM(s.revenue) AS revenue,
                     SUM(s.cost)    AS cogs,
                     SUM(s.revenue - s.cost) AS margin,
                     CASE WHEN SUM(s.revenue) > 0 THEN SUM(s.revenue - s.cost) * 1.0 / SUM(s.revenue) ELSE 0 END AS margin_pct
              FROM sales s JOIN products p ON p.id = s.product_id
              WHERE s.sale_date BETWEEN :from AND :to
              GROUP BY p.category ORDER BY revenue DESC`,
      },
      {
        id: "ds_totals", name: "Totals",
        dataSourceId: dsId,
        sql: `SELECT SUM(revenue) AS revenue,
                     SUM(cost)    AS cogs,
                     SUM(revenue - cost) AS margin,
                     CASE WHEN SUM(revenue) > 0 THEN SUM(revenue - cost) * 1.0 / SUM(revenue) ELSE 0 END AS margin_pct
              FROM sales WHERE sale_date BETWEEN :from AND :to`,
      },
    ],
    pages: [{
      id: crypto.randomUUID(), size: "A4", orientation: "portrait",
      blocks: [
        { id: "b_title", type: "title", x: 0, y: 0, w: 12, h: 2,
          config: { text: "Financial P&L", subtitle: "{{param.from}} to {{param.to}}", align: "left" } },
        { id: "b_k1", type: "kpi", x: 0, y: 2, w: 3, h: 3, config: { queryId: "ds_totals", label: "Revenue", valueField: "revenue", format: "currency" } },
        { id: "b_k2", type: "kpi", x: 3, y: 2, w: 3, h: 3, config: { queryId: "ds_totals", label: "COGS",    valueField: "cogs",    format: "currency" } },
        { id: "b_k3", type: "kpi", x: 6, y: 2, w: 3, h: 3, config: { queryId: "ds_totals", label: "Margin",  valueField: "margin",  format: "currency" } },
        { id: "b_k4", type: "kpi", x: 9, y: 2, w: 3, h: 3, config: { queryId: "ds_totals", label: "Margin %",valueField: "margin_pct", format: "percent" } },
        { id: "b_chart", type: "chart", x: 0, y: 5, w: 12, h: 6,
          config: { queryId: "ds_monthly", chartType: "line", xField: "month",
                    yFields: ["revenue", "cogs", "margin"], title: "Monthly P&L",
                    stacked: false, showLegend: true } },
        { id: "b_cat", type: "table", x: 0, y: 11, w: 12, h: 8,
          config: { queryId: "ds_by_category", title: "By product category",
                    pageSize: 50, stripe: true, showTotals: true,
                    columns: [
                      { key: "category",   label: "Category", type: "string",   total: "none" },
                      { key: "revenue",    label: "Revenue",  type: "currency", total: "sum"  },
                      { key: "cogs",       label: "COGS",     type: "currency", total: "sum"  },
                      { key: "margin",     label: "Margin",   type: "currency", total: "sum"  },
                      { key: "margin_pct", label: "Margin %", type: "percent",  total: "avg"  },
                    ], actions: [] } },
      ],
    }],
  };
}

function inventoryStatus(dsId: string): Report {
  return {
    version: 1,
    name: "Inventory Status",
    description: "On-hand stock, low-stock alerts, and reorder candidates across stores.",
    category: "Operations",
    parameters: [],
    dataSources: [
      {
        id: "ds_totals", name: "Inventory totals",
        dataSourceId: dsId,
        sql: `SELECT COUNT(DISTINCT product_id) AS skus,
                     SUM(on_hand * p.unit_cost) AS value,
                     SUM(CASE WHEN on_hand < reorder_point THEN 1 ELSE 0 END) AS low
              FROM inventory i JOIN products p ON p.id = i.product_id`,
      },
      {
        id: "ds_by_store", name: "By store",
        dataSourceId: dsId,
        sql: `SELECT st.name AS store, st.region,
                     SUM(i.on_hand) AS on_hand,
                     SUM(i.on_hand * p.unit_cost) AS value,
                     SUM(CASE WHEN i.on_hand < i.reorder_point THEN 1 ELSE 0 END) AS low_skus
              FROM inventory i
              JOIN stores st ON st.id = i.store_id
              JOIN products p ON p.id = i.product_id
              GROUP BY st.id ORDER BY value DESC`,
      },
      {
        id: "ds_reorder", name: "Reorder candidates",
        dataSourceId: dsId,
        sql: `SELECT p.sku, p.name AS product, st.name AS store,
                     i.on_hand, i.reorder_point,
                     (i.reorder_point - i.on_hand) AS deficit
              FROM inventory i
              JOIN products p ON p.id = i.product_id
              JOIN stores  st ON st.id = i.store_id
              WHERE i.on_hand < i.reorder_point
              ORDER BY deficit DESC LIMIT 30`,
      },
    ],
    pages: [{
      id: crypto.randomUUID(), size: "A4", orientation: "portrait",
      blocks: [
        { id: "b_title", type: "title", x: 0, y: 0, w: 12, h: 2,
          config: { text: "Inventory Status", subtitle: "Live snapshot across all stores", align: "left" } },
        { id: "b_k1", type: "kpi", x: 0, y: 2, w: 4, h: 3, config: { queryId: "ds_totals", label: "Active SKUs",    valueField: "skus",  format: "number"   } },
        { id: "b_k2", type: "kpi", x: 4, y: 2, w: 4, h: 3, config: { queryId: "ds_totals", label: "Low stock",      valueField: "low",   format: "number"   } },
        { id: "b_k3", type: "kpi", x: 8, y: 2, w: 4, h: 3, config: { queryId: "ds_totals", label: "Inventory value",valueField: "value", format: "currency" } },
        { id: "b_store", type: "table", x: 0, y: 5, w: 12, h: 7,
          config: { queryId: "ds_by_store", title: "By store",
                    pageSize: 50, stripe: true, showTotals: true,
                    columns: [
                      { key: "store",    label: "Store",          type: "string",   total: "none" },
                      { key: "region",   label: "Region",         type: "string",   total: "none" },
                      { key: "on_hand",  label: "On hand (units)",type: "number",   total: "sum"  },
                      { key: "value",    label: "Value",          type: "currency", total: "sum"  },
                      { key: "low_skus", label: "Low-stock SKUs", type: "number",   total: "sum"  },
                    ], actions: [] } },
        { id: "b_reorder", type: "table", x: 0, y: 12, w: 12, h: 10,
          config: { queryId: "ds_reorder", title: "Reorder candidates (top 30 by deficit)",
                    pageSize: 50, stripe: true, showTotals: false,
                    columns: [
                      { key: "sku",            label: "SKU",           type: "string", total: "none" },
                      { key: "product",        label: "Product",       type: "string", total: "none" },
                      { key: "store",          label: "Store",         type: "string", total: "none" },
                      { key: "on_hand",        label: "On hand",       type: "number", total: "none" },
                      { key: "reorder_point",  label: "Reorder point", type: "number", total: "none" },
                      { key: "deficit",        label: "Deficit",       type: "number", total: "none" },
                    ], actions: [] } },
      ],
    }],
  };
}

// -----------------------------------------------------------------------------
// Demo watcher seed — runs after `main()` so Banking Portfolio id is resolvable.
// Hoisted into main() via invocation below so bankingReport.id exists.
// -----------------------------------------------------------------------------
async function seedDemoWatcher() {
  try {
    const bankingReport = await prisma.report.findFirst({
      where: { id: { contains: "banking-portfolio" } },
      select: { id: true },
    });
    if (!bankingReport) return;
    // Need an owning user for the `createdBy` relation. Fall back to any admin
    // so this seed works even if the canonical admin email was changed.
    const owner = await prisma.user.findFirst({
      where: { OR: [{ email: "admin@curf.local" }, { memberships: { some: { role: "admin" } } }] },
      select: { id: true },
    });
    if (!owner) return;
    // Also resolve the Demo tenant — the Schedule needs tenantId via relation.
    const demoTenantRow = await (prisma as any).tenant.findUnique({ where: { slug: "demo" }, select: { id: true } });
    if (!demoTenantRow) return;
    await (prisma as any).schedule.upsert({
      where: { id: "watcher-demo-banking" },
      update: {},
      create: {
        id: "watcher-demo-banking",
        tenant: { connect: { id: demoTenantRow.id } },
        // Prisma demands required relations be expressed via `connect` (not
        // the raw foreign key) when the schema declares them as relations.
        report: { connect: { id: bankingReport.id } },
        createdBy: { connect: { id: owner.id } },
        name: "Banking portfolio watcher (demo)",
        cron: "0 8 * * *",
        format: "html",
        kind: "watcher",
        enabled: true,
        watcherConfigJson: JSON.stringify({
          queries: ["ds_totals"],
          thresholds: [
            { field: "npl", op: ">", value: 0.05, label: "NPL above 5%" },
            { field: "nim", op: "<", value: 0.02, label: "NIM dropped below 2%" },
          ],
          dispatch: { kind: "log" },
        }),
      },
    });
    console.log("  [ok] Seeded demo watcher: watcher-demo-banking");
  } catch (e) {
    console.log("  [skip] Watcher seed — run `prisma db push` first.", (e as Error).message);
  }
}

// Demo delivery schedule. Kind "log" is a safe default for a fresh install -
// it exercises the full render + dispatch pipeline without actually sending
// anywhere. Admins can edit deliveryConfigJson to point at a real webhook /
// Slack URL / SMTP recipients when they're ready.
async function seedDemoDelivery() {
  try {
    const anyReport = await prisma.report.findFirst({
      where: { id: { contains: "financial-pnl" } },
      select: { id: true, tenantId: true },
    });
    if (!anyReport) return;
    const owner = await prisma.user.findFirst({
      where: { OR: [{ email: "admin@curf.local" }, { memberships: { some: { role: "admin" } } }] },
      select: { id: true },
    });
    if (!owner) return;
    await (prisma as any).schedule.upsert({
      where: { id: "delivery-demo-pnl" },
      update: {},
      create: {
        id: "delivery-demo-pnl",
        tenant: { connect: { id: anyReport.tenantId } },
        report: { connect: { id: anyReport.id } },
        createdBy: { connect: { id: owner.id } },
        name: "Weekly P&L - delivery demo",
        cron: "0 9 * * 1",
        format: "pdf",
        kind: "delivery",
        enabled: true,
        deliveryConfigJson: JSON.stringify({
          kind: "log",
          // Swap to these to actually deliver somewhere:
          //   kind: "slack",   slackWebhook: "https://hooks.slack.com/services/..."
          //   kind: "webhook", url: "https://webhook.site/..."
          //   kind: "email",   recipients: ["finance@company.com"]
        }),
      },
    });
    console.log("  [ok] Seeded demo delivery: delivery-demo-pnl (kind=log)");
  } catch (e) {
    console.log("  [skip] Delivery seed - run `prisma db push` first.", (e as Error).message);
  }
}

main()
  .then(() => seedDemoWatcher())
  .then(() => seedDemoDelivery())
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
