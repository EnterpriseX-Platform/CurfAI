/**
 * GET /api/realtime/events
 *
 * Server-Sent-Events stream of tenant-scoped events:
 *   - lake.bust       — cache invalidated for a data source
 *   - watcher.fired   — a watcher detected an anomaly
 *   - activation.done — an activation completed
 *   - ping            — heartbeat every 25s
 *
 * The client EventSource attaches a "message" listener and dispatches
 * by parsing the JSON body's `kind` field. We use a single named event
 * type ("message") rather than the per-kind event types because some
 * polyfills don't surface non-default event types reliably.
 *
 * Auth: requireUser pulls the session and the connection is pinned to
 * that user's tenant for its entire lifetime. There's no way to switch
 * tenants mid-stream.
 */
import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { subscribe } from "@/lib/realtime/bus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Long-lived connection — give it room. (Vercel free tier caps at 60s
// for the streaming endpoint; the heartbeat keeps it alive in dev and
// the client reconnects automatically.)
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const encoder = new TextEncoder();
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let handle: { close: () => void } | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // SSE preamble: a comment line tells the client we're alive even
      // before the first real event arrives.
      controller.enqueue(encoder.encode(`: connected as ${user.tenantId}\n\n`));

      const send = (event: any): boolean => {
        try {
          const payload = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(payload));
          return true;
        } catch {
          return false;
        }
      };

      handle = subscribe(user.tenantId, send);

      // Heartbeat every 25s to keep proxies happy.
      pingTimer = setInterval(() => {
        send({ kind: "ping", ts: Date.now() });
      }, 25_000);

      // Tear down on disconnect. AbortController on the request signal
      // is the only reliable hook in Next.js' edge response runtime.
      const onAbort = () => {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        if (handle) { handle.close(); handle = null; }
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener("abort", onAbort);
    },
    cancel() {
      if (pingTimer) clearInterval(pingTimer);
      if (handle) handle.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      // Disable Nginx buffering for SSE.
      "x-accel-buffering": "no",
    },
  });
}
