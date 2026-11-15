/**
 * GET /api/admin/audit/export — the audit log as CSV, with the same filters
 * as /admin/audit (?kind, family, user, target, window). Admins only; the
 * download is itself audited. Capped at MAX_ROWS, newest first: a longer
 * history is narrowed with the time window.
 */
import { NextRequest, NextResponse } from "next/server";
import Papa from "papaparse";
import { prisma } from "@/lib/db";
import { requireAdmin, tenantWhere } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { readAuditFilter, auditFilterWhere } from "@/lib/audit/filter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_ROWS = 50_000;

/** A spreadsheet runs a cell that starts with = + - @ (or a tab/CR) as a formula; a leading quote keeps it text. */
function safeCell(v: string | null | undefined): string {
  const s = v ?? "";
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

export async function GET(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const filter = readAuditFilter((k) => req.nextUrl.searchParams.get(k));
  const rows = await prisma.auditEvent.findMany({
    where: { ...tenantWhere(user), ...auditFilterWhere(filter) },
    orderBy: { createdAt: "desc" },
    take: MAX_ROWS,
    select: { createdAt: true, userEmail: true, kind: true, target: true, ip: true, onBehalfOfUserId: true, metaJson: true },
  });

  const csv = Papa.unparse({
    fields: ["time", "person", "action", "target", "ip", "on_behalf_of", "details"],
    data: rows.map((r) => [
      r.createdAt.toISOString(), safeCell(r.userEmail), safeCell(r.kind), safeCell(r.target),
      safeCell(r.ip), safeCell(r.onBehalfOfUserId), safeCell(r.metaJson === "{}" ? "" : r.metaJson),
    ]),
  });

  recordAudit({ user, req, kind: "audit.export", meta: { rows: rows.length, capped: rows.length === MAX_ROWS, ...filter } });

  const day = new Date().toISOString().slice(0, 10);
  return new NextResponse("﻿" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-${day}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
