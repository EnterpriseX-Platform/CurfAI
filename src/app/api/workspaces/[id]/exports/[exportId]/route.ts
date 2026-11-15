/**
 * GET /api/workspaces/[id]/exports/[exportId] — download a finished export (the zip).
 *
 * A real admin of the workspace only (see ../route.ts), and the export must belong to that workspace: the id alone is
 * never enough. The download is audited, with the audit row written before any byte is sent.
 */
import fs from "node:fs";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { persistAudit } from "@/lib/audit";
import { withSystemDbContext } from "@/lib/dbContext";
import { findDownloadableExport } from "@/lib/lifecycle/export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string; exportId: string }> }
) {
  const params = await props.params;
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.viaApiKey) return NextResponse.json({ error: "Session required" }, { status: 403 });
  const m = (user.memberships ?? []).find((x) => !x.isVirtual && x.tenantId === params.id);
  if (!m || m.role !== "admin") return NextResponse.json({ error: "Only an admin of this workspace can download its export" }, { status: 403 });

  const e = await findDownloadableExport(params.exportId, [params.id]);
  if (!e || !e.filePath) return NextResponse.json({ error: "Export not found, not ready, or expired" }, { status: 404 });

  await withSystemDbContext(() => persistAudit({ user, tenantId: params.id, kind: "tenant.export.download", target: e.id, req, meta: { sizeBytes: e.sizeBytes } }));

  const stat = fs.statSync(e.filePath);
  const stream = Readable.toWeb(fs.createReadStream(e.filePath)) as unknown as ReadableStream;
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(stat.size),
      "Content-Disposition": `attachment; filename="curf-workspace-export-${e.id}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
