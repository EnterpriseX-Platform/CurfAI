/**
 * /api/lake/tables/[name]/sensitivity — set / clear column sensitivity tags.
 *
 * Body: { column: "email", sensitivity: "pii" | null, unredactedForRoles?: ["analyst"] }
 *
 * Builders who can read the table (lib/lake/tableAccess.ts). Sensitivity is
 * persisted on the LakeTable row's schemaJson alongside the rest of the
 * column metadata — keeps the source of truth in one place.
 *
 * Setting sensitivity to null clears the tag (column treated as ordinary).
 * A formula column can't be tagged: it carries the tags of the columns it's
 * worked out from (withFormulaGovernance), re-derived on every save here.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { withFormulaGovernance } from "@/lib/lake/schemaGovernance";
import { lakeTableFor } from "@/lib/lake/tableAccess";
import { redactSamples } from "@/lib/lake/redaction";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  column: z.string().min(1).max(60),
  sensitivity: z.enum(["pii", "financial", "health", "secret"]).nullable(),
  unredactedForRoles: z.array(z.string().min(1)).max(20).optional(),
});

export async function POST(req: NextRequest, { params }: { params: { name: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // A builder who can read the table; one they can't read is not found.
  const access = await lakeTableFor(user, decodeURIComponent(params.name), "build");
  if (access instanceof NextResponse) return access;
  const { row, viewer } = access;

  const body = await req.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  // Walk the cached schema and update the matching column. Preserves
  // the type/sample fields untouched.
  let schema: any[];
  try { schema = JSON.parse(row.schemaJson) ?? []; }
  catch { schema = []; }
  const idx = schema.findIndex((c) => c.name === parsed.data.column);
  if (idx === -1) return NextResponse.json({ error: `Column "${parsed.data.column}" not in schema` }, { status: 404 });
  if (schema[idx].formula) {
    return NextResponse.json({
      error: `${parsed.data.column} is a formula column — it's masked wherever the columns it's worked out from are. Tag those instead.`,
    }, { status: 400 });
  }

  if (parsed.data.sensitivity == null) {
    delete schema[idx].sensitivity;
    delete schema[idx].unredactedForRoles;
  } else {
    schema[idx].sensitivity = parsed.data.sensitivity;
    if (parsed.data.unredactedForRoles !== undefined) {
      schema[idx].unredactedForRoles = parsed.data.unredactedForRoles;
    }
  }

  await prisma.lakeTable.update({
    where: { id: row.id },
    data: { schemaJson: JSON.stringify(withFormulaGovernance(schema)), updatedAt: new Date() },
  });

  recordAudit({
    user, kind: "lake.table.sensitivity.update", target: row.id, req,
    meta: {
      name: row.name,
      column: parsed.data.column,
      sensitivity: parsed.data.sensitivity,
      unredactedForRoles: parsed.data.unredactedForRoles ?? [],
    },
  });

  // Its sample is a value from the table: masked as the viewer's rows would be.
  return NextResponse.json({ ok: true, column: redactSamples([schema[idx]], viewer)[0] });
}
