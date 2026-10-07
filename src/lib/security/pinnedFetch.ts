/**
 * An HTTP request that can only reach a public address, checked on the address the connection really uses.
 *
 * lib/security/ssrfGuard.ts resolves a name, checks the answers, and lets the caller's own fetch resolve the
 * name again — so an attacker who controls the DNS record can answer "public" to the check and "127.0.0.1" to
 * the connection (DNS rebinding). Here the check IS the lookup the socket uses: Node asks `publicOnlyLookup`
 * for the address, it refuses anything private, and the connection goes to exactly what it returned. There is
 * no second resolution to flip. A literal IP in the URL never reaches a lookup, so it is checked up front.
 *
 * Built on node:http/https, so no dependency. It never follows a redirect (the caller sees the 3xx) and caps
 * how much of the answer it will hold.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { isBlockedAddress } from "@/lib/security/ssrfGuard";

export const PINNED_FETCH_MAX_BYTES = 64 * 1024 * 1024;

function refusal(message: string): Error {
  return Object.assign(new Error(message), { code: "ESSRF" });
}

/** The `lookup` a socket uses: resolve, refuse if any answer is not public, hand back what was checked. */
export function publicOnlyLookup(hostname: string, options: any, callback: (...args: any[]) => void): void {
  const wantsAll = typeof options === "object" && options !== null && options.all === true;
  const base = typeof options === "object" && options !== null ? options : {};
  dns.lookup(hostname, { ...base, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses as unknown as dns.LookupAddress[];
    if (!list || list.length === 0) return callback(refusal(`Refusing to connect to "${hostname}" — the host could not be resolved`));
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (bad) return callback(refusal(`Refusing to connect to "${hostname}" — resolves to private/reserved address ${bad.address}`));
    if (wantsAll) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

export type PinnedFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  maxBytes?: number;
};

export function pinnedPublicFetch(rawUrl: string, init: PinnedFetchInit = {}): Promise<Response> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return Promise.reject(refusal("Invalid URL"));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Promise.reject(refusal(`URL scheme "${url.protocol}" is not allowed — only http/https`));
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host.toLowerCase() === "localhost") return Promise.reject(refusal("Refusing to connect to localhost"));
  if (net.isIP(host) && isBlockedAddress(host)) {
    return Promise.reject(refusal(`Refusing to connect to private/reserved address ${host}`));
  }

  const maxBytes = init.maxBytes ?? PINNED_FETCH_MAX_BYTES;
  const timedOut = () => Object.assign(new Error("The request timed out."), { name: "TimeoutError" });
  return new Promise<Response>((resolve, reject) => {
    // Settle exactly once: whichever of success, overflow, abort, error or an early close comes first wins, and the
    // rest are ignored (a destroyed request still emits events after the promise is decided).
    let done = false;
    const succeed = (r: Response) => { if (!done) { done = true; resolve(r); } };
    const fail = (e: Error) => { if (!done) { done = true; reject(e); } };
    // Before any request exists: nothing to clean up, and nothing left running.
    if (init.signal?.aborted) return fail(timedOut());

    const transport = url.protocol === "https:" ? https : http;
    const headers = { ...(init.headers ?? {}) };
    if (init.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(init.body));
    const req = transport.request(url, { method: init.method ?? "GET", headers, lookup: publicOnlyLookup as any }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        if (done) return;
        size += chunk.length;
        if (size > maxBytes) {
          fail(new Error("The answer is larger than Curf will accept."));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", fail);
      res.on("close", () => { if (!res.complete) fail(new Error("The connection closed before the answer finished.")); });
      res.on("end", () => {
        const status = res.statusCode ?? 502;
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) value.forEach((v) => responseHeaders.append(name, v));
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        const bodyless = status < 200 || status === 204 || status === 205 || status === 304;
        succeed(new Response(bodyless ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
      });
    });
    const onAbort = () => { fail(timedOut()); req.destroy(); };
    if (init.signal) {
      init.signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => init.signal!.removeEventListener("abort", onAbort));
    }
    req.on("error", fail);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
