/**
 * /api/lake/tables
 *
 *   GET   — list this tenant's lake tables (catalog rows merged with
 *           on-disk row count + size sanity-check).
 *   POST  — create a new table from either a multipart file upload OR
 *           a JSON body of {name, rows[]}. Both paths quota-check first,
 *           write to the per-tenant lake SQLite, and persist a LakeTable
 *           row for the catalog.
 *
 * Why one endpoint for two payload shapes? Both are "create from a payload
 * that's already in memory" — splitting them would mean two routes that
 * share 80% of the same gating + persistence logic.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { blockScopedApiKey, requireAdminOrEditor, requireUser, type CurfSessionUser } from "@/lib/auth";
import { redactSamples } from "@/lib/lake/redaction";
import { parseSchemaJson } from "@/lib/lake/schemaGovernance";
import { createOrReplaceTable } from "@/lib/lake/tables";
import { checkWriteAllowed, getQuotaForTenant, getUsageForTenant } from "@/lib/lake/quota";
import { parseUpload } from "@/lib/lake/parseFile";
import { newTableNameProblem, registerCreatedTable } from "@/lib/lake/tableRegistration";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB per upload — Phase 1 cap

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // A key scoped to reports has no mandate over tables (lib/lake/tableAccess.ts).
  const scoped = blockScopedApiKey(user);
  if (scoped) return scoped;
  const { canRead, loadRoleSlugs } = await import("@/lib/lake/acl");
  const roleSlugs = await loadRoleSlugs(user.id, user.tenantId);
  const viewer = { id: user.id, tenantId: user.tenantId, role: user.role, roleSlugs };

  const [allItems, quota, usage] = await Promise.all([
    prisma.lakeTable.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { updatedAt: "desc" },
    }),
    getQuotaForTenant(user.tenantId),
    getUsageForTenant(user.tenantId),
  ]);
  // Filter through ACL after load. The catalog scan is small enough
  // that doing it in JS is fine; if we ever need to push down to SQL we
  // can add the predicate to the where clause.
  const items = (allItems as any[]).filter((t) => canRead(viewer, t));
  return NextResponse.json({
    items: items.map((t: any) => ({
      id: t.id,
      name: t.name,
      sourceKind: t.sourceKind,
      sourceConfig: safeJson(t.sourceConfigJson),
      // Each column's sample is a value from the table: masked as this
      // viewer's rows would be, like every other route that lists columns.
      schema: redactSamples(parseSchemaJson(t.schemaJson), viewer),
      rowCount: t.rowCount,
      sizeBytes: t.sizeBytes,
      ownerUserId: t.ownerUserId,
      visibleToRoles: safeJson(t.visibleToRolesJson) ?? [],
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
    quota,
    usage,
  });
}

const JsonBodySchema = z.object({
  name: z.string().min(1).max(60),
  rows: z.array(z.record(z.string(), z.unknown())).min(0).max(50_000),
});

// Matches LakeColumn["type"] in lib/lake/tables.ts. Kept as a separate
// literal union here rather than importing the type (a zod schema needs a
// runtime value, not just the TS type) — the two are trivially easy to keep
// in sync since neither changes often.
const ColumnTypeOverridesSchema = z.record(
  z.string(),
  z.enum(["text", "number", "boolean", "date", "unknown"]),
);

// Day-first vs month-first, per column. Only meaningful for date columns,
// and only sent when the preview told the user the file didn't say.
const ColumnDateOrdersSchema = z.record(z.string(), z.enum(["mdy", "dmy"]));

export async function POST(req: NextRequest) {
  // Top-level safety net: any thrown error becomes structured JSON instead
  // of an opaque 500 with an empty body. The earlier behaviour produced
  // bare 500s on malformed multipart payloads (the browser file-upload
  // bridge sometimes sends one) which then tripped the page's RSC fetcher
  // into showing a generic error toast that no one knew how to debug.
  try {
    return await postImpl(req);
  } catch (e: any) {
    const msg = (e?.message ?? String(e)).slice(0, 500);
    // eslint-disable-next-line no-console
    console.warn(`[POST /api/lake/tables] unexpected error: ${msg}`);
    // Treat parse-shaped messages as 4xx; everything else 500. Heuristic
    // but better than a bare 500 with no body.
    const lower = msg.toLowerCase();
    const looks4xx = /malformed|invalid|parse|missing|too large|expected/.test(lower);
    return NextResponse.json(
      { error: looks4xx ? msg : `Server error: ${msg}` },
      { status: looks4xx ? 400 : 500 },
    );
  }
}

async function postImpl(req: NextRequest) {
  // Creating a table is authoring: admin/developer, like every other lake
  // write route and the staged upload routes (viewer and executive are
  // read-only roles).
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;

  const contentType = req.headers.get("content-type") ?? "";

  // -------- Path A: multipart upload (CSV / XLSX / JSON) ------------------
  if (contentType.startsWith("multipart/form-data")) {
    let form: FormData;
    try { form = await req.formData(); }
    catch { return NextResponse.json({ error: "Invalid form-data" }, { status: 400 }); }

    const fileEntry = form.get("file");
    const requestedName = String(form.get("name") ?? "").trim();
    if (!(fileEntry instanceof File) || fileEntry.size === 0) {
      return NextResponse.json({ error: "Missing or empty file" }, { status: 400 });
    }
    if (fileEntry.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({
        error: `File is ${(fileEntry.size / 1024 / 1024).toFixed(1)} MB — Phase 1 cap is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB per upload.`,
      }, { status: 413 });
    }

    const filename = (fileEntry as any).name ?? "upload";
    const tableName = requestedName || filename.replace(/\.[^.]+$/, "");

    // Optional: per-column type corrections from the preview-and-confirm
    // dialog (POST .../preview runs first, shows the auto-detected schema,
    // and the user can override any column before this call). Absent for a
    // caller that skips the preview step (e.g. a script posting directly) —
    // inference alone still applies in that case, same as before this field
    // existed.
    let columnTypeOverrides: Record<string, string> | undefined;
    const columnTypesRaw = form.get("columnTypes");
    if (typeof columnTypesRaw === "string" && columnTypesRaw.trim()) {
      let rawParsed: unknown;
      try { rawParsed = JSON.parse(columnTypesRaw); }
      catch { return NextResponse.json({ error: "columnTypes must be valid JSON" }, { status: 400 }); }
      const parsedTypes = ColumnTypeOverridesSchema.safeParse(rawParsed);
      if (!parsedTypes.success) {
        return NextResponse.json({ error: "Invalid columnTypes", issues: parsedTypes.error.issues }, { status: 400 });
      }
      columnTypeOverrides = parsedTypes.data;
    }

    let columnDateOrders: Record<string, "mdy" | "dmy"> | undefined;
    const dateOrdersRaw = form.get("columnDateOrders");
    if (typeof dateOrdersRaw === "string" && dateOrdersRaw.trim()) {
      let rawParsed: unknown;
      try { rawParsed = JSON.parse(dateOrdersRaw); }
      catch { return NextResponse.json({ error: "columnDateOrders must be valid JSON" }, { status: 400 }); }
      const parsedOrders = ColumnDateOrdersSchema.safeParse(rawParsed);
      if (!parsedOrders.success) {
        return NextResponse.json({ error: "Invalid columnDateOrders", issues: parsedOrders.error.issues }, { status: 400 });
      }
      columnDateOrders = parsedOrders.data;
    }

    // Which workbook sheet the user confirmed in the preview dialog. The
    // browser re-sends the same File along with it, so the sheet the
    // preview showed is the sheet that gets imported.
    const sheetEntry = form.get("sheet");
    const sheet = typeof sheetEntry === "string" && sheetEntry.length > 0 ? sheetEntry : undefined;

    const buf = Buffer.from(await fileEntry.arrayBuffer());
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await parseUpload(buf, filename, { sheet });
    } catch (e: any) {
      return NextResponse.json({ error: `Parse failed: ${e?.message ?? e}` }, { status: 400 });
    }

    const blocked = await checkWriteAllowed({
      tenantId: user.tenantId,
      estimatedBytes: fileEntry.size,
      newTable: true,
    });
    if (blocked) return NextResponse.json({ error: blocked }, { status: 402 });

    return await persistTable({
      user,
      req,
      name: tableName,
      rows,
      sourceKind: "upload",
      sourceConfig: { filename, originalSize: fileEntry.size },
      columnTypeOverrides,
      columnDateOrders,
    });
  }

  // -------- Path B: JSON body { name, rows: [...] } ----------------------
  const body = await req.json().catch(() => null);
  const parsed = JsonBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }
  // Estimate bytes from the JSON payload — rough but conservative.
  const estimatedBytes = JSON.stringify(parsed.data.rows).length;
  const blocked = await checkWriteAllowed({
    tenantId: user.tenantId,
    estimatedBytes,
    newTable: true,
  });
  if (blocked) return NextResponse.json({ error: blocked }, { status: 402 });

  return await persistTable({
    user,
    req,
    name: parsed.data.name,
    rows: parsed.data.rows,
    sourceKind: "manual",
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// parseUpload() moved to lib/lake/parseFile.ts — shared with the SFTP pull
// (lib/lake/restPull.ts), which needed the exact same bytes-to-rows logic.

async function persistTable(opts: {
  user: CurfSessionUser;
  req: NextRequest;
  name: string;
  rows: Array<Record<string, unknown>>;
  sourceKind: "upload" | "manual";
  sourceConfig?: Record<string, unknown>;
  columnTypeOverrides?: Record<string, string>;
  columnDateOrders?: Record<string, "mdy" | "dmy">;
}) {
  const nameProblem = await newTableNameProblem(opts.user, opts.name);
  if (nameProblem) return NextResponse.json({ error: nameProblem.error }, { status: nameProblem.status });

  // Write to disk first; the catalog row last (registerCreatedTable) so a
  // failed write never leaves a catalog row pointing at nothing.
  const result = await createOrReplaceTable({
    tenantId: opts.user.tenantId,
    tableName: opts.name,
    rows: opts.rows,
    sourceKind: opts.sourceKind,
    sourceConfig: opts.sourceConfig,
    columnTypeOverrides: opts.columnTypeOverrides as Record<string, any> | undefined,
    columnDateOrders: opts.columnDateOrders,
  });

  const created = await registerCreatedTable({
    user: opts.user,
    req: opts.req,
    name: opts.name,
    sourceKind: opts.sourceKind,
    sourceConfig: opts.sourceConfig,
    columns: result.columns,
    rowCount: result.rowCount,
  });

  return NextResponse.json({
    table: {
      id: created.id,
      name: created.name,
      sourceKind: created.sourceKind,
      schema: result.columns,
      rowCount: created.rowCount,
      sizeBytes: created.sizeBytes,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    },
  });
}

function safeJson(s: string | null | undefined): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
