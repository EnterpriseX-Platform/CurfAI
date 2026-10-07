/**
 * Connection helpers for kind="engine": a data source served by the Java engine (engines/java).
 *
 * `DataSource.connection` is JSON of shape { baseUrl?: string, audience?: string }.
 * There is nothing secret in it: Curf proves who is asking with a token it signs per query
 * (lib/engine/identity.ts), so no password or API key is stored or round-tripped.
 *
 * Where the engine lives, in order:
 *   1. this data source's own baseUrl (a workspace with its own engine, for example one inside its network);
 *   2. CURF_ENGINE_URL, the platform's engine, which every workspace may use.
 *
 * The URL is the one place a person could point Curf's server at an address of their choosing, so it is
 * held to the same rule as every other outbound URL (lib/security/ssrfGuard.ts): public hosts only. Two
 * exceptions, both set by whoever operates this Curf and never by a workspace:
 *   - CURF_ENGINE_URL itself is operator configuration, so it is trusted as written;
 *   - CURF_ENGINE_ALLOWED_HOSTS (comma-separated host names) lets a workspace's own URL name an internal
 *     host, for an engine that runs next to Curf on a private network.
 */
import { assertPublicHttpUrl } from "@/lib/security/ssrfGuard";

export type EngineConnectionInput = {
  /** The workspace's own engine. Blank/undefined = use the platform's. */
  baseUrl?: string;
  /** `aud` to put in the token, when the engine is configured to require one. */
  audience?: string;
};

export type EngineConnectionStored = { baseUrl?: string; audience?: string };

export type EngineTarget = {
  baseUrl: string;
  audience?: string;
  /** "platform" targets come from operator config and skip the public-host rule. */
  source: "workspace" | "platform";
};

export function platformEngineUrl(): string {
  return (process.env.CURF_ENGINE_URL ?? "").trim().replace(/\/$/, "");
}

/**
 * Hosts the operator lets a workspace's engine URL name even when they are private: `host` (any port) or
 * `host:port` (that port only — list the port, so a listed host's other services are not reachable).
 */
function allowedEngineHosts(): string[] {
  return (process.env.CURF_ENGINE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowListed(url: URL): boolean {
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const host = url.hostname.toLowerCase();
  return allowedEngineHosts().some((entry) => (entry.includes(":") && !entry.startsWith("[") ? entry === `${host}:${port}` : entry === host));
}

/**
 * The part of the URL rule that needs no network. A workspace's URL is the address of an engine, nothing more:
 * scheme, host and port, with no path, query, fragment or credentials — so whatever the host is, Curf only ever
 * asks it for /engine/v1/…, and not for a path someone chose. `trusted` means the operator listed the host
 * (CURF_ENGINE_ALLOWED_HOSTS), so it may be a private address; anything else must be public and over https, which
 * the connection itself enforces on the address it uses (lib/security/pinnedFetch.ts).
 */
export function engineUrlPolicy(rawUrl: string): { ok: true; trusted: boolean } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "That is not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "The engine URL must start with http:// or https://." };
  if (url.username || url.password) return { ok: false, reason: "Put credentials in the engine, not in its URL." };
  // `?` and `#` are tested on the raw text too: an empty query or fragment is dropped by the parser, but it would
  // still turn "/engine/v1/…" appended to the string into a query on another path.
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || /[?#]/.test(rawUrl)) {
    return { ok: false, reason: "Give only the engine's address, such as https://engine.example.com — without a path or query." };
  }
  const trusted = isAllowListed(url);
  if (url.protocol === "http:" && !trusted) {
    return { ok: false, reason: "Use https:// for an engine outside your own network, so the identity token is not sent in the clear." };
  }
  return { ok: true, trusted };
}

/**
 * Why a workspace-supplied engine URL may not be saved, or "" when it may — checked while the person saving it
 * can still fix it. The runtime check is the pinned connection's own, which looks at the address it uses.
 */
export async function engineBaseUrlError(rawUrl: string): Promise<string> {
  const policy = engineUrlPolicy(rawUrl);
  if (!policy.ok) return policy.reason;
  if (policy.trusted) return "";
  try {
    await assertPublicHttpUrl(rawUrl);
    return "";
  } catch (e: any) {
    return e?.message ?? "This engine URL is not allowed.";
  }
}

export function encodeEngineConnection(input: EngineConnectionInput): string {
  const stored: EngineConnectionStored = {};
  const raw = input.baseUrl?.trim();
  if (raw) {
    // Keep the normalised origin, not the text as typed: lower-case host, no default port, no trailing slash.
    // (Unparseable text is stored as typed; the policy refuses it before it is ever used.)
    try { stored.baseUrl = new URL(raw).origin; } catch { stored.baseUrl = raw.replace(/\/$/, ""); }
  }
  const audience = input.audience?.trim();
  if (audience) stored.audience = audience;
  return JSON.stringify(stored);
}

export function decodeEngineConnection(json: string): EngineConnectionStored {
  const parsed = JSON.parse(json) as Partial<EngineConnectionStored>;
  return {
    baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl ? parsed.baseUrl : undefined,
    audience: typeof parsed.audience === "string" && parsed.audience ? parsed.audience : undefined,
  };
}

/** Where to send this data source's queries, or why there is nowhere to send them. */
export function resolveEngineTarget(stored: EngineConnectionStored): EngineTarget {
  if (stored.baseUrl) return { baseUrl: stored.baseUrl, audience: stored.audience, source: "workspace" };
  const platform = platformEngineUrl();
  if (platform) return { baseUrl: platform, audience: stored.audience, source: "platform" };
  throw new Error("No engine URL: this connection has none of its own and CURF_ENGINE_URL is not set.");
}

/** What the client may see when editing: nothing here is secret, but "uses the platform's" is worth saying. */
export function maskEngineConnectionForClient(json: string): {
  baseUrl: string;
  audience: string;
  usesPlatformEngine: boolean;
} {
  const stored = decodeEngineConnection(json);
  return {
    baseUrl: stored.baseUrl ?? "",
    audience: stored.audience ?? "",
    usesPlatformEngine: !stored.baseUrl,
  };
}
