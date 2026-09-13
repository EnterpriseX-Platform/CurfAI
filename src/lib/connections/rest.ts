/**
 * REST connection helpers. Mirrors lib/connections/postgres.ts so this
 * connector kind shares the same encrypted-secret lifecycle as the SQL
 * warehouses instead of storing bearer tokens / API keys in plaintext.
 *
 * `DataSource.connection` for kind="rest" is JSON of shape:
 *   {
 *     baseUrl: string,
 *     headersEnc: string,   // AES-256-GCM via lib/secrets.ts, JSON-encoded headers object
 *   }
 *
 * Legacy rows written before this module existed stored `headers` in
 * plaintext instead of `headersEnc`. resolveRestHeaders() reads those
 * transparently; encodeRestConnection() re-encrypts them the next time the
 * row is saved, so there's no separate migration step.
 */
import { encryptSecret, decryptSecret } from "@/lib/secrets";

export type RestConnectionInput = {
  baseUrl: string;
  /** Plaintext, only on the way IN to be encrypted. Undefined on PATCH = keep existing. */
  headers?: Record<string, string>;
  /**
   * Non-secret cosmetic tag. Set when this connection was created via a
   * guided preset (HubSpot, Zendesk — see lib/connections/hubspot.ts,
   * zendesk.ts) instead of raw baseUrl+headers. Purely a UI hint for the
   * edit form and connections list; the persisted DataSource.kind is always
   * "rest" and every other code path (runner, probe, ACL, tier gating)
   * treats a presetKind connection exactly like any other REST source.
   */
  presetKind?: "hubspot" | "zendesk";
};

export type RestConnectionStored = {
  baseUrl: string;
  headersEnc?: string;
  /** Legacy plaintext shape — present only on rows written before encryption. */
  headers?: Record<string, string>;
  presetKind?: "hubspot" | "zendesk";
};

/**
 * Encode a plaintext input into the JSON shape stored in DataSource.connection.
 * Encrypts the headers object. If `existingJson` is supplied and the input has
 * no headers (undefined, not `{}`), the existing encrypted headers are reused —
 * lets PATCH avoid round-tripping secret values through the client.
 */
export function encodeRestConnection(input: RestConnectionInput, existingJson?: string | null): string {
  // presetKind preservation is independent of whether headers changed this
  // call — e.g. rotating a HubSpot token (new headers) must still keep
  // presetKind:"hubspot" so the edit form keeps showing the friendly field.
  let existingPresetKind: RestConnectionStored["presetKind"];
  if (existingJson) {
    try { existingPresetKind = decodeRestConnection(existingJson).presetKind; } catch { /* corrupt — ignore */ }
  }

  let headersEnc: string;
  if (input.headers !== undefined) {
    headersEnc = encryptSecret(JSON.stringify(input.headers));
  } else if (existingJson) {
    try {
      const prev = decodeRestConnection(existingJson);
      headersEnc = prev.headersEnc ?? encryptSecret(JSON.stringify(prev.headers ?? {}));
    } catch {
      headersEnc = encryptSecret("{}");
    }
  } else {
    headersEnc = encryptSecret("{}");
  }
  const stored: RestConnectionStored = {
    baseUrl: input.baseUrl.trim(),
    headersEnc,
    presetKind: input.presetKind ?? existingPresetKind,
  };
  return JSON.stringify(stored);
}

/** Decode the JSON connection field back to a typed object. Does NOT decrypt. */
export function decodeRestConnection(json: string): RestConnectionStored {
  const parsed = JSON.parse(json) as Partial<RestConnectionStored>;
  if (!parsed.baseUrl) {
    throw new Error("REST connection JSON is missing required fields.");
  }
  return {
    baseUrl: parsed.baseUrl,
    headersEnc: parsed.headersEnc,
    headers: parsed.headers && typeof parsed.headers === "object" ? parsed.headers : undefined,
    presetKind: parsed.presetKind === "hubspot" || parsed.presetKind === "zendesk" ? parsed.presetKind : undefined,
  };
}

/**
 * Decrypt + return the header map ready to send on an outbound request.
 * Falls back to the legacy plaintext `headers` field for rows written before
 * this module existed.
 */
export function resolveRestHeaders(stored: RestConnectionStored): Record<string, string> {
  if (stored.headersEnc) {
    const json = decryptSecret(stored.headersEnc);
    if (json == null) {
      throw new Error("Could not decrypt REST headers. Re-enter them under Connections → Edit.");
    }
    try {
      const parsed = JSON.parse(json);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return stored.headers ?? {};
}

/**
 * Hide header values before echoing the connection back to the client. Used
 * by GET /api/data-sources/[id] so admins editing the connection don't see
 * secrets like bearer tokens — only which header names are set. New header
 * input replaces all of them; leaving the field blank keeps the existing set.
 */
export function maskRestConnectionForClient(json: string): {
  baseUrl: string;
  headerKeys: string[];
  hasHeaders: boolean;
  presetKind?: "hubspot" | "zendesk";
} {
  const stored = decodeRestConnection(json);
  const headerKeys = Object.keys(resolveRestHeaders(stored));
  return { baseUrl: stored.baseUrl, headerKeys, hasHeaders: headerKeys.length > 0, presetKind: stored.presetKind };
}
