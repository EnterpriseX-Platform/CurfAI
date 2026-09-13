/**
 * Migration smoke — Curf.
 *
 * Run after `prisma migrate deploy` + `npm run db:seed` to assert that
 * every persisted artifact still parses against the current Zod schemas.
 * Catches schema drift early: if a migration drops a column that
 * Report.definition references, every row will fail to parse here.
 *
 * Used by .github/workflows/migration-gate.yml — blocks merge of any
 * Prisma change that would corrupt existing rows.
 *
 * Usage:  npx tsx scripts/migration-smoke.ts
 * Exits:  0 on full pass, 1 on first failure (with row id + reason).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { prisma } from "../src/lib/db";
import { ReportSchema } from "../src/lib/reporting/schema";

type Failure = { kind: string; id: string; reason: string };

const failures: Failure[] = [];

function fail(kind: string, id: string, reason: string): void {
  failures.push({ kind, id, reason });
  // Print immediately so a long run shows progress + first cause.
  console.error(`  FAIL [${kind}] id=${id} — ${reason}`);
}

/**
 * Permissive cron parse — doesn't validate semantics, just shape. We
 * don't depend on cron-parser (not in package.json) but reject obvious
 * garbage. A non-empty string with 5 or 6 whitespace-separated fields
 * passes; tighter validation is the runner's job at fire time.
 */
function looksLikeCron(s: string): boolean {
  if (typeof s !== "string" || s.trim().length === 0) return false;
  const parts = s.trim().split(/\s+/);
  return parts.length === 5 || parts.length === 6;
}

async function checkReports(): Promise<number> {
  const rows: any[] = await (prisma as any).report.findMany({
    select: { id: true, name: true, definition: true },
  });
  console.log(`\n[reports] verifying ${rows.length} rows`);
  for (const r of rows) {
    let raw: unknown;
    try { raw = JSON.parse(r.definition); }
    catch (e: any) {
      fail("report", r.id, `definition is not JSON: ${e?.message ?? e}`);
      continue;
    }
    const parsed = ReportSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const path = first?.path.join(".") || "(root)";
      fail("report", r.id, `ReportSchema parse failed at '${path}': ${first?.message ?? "unknown"}`);
    }
  }
  return rows.length;
}

async function checkLakeTables(): Promise<number> {
  const rows: any[] = await (prisma as any).lakeTable.findMany({
    select: { id: true, name: true, schemaJson: true },
  });
  console.log(`\n[lake_tables] verifying ${rows.length} rows`);
  for (const r of rows) {
    if (!r.schemaJson || r.schemaJson === "[]") {
      fail("lakeTable", r.id, `empty schemaJson on '${r.name}'`);
      continue;
    }
    try {
      const parsed = JSON.parse(r.schemaJson);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        fail("lakeTable", r.id, `schemaJson is not a non-empty array on '${r.name}'`);
      }
    } catch (e: any) {
      fail("lakeTable", r.id, `schemaJson not parseable: ${e?.message ?? e}`);
    }
    // Lake table safeName is computed from name on demand (see
    // lib/lake/storage.ts → toSafeTableName), but the row must at least
    // have a name we can derive one from.
    if (typeof r.name !== "string" || r.name.length === 0) {
      fail("lakeTable", r.id, "missing name (cannot derive safeName)");
    }
  }
  return rows.length;
}

async function checkSchedules(): Promise<number> {
  const rows: any[] = await (prisma as any).schedule.findMany({
    select: { id: true, name: true, cron: true },
  });
  console.log(`\n[schedules] verifying ${rows.length} rows`);
  for (const r of rows) {
    if (!looksLikeCron(r.cron)) {
      fail("schedule", r.id, `cron '${r.cron}' is not a 5- or 6-field expression`);
    }
  }
  return rows.length;
}

async function checkMarketplaceTemplates(): Promise<number> {
  const rows: any[] = await (prisma as any).marketplaceTemplate.findMany({
    select: { id: true, slug: true, kind: true, definitionJson: true },
  });
  console.log(`\n[marketplace_templates] verifying ${rows.length} rows`);
  for (const r of rows) {
    let payload: any;
    try { payload = JSON.parse(r.definitionJson); }
    catch (e: any) {
      fail("marketplaceTemplate", r.id, `definitionJson not parseable: ${e?.message ?? e}`);
      continue;
    }
    // For kind='report' we can run the full ReportSchema; for other kinds
    // (operate / workspace) we just sanity-check top-level keys exist
    // because a dedicated Zod schema isn't centralised. Graceful here is
    // OK — the import APIs do strict validation at apply time.
    if (r.kind === "report" || r.kind == null) {
      const parsed = ReportSchema.safeParse(payload);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const path = first?.path.join(".") || "(root)";
        fail("marketplaceTemplate", r.id, `report-kind payload failed ReportSchema at '${path}': ${first?.message ?? "unknown"}`);
      }
    } else {
      // Workspace / operate templates — just require a non-empty object
      // with at least one of: name, plan, definition.
      if (!payload || typeof payload !== "object") {
        fail("marketplaceTemplate", r.id, `kind=${r.kind} payload is not an object`);
        continue;
      }
      const hasShape = ("name" in payload) || ("plan" in payload) || ("definition" in payload);
      if (!hasShape) {
        fail("marketplaceTemplate", r.id, `kind=${r.kind} payload missing expected top-level key (name|plan|definition)`);
      }
    }
  }
  return rows.length;
}

async function main(): Promise<void> {
  console.log(`Migration smoke — connecting to ${process.env.DATABASE_URL?.replace(/:[^:@]+@/, ":***@") ?? "(unset)"}`);

  let totals: Record<string, number> = {};
  try {
    totals.reports = await checkReports();
    totals.lakeTables = await checkLakeTables();
    totals.schedules = await checkSchedules();
    totals.marketplaceTemplates = await checkMarketplaceTemplates();
  } catch (e: any) {
    console.error(`\nFATAL: smoke aborted — ${e?.message ?? e}`);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }

  console.log(`\n— Summary —`);
  for (const [k, n] of Object.entries(totals)) console.log(`  ${k}: ${n} verified`);
  console.log(`  failures: ${failures.length}`);

  if (failures.length > 0) {
    console.error(`\nMigration smoke FAILED — ${failures.length} row(s) did not pass invariants. See above.`);
    process.exit(1);
  }
  console.log("\nMigration smoke PASSED.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
