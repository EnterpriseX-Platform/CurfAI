/**
 * Short-lived proof that a request for `/reports/<id>?print=1` is one of our
 * own renderers (Puppeteer for PDF, the same URL for XLSX) rather than a
 * browser — see lib/reporting/renderers/pdf.ts and xlsx.ts.
 *
 * Why this exists: the viewer page used to treat the bare `print=1` flag as
 * the credential. That flag skipped the /login redirect AND dropped the
 * tenantId from the report lookup, so anyone who knew (or guessed) a report
 * id could read any tenant's report, unauthenticated, by appending
 * `?print=1`. The flag had to stay permissive because the cron and schedule
 * jobs render with no user cookie to forward — they are servers, not people.
 *
 * So the jobs now carry a signed capability naming the exact report they are
 * allowed to render, minted server-side moments before the navigation. The
 * page verifies it and takes the tenant FROM the token, which restores tenant
 * scoping for the print path too.
 *
 * The token also names who the page runs the report as: the export's caller,
 * or a scheduled delivery's creator. A session cookie can't carry that for an
 * API key or the cron, and without it the page ran the report as the system,
 * skipping the data-source ACL and lake redaction. So a PDF from a viewer-role
 * API key, or a scheduled email, held data its caller wasn't allowed to see.
 * The identity is resolved by the server that mints the token and is signed
 * with it, so a token can never render as more than the caller. A token that
 * names no one is refused. There is no system render.
 *
 * It also says whose blocks the page shows, because an export and a delivery
 * differ there. An on-demand export shows the blocks its caller may see
 * (`b`), so an admin API key's PDF carries the same role-gated blocks as its
 * XLSX/DOCX/CSV. A scheduled delivery's token leaves `b` out: its data
 * renders as the schedule's creator, its blocks as a viewer with no roles,
 * so an admin's scheduled email never gains role-gated blocks. Left out
 * means the narrower of the two, so a caller that forgets it shows less.
 *
 * TTL is minutes, not days (contrast lib/embed/token.ts): the token is minted
 * and consumed inside one render. The window only has to cover a cold
 * Chromium start plus the page's own queries. It also bounds how long a role
 * the caller has since lost stays baked into a token.
 *
 * The token rides in the page URL, and Node caps the request line plus
 * headers at 16 KB. So the payload keeps one-letter keys and carries role
 * slugs only. A member holds a handful of short custom roles. A URL that
 * somehow overflowed would fail the render loudly, not render less.
 */
import { signCapabilityToken, verifyCapabilityToken } from "@/lib/security/capabilityToken";
import type { RunViewer } from "@/lib/reporting/runner";

export type RenderTokenPayload = {
  // Marks this as a render token. Every capability token shares one signing
  // key, and an embed token carries t and r too. Before tokens named a
  // viewer, a one-block embed link (a year's TTL, mintable by any reader)
  // worked as ?rt= and rendered the whole report as the system. Requiring v
  // closed that only because embed tokens happen to carry no viewer.
  k: "render";
  t: string;   // tenantId — the page trusts this for scoping, so it is signed
  r: string;   // reportId this token is good for, and only this one
  v: { u: string; a: boolean; g: string[] }; // viewer: id, isAdmin, role slugs
  b?: true;    // filter blocks as `v` too; absent = as a viewer with no roles
  exp: number; // unix ms
};

/** What a valid token lets the page do: read `reportId` in this tenant, as
 *  this viewer, showing the blocks the viewer may see if `blocksAsViewer`. */
export type RenderGrant = { tenantId: string; viewer: RunViewer; blocksAsViewer: boolean };

/** Long enough for a cold Chromium plus the report's own queries. */
const DEFAULT_TTL_MS = 5 * 60_000;

export function mintRenderToken(opts: {
  tenantId: string;
  reportId: string;
  viewer: RunViewer;
  /** An on-demand export: the page shows the blocks `viewer` may see. */
  blocksAsViewer?: boolean;
  ttlMs?: number;
}): string {
  return signCapabilityToken<RenderTokenPayload>({
    k: "render",
    t: opts.tenantId,
    r: opts.reportId,
    v: { u: opts.viewer.id, a: opts.viewer.isAdmin, g: opts.viewer.roles },
    ...(opts.blocksAsViewer ? { b: true as const } : {}),
    exp: Date.now() + (opts.ttlMs ?? DEFAULT_TTL_MS),
  });
}

/**
 * Verify + parse, and bind the token to the report being requested.
 *
 * `expectedReportId` is not optional on purpose. A token is a capability for
 * ONE report; without this check a valid token for a report you may read
 * would render any other report in the same tenant — the exact mistake
 * lib/embed/token.ts warns about in its own verify comment.
 */
export function verifyRenderToken(
  token: string | undefined | null,
  expectedReportId: string,
): RenderGrant | null {
  if (!token) return null;
  const payload = verifyCapabilityToken<RenderTokenPayload>(token);
  if (!payload) return null;
  if (payload.k !== "render" || !payload.t || !payload.r) return null;
  if (payload.r !== expectedReportId) return null;
  // No viewer means no one to apply the ACL for. Refused rather than run
  // as the system.
  const v = payload.v;
  if (!v || typeof v.u !== "string" || !v.u || typeof v.a !== "boolean") return null;
  if (!Array.isArray(v.g) || !v.g.every((r) => typeof r === "string")) return null;
  return { tenantId: payload.t, viewer: { id: v.u, isAdmin: v.a, roles: v.g }, blocksAsViewer: payload.b === true };
}
