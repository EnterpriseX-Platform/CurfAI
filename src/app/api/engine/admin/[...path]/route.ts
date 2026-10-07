import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { engineContextFor } from "@/lib/engine/dataSource";
import { engineCall, engineJson } from "@/lib/engine/client";
import { ADMIN_BODY_MAX_BYTES, adminAuditMeta, adminQuery, matchAdminRoute } from "@/lib/engine/adminProxy";

export const dynamic = "force-dynamic";

/**
 * Curf's admin console talking to the engine behind one engine data source, as the admin (their token, their
 * workspace). The engine decides what an admin may do; this decides what can be asked at all
 * (lib/engine/adminProxy.ts: a fixed list of paths and methods) and records every change.
 *
 *   /api/engine/admin/views ...?dataSourceId=<engine data source>
 *
 * Admins only. The body of a call is passed on and never logged or audited: a connection holds a password.
 */
async function handle(req: NextRequest, { params }: { params: { path: string[] } }) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const url = new URL(req.url);
  const dataSourceId = url.searchParams.get("dataSourceId");
  if (!dataSourceId) return NextResponse.json({ error: "dataSourceId is required" }, { status: 400 });

  const route = matchAdminRoute(req.method, params.path ?? []);
  if (!route.ok) return NextResponse.json({ error: route.status === 405 ? "Method not allowed" : "Not found" }, { status: route.status });

  const ctx = await engineContextFor(user, dataSourceId);
  if (ctx instanceof NextResponse) return ctx;

  let body: unknown;
  if (req.method === "POST" || req.method === "PUT") {
    const text = await req.text();
    if (Buffer.byteLength(text) > ADMIN_BODY_MAX_BYTES) return NextResponse.json({ error: "The request is too large." }, { status: 413 });
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        return NextResponse.json({ error: "The request body must be JSON." }, { status: 400 });
      }
    }
  }

  let res: Response;
  try {
    res = await engineCall({
      target: ctx.target, viewer: ctx.viewer, tenantId: ctx.tenantId,
      method: req.method, path: `${route.path}${adminQuery(url.searchParams)}`, body,
      // A read can be repeated if the engine is busy; a change cannot.
      idempotent: req.method === "GET",
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "The engine could not be reached." }, { status: 502 });
  }

  if (req.method !== "GET" && res.status < 400) {
    recordAudit({ user, kind: "engine.admin", target: dataSourceId, req, meta: adminAuditMeta(req.method, route.path) });
  }

  if (res.status === 204) return new NextResponse(null, { status: 204 });

  let payload: any;
  try {
    payload = await engineJson(res);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "The engine's answer could not be read." }, { status: 502 });
  }

  // The engine rejecting Curf's own identity (401) or failing (5xx) is not something the admin did: it is a bad
  // gateway. Everything else — a refusal, a missing item, a stale version, invalid input — is passed on as the
  // engine said it, with its explanation (RFC 9457), which is what the screen shows.
  const status = res.status === 401 || res.status >= 500 ? 502 : res.status;
  if (res.status === 401) return NextResponse.json({ error: "The engine did not accept Curf's identity token (check its issuer and key settings)." }, { status });
  return NextResponse.json(payload ?? {}, { status });
}

export { handle as GET, handle as POST, handle as PUT, handle as DELETE };
