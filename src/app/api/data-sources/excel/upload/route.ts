import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { writeVisibility, type Visibility } from "@/lib/datasourceAcl";
import {
  parseExcelToSqlite,
  MAX_FILE_BYTES,
  MAX_ROWS_PER_SHEET,
} from "@/lib/connections/excelImport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tier-based caps on how many Excel-imported data sources a tenant can keep.
 * Excel imports each cost a real SQLite file on disk under var/tenants/<id>/,
 * so unbounded uploads on the free plan would be a footgun.
 */
const EXCEL_LIMIT_BY_TIER: Record<string, number> = {
  community: 1,
  growth: 5,
  business: Infinity,
};

/**
 * POST /api/data-sources/excel/upload
 *
 * multipart/form-data fields:
 *   file (required)  — the .xlsx
 *   name (optional)  — display name; defaults to the filename minus extension
 *
 * Pipeline:
 *   1. auth + tier gate
 *   2. parse the workbook into a per-tenant SQLite file at
 *        var/tenants/<tenantId>/uploads/<newDataSourceId>.db
 *   3. persist a DataSource row with kind="excel", connection=<dbPath>, and
 *      the import schema in discoveredSchemaJson (so AI Generate sees it).
 *   4. audit, return the new DataSource id + schema preview.
 *
 * If the parse fails the SQLite file is rolled back so we don't leave an
 * orphan on disk. If the row insert fails after a successful parse, the
 * file is also unlinked.
 */
export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  // Tier gate. We read the limit by the session's tier and count existing
  // excel rows. Cheap query — 1 indexed by tenantId.
  const tenant = await prisma.tenant.findUnique({
    where: { id: user.tenantId },
    select: { tier: true },
  });
  const tier = (tenant?.tier as string) ?? "community";
  const limit = EXCEL_LIMIT_BY_TIER[tier] ?? EXCEL_LIMIT_BY_TIER.community;
  const existing = await prisma.dataSource.count({
    where: { tenantId: user.tenantId, kind: "excel" },
  });
  if (existing >= limit) {
    return NextResponse.json(
      {
        error:
          `Your plan (${tier}) allows ${limit === Infinity ? "unlimited" : limit} Excel ` +
          `connection${limit === 1 ? "" : "s"}. Delete an existing Excel connection or upgrade to add more.`,
        upgradeRequired: tier !== "business",
      },
      { status: 402 },
    );
  }

  // multipart/form-data parsing — Next 14 supports req.formData() natively.
  let form: FormData;
  try {
    form = await req.formData();
  } catch (e: any) {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const fileEntry = form.get("file");
  if (!(fileEntry instanceof File)) {
    return NextResponse.json({ error: 'Missing "file" field' }, { status: 400 });
  }
  if (fileEntry.size === 0) {
    return NextResponse.json({ error: "File is empty" }, { status: 400 });
  }
  if (fileEntry.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      {
        error:
          `File is ${(fileEntry.size / 1024 / 1024).toFixed(1)} MB — exceeds the ` +
          `${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)} MB cap. For larger datasets, use the Postgres connector.`,
      },
      { status: 413 },
    );
  }

  const originalFilename = (fileEntry as any).name || "upload.xlsx";
  const buf = Buffer.from(await fileEntry.arrayBuffer());

  // Pre-mint the DataSource id so the file path is stable before the row
  // exists. 24 hex chars matches the rough length of cuid ids elsewhere.
  const dsId = "ex_" + randomBytes(12).toString("hex");
  const tenantUploadDir = path.join(process.cwd(), "var", "tenants", user.tenantId, "uploads");
  const dbPath = path.join(tenantUploadDir, dsId + ".db");

  const parseResult = await parseExcelToSqlite(buf, dbPath, originalFilename);
  if (!parseResult.ok) {
    return NextResponse.json({ error: parseResult.error }, { status: 400 });
  }

  // Default the connection name to the filename minus extension; the user
  // can rename later from /admin/connections.
  const formName = String(form.get("name") ?? "").trim();
  const fallbackName = originalFilename.replace(/\.(xlsx|xlsm|xls)$/i, "") || "Excel upload";
  const name = formName || fallbackName;

  // Visibility input. Form fields:
  //   visibility = "tenant" | "roles" | "owner_only"   (defaults to "tenant")
  //   roles      = repeated form field with role slugs (only used when mode=roles)
  // We map into the typed Visibility and persist via writeVisibility().
  const mode = (String(form.get("visibility") ?? "tenant") as Visibility["mode"]);
  let visibility: Visibility;
  if (mode === "owner_only") {
    visibility = { mode: "owner_only", ownerUserId: user.id };
  } else if (mode === "roles") {
    const roleEntries = form.getAll("roles").map((r) => String(r)).filter(Boolean);
    if (roleEntries.length === 0) {
      // Pick "Roles" but specified zero is the same as "Tenant" — silently
      // degrade rather than make the user pick again.
      visibility = { mode: "tenant" };
    } else {
      visibility = { mode: "roles", roles: roleEntries };
    }
  } else {
    visibility = { mode: "tenant" };
  }
  const aclColumns = writeVisibility(visibility);

  let created: any;
  try {
    created = await prisma.dataSource.create({
      data: {
        id: dsId,
        tenantId: user.tenantId,
        name,
        kind: "excel",
        connection: dbPath,
        discoveredSchemaJson: JSON.stringify(parseResult.schema),
        visibleToRolesJson: aclColumns.visibleToRolesJson,
        ownerUserId: aclColumns.ownerUserId,
      },
      select: { id: true, name: true, kind: true, createdAt: true },
    });
  } catch (e: any) {
    // Clean up the orphan SQLite file before bubbling the error up.
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    if (e?.code === "P2002") {
      return NextResponse.json(
        { error: `A connection named "${name}" already exists. Pick a different name.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: e?.message ?? "Failed to create connection" }, { status: 500 });
  }

  recordAudit({
    user,
    kind: "datasource.create",
    target: created.id,
    req,
    meta: {
      name,
      kind: "excel",
      sourceFilename: originalFilename,
      fileSize: buf.byteLength,
      tableCount: parseResult.schema.tables.length,
      rowCount: parseResult.schema.tables.reduce((acc, t) => acc + t.rowCount, 0),
      visibility: visibility.mode,
      visibleToRoles: visibility.mode === "roles" ? visibility.roles : undefined,
    },
  });

  return NextResponse.json({
    id: created.id,
    name: created.name,
    kind: created.kind,
    createdAt: created.createdAt,
    schema: parseResult.schema,
    limits: { maxFileBytes: MAX_FILE_BYTES, maxRowsPerSheet: MAX_ROWS_PER_SHEET },
  });
}
