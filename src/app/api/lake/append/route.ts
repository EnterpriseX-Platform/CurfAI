/**
 * /api/lake/append — inbound webhook ingest.
 *
 * Authenticated via a tenant-scoped LakeIngestToken (see prisma model).
 * Token is passed as `Authorization: Bearer <prefix>.<secret>` OR
 * `?token=<prefix>.<secret>` for tools that can't set headers (Zapier,
 * embedded forms).
 *
 * Body: a JSON array of row objects (or a single object — we wrap to
 * an array). Cap of 1000 rows per request keeps the endpoint cheap and
 * lets us bound the LLM context for downstream Ask Curf scans.
 *
 * Append-only — you cannot truncate or update rows through this path.
 * That makes the security model simpler (a leaked token can't wipe data,
 * only add to it) at the cost of doing dedup on the consumer side.
 */
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { appendRows } from "@/lib/lake/tables";
import { checkWriteAllowed } from "@/lib/lake/quota";
import { lakeFileSize } from "@/lib/lake/storage";
import { bustLakeCacheForTenant } from "@/lib/lake/bust";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_ROWS_PER_REQUEST = 1000;

export async function POST(req: NextRequest) {
  // 1. Extract + validate the token. Same encoding scheme as ApiKey:
  //    `<prefix>.<secret>`. Prefix is the lookup index, secret is hashed
  //    with SHA-256 and compared in constant time.
  const url = new URL(req.url);
  const headerAuth = req.headers.get("authorization") ?? "";
  const headerToken = headerAuth.startsWith("Bearer ") ? headerAuth.slice(7) : null;
  const queryToken = url.searchParams.get("token");
  const raw = (headerToken ?? queryToken ?? "").trim();
  if (!raw || !raw.includes(".")) {
    return NextResponse.json({ error: "Missing or malformed token" }, { status: 401 });
  }
  const [prefix, secret] = raw.split(".", 2);

  const tokenRow = await prisma.lakeIngestToken.findUnique({ where: { prefix } });
  if (!tokenRow || tokenRow.revokedAt) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }
  const expected = crypto.createHash("sha256").update(secret).digest("hex");
  if (expected.length !== tokenRow.hashedSecret.length) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }
  let tokenOk = false;
  try { tokenOk = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(tokenRow.hashedSecret)); }
  catch { tokenOk = false; }
  if (!tokenOk) return NextResponse.json({ error: "Invalid token" }, { status: 401 });

  // 2. Parse body. Accept either an array or a single object (which we
  //    coerce to a one-element array). Reject anything else.
  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Body must be JSON" }, { status: 400 }); }
  const rows: any[] = Array.isArray(body) ? body : [body];
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, added: 0 });
  }
  if (rows.length > MAX_ROWS_PER_REQUEST) {
    return NextResponse.json({
      error: `Cap is ${MAX_ROWS_PER_REQUEST} rows per request — split into batches.`,
    }, { status: 413 });
  }
  // Discard non-object rows; this is the most common producer mistake
  // (sending strings or nulls in the array).
  const cleanRows = rows.filter((r) => r && typeof r === "object" && !Array.isArray(r));
  if (cleanRows.length === 0) {
    return NextResponse.json({ error: "No row objects found in payload" }, { status: 400 });
  }

  // 3. Quota check. Approximate bytes from the JSON serialisation length.
  const blocked = await checkWriteAllowed({
    tenantId: tokenRow.tenantId,
    estimatedBytes: JSON.stringify(cleanRows).length,
    // Upserting an existing table — only counts as "new" if the LakeTable
    // row isn't there yet.
    newTable: !(await prisma.lakeTable.findFirst({
      where: { tenantId: tokenRow.tenantId, name: tokenRow.tableName },
      select: { id: true },
    })),
  });
  if (blocked) return NextResponse.json({ error: blocked }, { status: 402 });

  // 4. Append. The lake helper handles "doesn't exist yet" → falls back
  //    to a create. Schema additions emit ALTER TABLE under the hood.
  const result = appendRows({
    tenantId: tokenRow.tenantId,
    tableName: tokenRow.tableName,
    rows: cleanRows,
  });

  // 5. Refresh the catalog row (or create one if this was the first ingest).
  const sizeBytes = lakeFileSize(tokenRow.tenantId);
  await prisma.lakeTable.upsert({
    where: { tenantId_name: { tenantId: tokenRow.tenantId, name: tokenRow.tableName } },
    update: {
      rowCount: { increment: result.added },
      sizeBytes,
      updatedAt: new Date(),
    },
    create: {
      tenantId: tokenRow.tenantId,
      name: tokenRow.tableName,
      sourceKind: "webhook",
      sourceConfigJson: JSON.stringify({ tokenId: tokenRow.id, label: tokenRow.label }),
      schemaJson: "[]",
      rowCount: result.added,
      sizeBytes,
      createdById: tokenRow.createdById,
    },
  });

  // 6. Mark the token as recently used so the admin UI can show liveness.
  await prisma.lakeIngestToken.update({
    where: { id: tokenRow.id },
    data: { lastUsedAt: new Date() },
  });

  // 7. Cached query results that read from the lake source are now stale.
  setImmediate(() => { void bustLakeCacheForTenant(tokenRow.tenantId); });

  return NextResponse.json({
    ok: true,
    table: tokenRow.tableName,
    added: result.added,
    newColumns: result.newColumns,
  });
}
