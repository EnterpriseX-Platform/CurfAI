import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireAdminOrEditor, tenantWhere } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { probeRestDataSource } from "@/lib/connections/probe";
import { decodeRestConnection, resolveRestHeaders } from "@/lib/connections/rest";

/**
 * POST /api/data-sources/[id]/probe
 *
 * Run a sample HTTP probe against a REST DataSource and store the inferred
 * field schema on DataSource.discoveredSchemaJson. Used by the Generate
 * AI feature to teach Claude what fields are available without making a
 * fresh HTTP call on every prompt.
 *
 * Body (all optional):
 *   path:     URL path to GET (defaults to "/")
 *   jsonPath: dotted path into the response, e.g. "$.data.items"
 *
 * Returns the freshly-discovered schema so the UI can render a preview.
 * Audit-logged. Editor/admin only.
 */

const Schema = z.object({
  path: z.string().max(500).optional(),
  jsonPath: z.string().max(200).optional(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;

  const ds = await prisma.dataSource.findFirst({
    where: { id: params.id, ...tenantWhere(user) },
    select: { id: true, name: true, kind: true, connection: true },
  });
  if (!ds) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (ds.kind !== "rest") {
    return NextResponse.json(
      { error: "Probe is only supported for REST data sources. SQLite is introspected automatically." },
      { status: 400 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }

  // probeRestDataSource expects a plaintext {baseUrl, headers} JSON blob;
  // the stored row has headers encrypted, so decrypt just for this call.
  let connectionJson = ds.connection;
  try {
    const stored = decodeRestConnection(ds.connection);
    connectionJson = JSON.stringify({ baseUrl: stored.baseUrl, headers: resolveRestHeaders(stored) });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Could not resolve connection" }, { status: 400 });
  }

  const result = await probeRestDataSource(connectionJson, parsed.data);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, httpStatus: result.httpStatus, raw: result.raw },
      { status: 422 },
    );
  }

  await prisma.dataSource.update({
    where: { id: ds.id },
    data: { discoveredSchemaJson: JSON.stringify(result.schema) },
  });

  recordAudit({
    user, kind: "datasource.schema.probe", target: ds.id, req,
    meta: {
      name: ds.name,
      fieldCount: result.schema.fields.length,
      jsonPath: result.schema.jsonPath,
      probedFrom: result.schema.probedFrom,
    },
  });

  return NextResponse.json({ ok: true, schema: result.schema });
}
