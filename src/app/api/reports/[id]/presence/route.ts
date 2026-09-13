/**
 * /api/reports/[id]/presence — Server-Sent Events stream of viewer presence.
 *
 * GET (SSE):
 *   Subscribes the caller to presence changes for this report. Emits the
 *   full viewer list every time someone joins / leaves / ages out. Includes
 *   a 25s heartbeat ping so reverse proxies don't kill the connection.
 *
 * POST (heartbeat):
 *   The viewer pings this every 10s so we know they're still here. The
 *   server-side timeout reaps any viewer that hasn't pinged in IDLE_MS.
 *   Anonymous (no session) callers get a stable per-tab key from the
 *   request body so a single tab counts as one viewer.
 *
 * DELETE (leave):
 *   The viewer's `beforeunload` fires this with `keepalive` so the chip
 *   disappears right away on tab close. Best-effort — we still rely on
 *   the IDLE_MS reaper as the source of truth.
 *
 * Why not WebSockets? SSE is one-way (server→client), built into the
 * browser, works through any proxy that handles long-lived HTTP, and
 * doesn't require an upgrade handshake. Presence is a one-way push, so
 * SSE is the right tool.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireUser, requireReportInScope } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  heartbeat, leave, listViewers, subscribe,
  deriveInitials, hashHue,
  type PresenceUser,
} from "@/lib/presence";

export const dynamic = "force-dynamic";
// Streams require Node runtime (the edge runtime can do it but the rest of
// our auth + prisma stack is Node-only).
export const runtime = "nodejs";

async function authorize(req: NextRequest, reportId: string): Promise<{ tenantId: string; user: PresenceUser } | null> {
  const sess = await requireUser(req);
  if (!sess) return null;
  // A report-scoped API key must not get presence access to a report
  // outside its allowlist — same guard every other [id] route calls.
  if (requireReportInScope(sess, reportId)) return null;
  // Confirm the report is in the user's tenant — presence is private to a
  // tenant, no cross-tenant snooping via report id guesses.
  const report = await prisma.report.findFirst({
    where: { id: reportId, tenantId: sess.tenantId },
    select: { id: true },
  });
  if (!report) return null;
  return {
    tenantId: sess.tenantId,
    user: {
      key: sess.id,
      name: sess.name ?? (sess.email?.split("@")[0] ?? "Viewer"),
      email: sess.email,
      initials: deriveInitials(sess.name, sess.email),
      hue: hashHue(sess.id || sess.email || "anon"),
    },
  };
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await authorize(req, params.id);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const reportId = params.id;
  // Mark this client as present immediately so other viewers see them while
  // their browser is still negotiating the SSE handshake.
  heartbeat(reportId, ctx.user);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      function send(event: string, data: unknown) {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        try { controller.enqueue(encoder.encode(payload)); } catch { /* closed */ }
      }
      // Initial snapshot so the client doesn't have to wait for the first
      // change event.
      send("snapshot", { viewers: listViewers(reportId) });

      // Re-emit on every change.
      const unsubscribe = subscribe(reportId, (viewers) => {
        send("snapshot", { viewers });
      });

      // Heartbeat ping every 25s. SSE clients ignore comment lines; this
      // is just here to keep the connection alive across proxies.
      const ping = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`)); }
        catch { /* connection probably dead, cleanup will follow */ }
      }, 25_000);

      // Browser closed the tab → req.signal aborts → unwind the room.
      const onAbort = () => {
        clearInterval(ping);
        unsubscribe();
        leave(reportId, ctx.user.key);
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener("abort", onAbort);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      // Disable Nginx response buffering — without this, SSE messages can
      // sit in a proxy buffer for seconds before reaching the browser.
      "X-Accel-Buffering": "no",
    },
  });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await authorize(req, params.id);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  heartbeat(params.id, ctx.user);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await authorize(req, params.id);
  if (!ctx) return NextResponse.json({ ok: true });  // best-effort
  leave(params.id, ctx.user.key);
  return NextResponse.json({ ok: true });
}
