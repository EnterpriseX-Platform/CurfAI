/**
 * Shared SSRF guard for every server-side fetch() whose target URL is at
 * least partly controlled by a tenant: REST data sources (lib/reporting/runner.ts,
 * lib/connections/probe.ts) and outbound webhooks (lib/http/postJson.ts, which
 * both admin/webhooks and lib/delivery/dispatch.ts funnel through).
 *
 * Without this, a tenant admin can point a REST data source's baseUrl (or an
 * admin webhook URL) at http://169.254.169.254/... (cloud instance metadata)
 * or an internal service address, and — for REST data sources specifically —
 * the full JSON response is read back as report data, not just blind.
 */
import { promises as dns } from "node:dns";

const IPV4_BLOCKED_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8],       // "this" network
  ["10.0.0.0", 8],      // RFC1918
  ["100.64.0.0", 10],   // CGNAT
  ["127.0.0.0", 8],     // loopback
  ["169.254.0.0", 16],  // link-local — includes cloud metadata (169.254.169.254)
  ["172.16.0.0", 12],   // RFC1918
  ["192.0.0.0", 24],    // IETF protocol assignments
  ["192.0.2.0", 24],    // TEST-NET-1
  ["192.168.0.0", 16],  // RFC1918
  ["198.18.0.0", 15],   // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24],  // TEST-NET-3
  ["224.0.0.0", 4],     // multicast
  ["240.0.0.0", 4],     // reserved
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function isIpv4InCidr(ip: string, base: string, bits: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt == null || baseInt == null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function isBlockedIpv4(ip: string): boolean {
  if (ip === "255.255.255.255") return true;
  return IPV4_BLOCKED_RANGES.some(([base, bits]) => isIpv4InCidr(ip, base, bits));
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique local

  // IPv4-mapped, dotted-quad form as written: ::ffff:169.254.169.254
  const mappedDotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted) return isBlockedIpv4(mappedDotted[1]);

  // IPv4-mapped, hex form — the WHATWG URL parser normalizes the dotted form
  // above into this (e.g. ::ffff:169.254.169.254 -> ::ffff:a9fe:a9fe), so
  // both encodings need to be checked or this exact normalization silently
  // bypasses the dotted-form check.
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isBlockedIpv4(dotted);
  }
  return false;
}

/**
 * Throws if `hostname` is (or resolves to) a private/reserved address.
 * Protocol-agnostic — the actual guard logic behind assertPublicHttpUrl()
 * below, extracted so a non-HTTP outbound connection (SFTP's host, e.g.)
 * gets the exact same protection without a URL to parse. Checks both a
 * literal IP and every address the hostname resolves to. Does not pin the
 * checked address for the caller's actual connection, so a DNS-rebinding
 * attacker who can flip a record's answer between this check and the real
 * connection could still slip through — a residual risk, not a full
 * mitigation, but it closes the straightforward "point the host at the
 * metadata IP" attack this guard exists for.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (bare === "localhost") {
    throw new Error("Refusing to connect to localhost");
  }
  if (ipv4ToInt(bare) != null) {
    if (isBlockedIpv4(bare)) {
      throw new Error(`Refusing to connect to private/reserved address ${bare}`);
    }
  } else if (bare.includes(":")) {
    if (isBlockedIpv6(bare)) {
      throw new Error(`Refusing to connect to private/reserved address ${bare}`);
    }
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await dns.lookup(bare, { all: true });
  } catch {
    // Unresolvable host — let the real connection fail with its own network error.
    return;
  }
  for (const { address, family } of addresses) {
    const blocked = family === 4 ? isBlockedIpv4(address) : isBlockedIpv6(address);
    if (blocked) {
      throw new Error(`Refusing to connect to "${bare}" — resolves to private/reserved address ${address}`);
    }
  }
}

/**
 * Throws if `rawUrl` isn't a plain http(s) URL pointing at a public address.
 * Thin wrapper over assertPublicHost() — see that function for the actual
 * address-checking logic.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`URL scheme "${url.protocol}" is not allowed — only http/https`);
  }
  await assertPublicHost(url.hostname);
}

const MAX_REDIRECTS = 5;

/**
 * fetch() that re-validates every redirect hop against assertPublicHttpUrl()
 * before following it (OWASP A01/A10:2025 residual noted in this file's own
 * "Tested" pass — SSRF via redirect). assertPublicHttpUrl() alone only
 * checks the URL the caller passed in; a server that legitimately passes
 * that check can still respond with a 3xx Location pointing at
 * 169.254.169.254 or an internal address, and fetch()'s default
 * redirect:"follow" would go there with no further check at all — a much
 * simpler, more reliable bypass than DNS rebinding (no network timing
 * needed). Verified empirically: Node's fetch with redirect:"manual"
 * returns a normal Response (status + Location header readable), unlike
 * browser fetch's opaque redirect — this only works server-side.
 *
 * Every caller that fetches a tenant-influenced URL (REST data sources,
 * outbound webhooks, connection probes) should use this instead of a bare
 * fetch() + a single up-front assertPublicHttpUrl() call.
 */
export async function guardedFetch(url: string, init?: RequestInit): Promise<Response> {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHttpUrl(currentUrl);
    const res = await fetch(currentUrl, { ...init, redirect: "manual" });
    const isRedirect = res.status >= 300 && res.status < 400;
    const location = isRedirect ? res.headers.get("location") : null;
    if (!location) return res;
    currentUrl = new URL(location, currentUrl).toString();
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS}) resolving ${url}`);
}
