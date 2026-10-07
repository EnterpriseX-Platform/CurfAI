/**
 * "Test connection" for an engine data source: not just "is something there", but each thing an admin has to
 * get right, said in the order they go wrong, with what to change.
 *
 *   1. reachable            — the engine answers at all;
 *   2. accepts Curf's token — it trusts Curf's issuer and key set (else 401);
 *   3. right workspace      — it put this person in THIS workspace, not "default" (the engine must be told which
 *                             claim carries the workspace; without it every workspace shares one);
 *   4. views                — how many published views this person can build on.
 *
 * Nothing here is secret: it is the caller's own identity as the engine sees it, and the public values the
 * engine needs configured. The token itself is never returned.
 */
import { engineCall, engineJson, engineStatusError, type EngineCallOptions } from "@/lib/engine/client";
import { loadCatalogue } from "@/lib/engine/catalogue";
import { engineIssuer } from "@/lib/engine/identity";

export type EngineStatus = {
  ok: boolean;
  latencyMs: number;
  /** Where Curf sent it: "platform" is CURF_ENGINE_URL, "workspace" is this connection's own URL. */
  source: "platform" | "workspace";
  reachable: boolean;
  acceptsIdentity: boolean;
  workspaceMatches: boolean | null;
  identity?: { username: string; tenantId: string; roles: string[]; permissions: string[]; attributes: Record<string, string[]> };
  views?: number;
  problem?: string;
  hint?: string;
};

type Ctx = Pick<EngineCallOptions, "target" | "viewer" | "tenantId" | "fetchImpl">;

function jwksUrl(): string {
  return `${(process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "")}/api/engine/jwks`;
}

export async function checkEngine(ctx: Ctx): Promise<EngineStatus> {
  const started = Date.now();
  const base = { source: ctx.target.source, reachable: false, acceptsIdentity: false, workspaceMatches: null as boolean | null };
  const done = (extra: Partial<EngineStatus>): EngineStatus => ({ ok: false, latencyMs: Date.now() - started, ...base, ...extra });

  let res: Response;
  try {
    res = await engineCall({ ...ctx, path: "/me", timeoutMs: 10_000 });
  } catch (e: any) {
    return done({
      problem: e?.message ?? "The engine could not be reached.",
      hint: ctx.target.source === "workspace"
        ? "Check the engine URL on this connection, that the engine is running, and that it is reachable from Curf's server."
        : "Check CURF_ENGINE_URL, that the engine is running, and that it is reachable from Curf's server.",
    });
  }

  if (res.status === 401) {
    return done({
      reachable: true,
      problem: "The engine does not accept Curf's identity token.",
      hint: `Tell the engine to trust issuer ${engineIssuer() || "(set CURF_ENGINE_ISSUER)"} with the key set at ${jwksUrl()} (CURF_ENGINE_SECURITY_ISSUERS_0_ISSUER and ..._JWKSETURI), and make sure the engine can reach that address.`,
    });
  }
  const failure = await engineStatusError(res);
  if (failure) return done({ reachable: true, problem: failure });

  const me = (await engineJson(res).catch(() => null)) as any;
  const identity = me && typeof me.tenantId === "string"
    ? {
        username: String(me.username ?? me.subject ?? ""),
        tenantId: me.tenantId as string,
        roles: Array.isArray(me.roles) ? me.roles.map(String) : [],
        permissions: Array.isArray(me.permissions) ? me.permissions.map(String) : [],
        attributes: me.attributes && typeof me.attributes === "object" ? me.attributes : {},
      }
    : undefined;
  if (!identity) return done({ reachable: true, acceptsIdentity: true, problem: "The engine answered, but not like a Curf engine does." });

  // The failure that is easy to miss: the token is accepted, but the engine files this person under
  // "default" because it was never told which claim names the workspace. Everything would seem to work.
  if (identity.tenantId !== ctx.tenantId) {
    return done({
      reachable: true, acceptsIdentity: true, workspaceMatches: false, identity,
      problem: "The engine put you in a different workspace than this one.",
      hint: "Set CURF_ENGINE_SECURITY_CLAIMS_TENANT=tenant on the engine so it reads the workspace from Curf's token. Without it, workspaces would share one set of views.",
    });
  }

  let views: number | undefined;
  let viewsProblem: string | undefined;
  try {
    views = (await loadCatalogue(ctx)).length;
  } catch (e: any) {
    viewsProblem = e?.message ?? "The views could not be listed.";
  }
  return done({
    ok: viewsProblem === undefined, reachable: true, acceptsIdentity: true, workspaceMatches: true, identity,
    ...(views !== undefined ? { views } : {}),
    ...(viewsProblem ? { problem: viewsProblem } : {}),
    ...(views === 0 ? { hint: "No published views are available to you yet. Create and publish a view first, and allow one of your roles to use it." } : {}),
  });
}
