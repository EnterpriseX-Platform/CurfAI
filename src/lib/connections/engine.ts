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

function allowedEngineHosts(): Set<string> {
  return new Set(
    (process.env.CURF_ENGINE_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Why a workspace-supplied engine URL may not be used, or "" when it may. Used at save time (so the person
 * can fix it) and again before every call (so a URL stored before a rule tightened stops working).
 */
export async function engineBaseUrlError(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "That is not a valid URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "The engine URL must start with http:// or https://.";
  if (url.username || url.password) return "Put credentials in the engine, not in its URL.";
  if (allowedEngineHosts().has(url.hostname.toLowerCase())) return "";
  try {
    await assertPublicHttpUrl(rawUrl);
    return "";
  } catch (e: any) {
    return e?.message ?? "This engine URL is not allowed.";
  }
}

export function encodeEngineConnection(input: EngineConnectionInput): string {
  const stored: EngineConnectionStored = {};
  const baseUrl = input.baseUrl?.trim().replace(/\/$/, "");
  if (baseUrl) stored.baseUrl = baseUrl;
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
