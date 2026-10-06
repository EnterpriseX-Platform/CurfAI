/**
 * Apply a Master Builder plan file to a workspace as one of its members —
 * for a build a person asked for that was designed and reviewed outside the
 * planner (the first: an old-vs-new provision comparison, 2026-09-28).
 *
 * It takes the apply route's own path — beginBuild, then applyBuildPlan —
 * so every report passes the pre-publish gate and the build shows in /build
 * like any other. MVS=<file> optionally lists materialized views
 * [{ name, sql }] to create (or reuse by name) and refresh first, through
 * refreshMaterializedView: what the Tables page does, and what the plan's
 * "existing" tables then read. BUILD_ID=<id> instead stores the plan on a build
 * this script started and runs the product's Rebuild (snapshot, teardown,
 * re-apply) — for correcting one. ONSCREEN=<file> then (or, without PLAN,
 * on its own) sets up an On Screen
 * display over the build's reports by name ({ name, slug, reportNames,
 * rotationSeconds, theme, layout }), through createOnScreenDisplay.
 *
 * In the app's pod:
 *   node node_modules/esbuild/bin/esbuild scripts/master-builder/apply-plan.ts --bundle --platform=node \
 *     --format=cjs --packages=external --outfile=apply-plan.cjs
 *   kubectl -n curfai exec -i <pod> -c curfai -- sh -c 'cat > /tmp/plan.json' < plan.json   (and mvs.json)
 *   kubectl -n curfai exec -i <pod> -c curfai -- sh -c 'cd /app && TENANT_ID=… USER_ID=… PLAN=/tmp/plan.json MVS=/tmp/mvs.json node -' < apply-plan.cjs
 */
import { readFileSync } from "fs";
import { prisma } from "@/lib/db";
import { persistAudit } from "@/lib/audit";
import { ensureLakeDataSource } from "@/lib/lake/lakeDataSource";
import { refreshMaterializedView } from "@/lib/lake/materialize";
import { BuildPlan } from "@/lib/master-builder/types";
import { beginBuild } from "@/lib/master-builder/beginBuild";
import { applyBuildPlan } from "@/lib/master-builder/applier";
import { rebuildBuild } from "@/lib/master-builder/rebuild";
import { createOnScreenDisplay, type OnScreenLayout } from "@/lib/onScreen";

const TENANT_ID = process.env.TENANT_ID ?? "";
const USER_ID = process.env.USER_ID ?? "";

async function main() {
  const member = await prisma.membership.findUnique({ where: { userId_tenantId: { userId: USER_ID, tenantId: TENANT_ID } }, select: { role: true } });
  if (!member || member.role === "viewer" || member.role === "executive") throw new Error("USER_ID must be a builder (admin/editor) in TENANT_ID");

  if (process.env.MVS) {
    const lake = await ensureLakeDataSource(TENANT_ID);
    for (const def of JSON.parse(readFileSync(process.env.MVS, "utf8")) as Array<{ name: string; sql: string }>) {
      if (!/^[a-zA-Z][a-zA-Z0-9_ ]*$/.test(def.name) || def.sql.length > 10_000) throw new Error(`materialized view "${def.name}" doesn't meet the Tables page's rules`);
      let mv = await prisma.materializedView.findFirst({ where: { tenantId: TENANT_ID, name: def.name }, select: { id: true, sql: true } });
      // Reusing one by name kept its old SQL whatever the file said. The Tables page can't edit an
      // MV's SQL either, so a changed one is refused: delete it there, or give the new one a new name.
      if (mv && mv.sql !== def.sql) throw new Error(`materialized view "${def.name}" exists with different SQL — delete it on the Tables page or rename the new one; nothing built`);
      if (!mv) {
        mv = await prisma.materializedView.create({
          data: { tenantId: TENANT_ID, name: def.name, sql: def.sql, dataSourceId: lake.id, cron: null, enabled: true, lastStatus: "never_run", createdById: USER_ID },
          select: { id: true, sql: true },
        });
        await persistAudit({ tenantId: TENANT_ID, userId: USER_ID, kind: "lake.mv.create", target: mv.id, meta: { name: def.name, dataSourceId: lake.id, via: "apply-plan" } });
      }
      const run = await refreshMaterializedView(mv.id);
      console.log(`materialized view ${def.name}: ${run.status}, ${run.rowCount} rows, ${run.durationMs} ms${run.error ? ` — ${run.error}` : ""}`);
      if (run.status !== "ok") throw new Error(`materialized view ${def.name} failed — nothing built`);
    }
  }

  let buildId: string | null = null;
  if (process.env.PLAN) {
    const plan = BuildPlan.parse(JSON.parse(readFileSync(process.env.PLAN, "utf8")));
    if (process.env.BUILD_ID) {
      // A corrected plan for a build this script started: store it, then the
      // product's own Rebuild — safety snapshot, teardown, re-apply.
      buildId = process.env.BUILD_ID;
      const updated = await (prisma as any).masterBuild.updateMany({ where: { id: buildId, tenantId: TENANT_ID }, data: { planJson: JSON.stringify(plan), prompt: plan.goal } });
      if (updated.count !== 1) throw new Error(`build ${buildId} not found in ${TENANT_ID}`);
      const { receipt, version } = await rebuildBuild({ tenantId: TENANT_ID, userId: USER_ID, buildId });
      console.log(`rebuild to v${version}: removed ${receipt.removed.length}, preserved ${receipt.preserved.length}, errors ${receipt.errors.length}, snapshot ${receipt.snapshot?.status ?? "none"}`);
      // The re-apply runs in this process; wait until it has written its own
      // version, not just until the row stops saying "building".
      for (let i = 0; i < 900; i++) {
        const s = await (prisma as any).masterBuild.findUnique({ where: { id: buildId }, select: { status: true, version: true } });
        if (s?.status !== "building" && s?.version === version) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    } else {
      const build = await beginBuild({ tenantId: TENANT_ID, createdById: USER_ID, plan });
      buildId = build.id;
      await persistAudit({ tenantId: TENANT_ID, userId: USER_ID, kind: "master_builder.created", target: buildId, meta: { domain: plan.domain, tableCount: plan.tables.length, via: "apply-plan" } });
      const result = await applyBuildPlan({ buildId, tenantId: TENANT_ID, userId: USER_ID, plan, mode: "first-build", version: 1 });
      console.log(JSON.stringify({ tables: result.tables, reports: result.reports, app: result.app, errors: result.errors }, null, 1));
    }
    const row = await (prisma as any).masterBuild.findUnique({ where: { id: buildId }, select: { status: true, version: true, statusJson: true } });
    console.log(`build ${buildId}: ${row?.status} v${row?.version}`);
  }
  if (process.env.ONSCREEN) {
    // A presentation display over reports this build made, by name. Report
    // ids change on every rebuild, so an existing display of that name is
    // re-pointed rather than duplicated.
    const def = JSON.parse(readFileSync(process.env.ONSCREEN, "utf8")) as { name: string; slug?: string; reportNames: string[]; rotationSeconds: number; theme: "light" | "dark"; layout: OnScreenLayout };
    const reports = await prisma.report.findMany({ where: { tenantId: TENANT_ID, name: { in: def.reportNames } }, select: { id: true, name: true } });
    const reportIds = def.reportNames.map((n) => reports.find((r) => r.name === n)?.id).filter((id): id is string => !!id);
    // A display pointed at reports that aren't there shows an empty wall.
    if (reportIds.length !== def.reportNames.length) throw new Error(`on screen: ${def.reportNames.length - reportIds.length} of its reports don't exist`);
    // By slug when the file names one, so renaming the display re-points it instead of adding a second.
    const existing = await prisma.onScreenDisplay.findFirst({ where: { tenantId: TENANT_ID, ...(def.slug ? { slug: def.slug } : { name: def.name }) }, select: { id: true, slug: true } });
    if (existing) {
      await prisma.onScreenDisplay.update({ where: { id: existing.id }, data: { name: def.name, reportIdsJson: JSON.stringify(reportIds), rotationSeconds: def.rotationSeconds, theme: def.theme, layout: def.layout } });
      console.log(`on screen ${existing.slug}: re-pointed at ${reportIds.length} report(s)`);
    } else {
      const created = await createOnScreenDisplay({ tenantId: TENANT_ID, createdById: USER_ID, name: def.name, slug: def.slug, reportIds, rotationSeconds: def.rotationSeconds, theme: def.theme, layout: def.layout, visibility: { mode: "tenant" } });
      if (!created) throw new Error("on screen: none of its reports exist");
      await persistAudit({ tenantId: TENANT_ID, userId: USER_ID, kind: "onScreen.create", target: created.id, meta: { name: created.name, slug: created.slug, reportCount: created.reportCount, via: "apply-plan" } });
      console.log(`on screen ${created.slug}: created with ${created.reportCount} report(s)`);
    }
  }

  if (!buildId) { await prisma.$disconnect(); return; }
  const build = { id: buildId };
  const artifacts = await (prisma as any).masterBuildArtifact.findMany({ where: { buildId: build.id }, select: { kind: true, name: true, status: true, refId: true, errorMessage: true } });
  for (const a of artifacts) console.log(`  ${a.kind} ${a.status} ${a.name} ${a.refId ?? ""}${a.errorMessage ? `\n    ${a.errorMessage}` : ""}`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e?.message ?? e); await prisma.$disconnect(); process.exit(1); });
