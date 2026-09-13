import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { emptyReport } from "@/lib/reporting/schema";
import { requireUser, reportWhere, blockScopedApiKey } from "@/lib/auth";
import { withTenantContext } from "@/lib/rls";
import { recordAudit } from "@/lib/audit";
import { emitWebhook } from "@/lib/webhooks";
import { requireReportQuota, QuotaBlockedError } from "@/lib/billing";
import { toSafeTableName } from "@/lib/lake/storage";
import crypto from "node:crypto";
import { canBuild } from "@/lib/roles";

function appBase(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (proto && host) return `${proto}://${host}`;
  return process.env.NEXTAUTH_URL ?? new URL(req.url).origin;
}

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const items = await withTenantContext(user, (tx) =>
    tx.report.findMany({
      where: reportWhere(user),
      orderBy: { updatedAt: "desc" },
      select: { id: true, name: true, category: true, updatedAt: true },
    })
  );
  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  const base = appBase(req);
  if (!user) return NextResponse.redirect(new URL("/login", base));
  // Viewers consume reports; only editors and admins can create them.
  if (!canBuild(user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // A report-scoped key is meant to be limited to its allowlisted reports —
  // creating a brand-new one (and consuming report quota) is outside that.
  const scopeBlock = blockScopedApiKey(user);
  if (scopeBlock) return scopeBlock;
  // Optional "create from lake table" path: when the form submission
  // includes a lakeTable field (set by the "Use in a report" CTA on
  // /tables/[name]), pre-seed the draft with a query + table block over
  // that table so the user lands on a fully-rendered report instead of
  // a blank canvas. Falls back to the empty-report path on any failure.
  const url = new URL(req.url);
  let lakeTableParam = url.searchParams.get("lakeTable");
  if (!lakeTableParam) {
    // Form-encoded POST body — read once if the URL didn't carry it.
    try {
      const body = await req.formData();
      const v = body.get("lakeTable");
      if (typeof v === "string") lakeTableParam = v;
    } catch {
      /* not form-encoded, no lake seed — use empty report */
    }
  }

  let def = emptyReport(lakeTableParam ? `${lakeTableParam}` : "Untitled Report");
  if (lakeTableParam) {
    try {
      def = await seedReportFromLakeTable(user, lakeTableParam, def);
    } catch (e) {
      console.warn("[reports.POST] lake seed failed, falling back to empty:", e);
    }
  }
  // Quota check + create share one SERIALIZABLE transaction (OWASP
  // A06:2025) — concurrent requests racing the same tenant's cap can no
  // longer all pass the check before any of them lands.
  let created;
  try {
    created = await withTenantContext(
      user,
      async (tx) => {
        const block = await requireReportQuota(user, tx);
        if (block) throw new QuotaBlockedError(block);
        return tx.report.create({
          data: {
            tenantId: user.tenantId,
            name: def.name,
            definition: JSON.stringify(def),
            createdById: user.id,
          },
        });
      },
      { isolationLevel: "Serializable", maxRetries: 3 },
    );
  } catch (e) {
    if (e instanceof QuotaBlockedError) return e.response;
    throw e;
  }

  recordAudit({
    user, kind: "report.create", target: created.id, req,
    meta: { name: created.name },
  });
  void emitWebhook({
    tenantId: user.tenantId,
    event: "report.created",
    data: { reportId: created.id, reportName: created.name, createdBy: user.email, via: "manual" },
  });

  return NextResponse.redirect(new URL("/reports/" + created.id + "/edit", base));
}

/**
 * Build a draft Report definition pre-wired to one Curf Tables lake table.
 *
 *  - Confirms the LakeTable exists in the caller's tenant.
 *  - Resolves the per-tenant "Curf Tables" DataSource row (auto-created on
 *    first lake table; we upsert here as a defensive belt-and-suspenders).
 *  - Builds a single DataSourceDef with `SELECT * FROM <table> LIMIT 100`
 *    against the lake DataSource.
 *  - Adds one table block at the top of the page bound to that query.
 *
 * Returns the seeded Report shape — caller persists it.
 */
async function seedReportFromLakeTable(
  user: { id: string; tenantId: string },
  rawTableName: string,
  base: ReturnType<typeof emptyReport>,
): Promise<ReturnType<typeof emptyReport>> {
  // 1. Confirm the lake table exists + belongs to this tenant.
  const lakeRow = await prisma.lakeTable.findFirst({
    where: { tenantId: user.tenantId, name: rawTableName },
    select: { id: true, name: true, schemaJson: true },
  });
  if (!lakeRow) throw new Error(`Lake table "${rawTableName}" not found`);

  // 2. Get-or-create the per-tenant Curf Tables DataSource. Same upsert as
  //    the lake table create path — idempotent.
  const lakeDs = await prisma.dataSource.upsert({
    where: { tenantId_name: { tenantId: user.tenantId, name: "Curf Tables" } },
    update: {},
    create: {
      tenantId: user.tenantId,
      name: "Curf Tables",
      kind: "lake",
      connection: "lake://" + user.tenantId,
    },
  });

  // 3. Synthesise the query + block. Use the on-disk safe table name in
  //    the SQL since the runner queries against the actual SQLite table.
  const safeName = toSafeTableName(lakeRow.name);
  const queryId = "q_" + crypto.randomBytes(4).toString("hex");
  const blockId = "b_" + crypto.randomBytes(4).toString("hex");

  // Pull the inferred schema off the LakeTable row and turn it into
  // explicit table-block columns. The TableBlock renderer doesn't
  // auto-derive from data when columns[] is empty, so giving it concrete
  // column definitions here is what makes the rendered preview show rows
  // immediately. Type maps to the renderer's supported set:
  //   number → number-aligned right + numeric formatting
  //   date   → date column type for sorting
  //   text   → default left-aligned string
  let lakeSchema: Array<{ name: string; type: string }> = [];
  try { lakeSchema = JSON.parse(lakeRow.schemaJson) as any[]; } catch { /* ignore */ }
  const columns = lakeSchema.map((c) => ({
    key: c.name,
    label: c.name,
    type: c.type === "number" ? "number" : c.type === "date" ? "date" : "string",
  }));

  base.name = lakeRow.name;
  base.dataSources = [
    {
      id: queryId,
      name: lakeRow.name,
      dataSourceId: lakeDs.id,
      sql: `SELECT * FROM "${safeName}" LIMIT 100`,
    },
  ];
  base.pages[0].blocks = [
    {
      id: blockId,
      type: "table",
      x: 0, y: 0, w: 12, h: 8,
      config: {
        queryId,
        title: lakeRow.name,
        columns,
        pageSize: 50,
        stripe: true,
        showTotals: true,
        actions: [],
      },
    } as any,
  ];
  return base;
}
