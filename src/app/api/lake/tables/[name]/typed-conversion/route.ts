/**
 * /api/lake/tables/[name]/typed-conversion — E1b Phase D4
 * (E1B_PHASE_D_SCOPING_PLAN.md): convert an EXISTING table's legacy TEXT
 * columns to physically typed ones.
 *
 *   GET   read-only preview: which columns qualify, and for each the exact
 *         count (plus a sample) of cells that would LOSE information.
 *   POST  apply. Body: { columns: string[], confirmedLossy: { [column]: n } }
 *         `confirmedLossy` is the count the admin was shown and confirmed.
 *         The server aborts (409 `drift`, nothing changed) unless the
 *         rebuild would lose exactly that many cells — so "what you
 *         confirmed" is "what happens" even if the data moved in between.
 *
 * Admin-only and session-only: this rewrites real customer rows and is
 * irreversible, and the whole point of the preview-then-confirm design is
 * that a person saw it — an API key can't stand in for that. Off unless
 * CURF_LAKE_TYPED_COLUMNS is on (GET still works, so an admin can see what
 * enabling it would do).
 *
 * Refusals are 409s with a stable `code`: `typed_columns_disabled`,
 * `branch_open` / `conversion_in_progress` (the D3 guard — a later branch
 * merge would silently revert the conversion), and `drift`.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { lakeTableFor } from "@/lib/lake/tableAccess";
import { previewTypedConversion, typedColumnsEnabled } from "@/lib/lake/tables";
import { isTypedConversionBlockedError, isTypedConversionDriftError } from "@/lib/lake/typedConversionErrors";
import { convertTableColumns } from "@/lib/lake/typedConversionApply";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ApplySchema = z.object({
  columns: z.array(z.string().min(1).max(60)).min(1).max(200),
  confirmedLossy: z.record(z.string(), z.number().int().min(0)),
}).refine((b) => b.columns.every((c) => Object.prototype.hasOwnProperty.call(b.confirmedLossy, c)), {
  message: "confirmedLossy needs an entry for every column being converted",
  path: ["confirmedLossy"],
});

async function authorize(req: NextRequest, rawName: string) {
  const user = await requireUser(req);
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (user.viaApiKey) {
    return { error: NextResponse.json({ error: "Converting column types needs a signed-in admin, not an API key." }, { status: 403 }) };
  }
  if (user.role !== "admin") {
    return { error: NextResponse.json({ error: "Admins only." }, { status: 403 }) };
  }
  // Even an admin converts only a table they can read (lib/lake/acl.ts: a
  // role-restricted or owner-only table can exclude admins too).
  const access = await lakeTableFor(user, decodeURIComponent(rawName), "build");
  if (access instanceof NextResponse) return { error: access };
  return { user, row: access.row };
}

export async function GET(req: NextRequest, { params }: { params: { name: string } }) {
  const auth = await authorize(req, params.name);
  if (auth.error) return auth.error;
  const { user, row } = auth;

  try {
    const preview = await previewTypedConversion({ tenantId: user.tenantId, tableName: row.name });
    return NextResponse.json({ enabled: typedColumnsEnabled(), preview });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Preview failed" }, { status: /not found/i.test(e?.message ?? "") ? 404 : 400 });
  }
}

export async function POST(req: NextRequest, { params }: { params: { name: string } }) {
  const auth = await authorize(req, params.name);
  if (auth.error) return auth.error;
  const { user, row } = auth;

  if (!typedColumnsEnabled()) {
    return NextResponse.json(
      { error: "Typed columns aren't enabled for this deployment.", code: "typed_columns_disabled" },
      { status: 409 },
    );
  }

  const parsed = ApplySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }
  const { columns, confirmedLossy } = parsed.data;

  // The rebuild and everything kept in step with it (catalog, cache, embeddings, audit): lib/lake/typedConversionApply.
  let result, schema;
  try {
    ({ result, schema } = await convertTableColumns({
      tenantId: user.tenantId, row, columns, confirmedLossy, user, req,
    }));
  } catch (e: any) {
    if (isTypedConversionDriftError(e)) {
      return NextResponse.json(
        { error: e.message, code: "drift", expected: e.expected, actual: e.actual },
        { status: 409 },
      );
    }
    if (isTypedConversionBlockedError(e)) {
      return NextResponse.json({ error: e.message, code: e.reason }, { status: 409 });
    }
    return NextResponse.json({ error: e?.message ?? "Conversion failed" }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    result: {
      convertedColumns: result.convertedColumns,
      skippedColumns: result.skippedColumns,
      lossyCells: result.lossyCells,
      lossyByColumn: result.lossyByColumn,
    },
    schema,
  });
}
