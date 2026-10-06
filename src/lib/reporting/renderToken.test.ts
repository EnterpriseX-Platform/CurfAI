/**
 * Render tokens are the ONLY thing authenticating a `?print=1` navigation
 * now, on a page that reads a tenant's report and runs its queries. Before
 * them, the bare `print=1` flag skipped the login redirect and dropped
 * tenantId from the lookup, so appending it to any report id returned that
 * report to an unauthenticated caller, across tenants.
 *
 * So the properties under test are the ones the page relies on: the tenant
 * comes from a SIGNED field, a token is good for exactly one report, and it
 * stops working quickly.
 *
 * The token also names the viewer the page runs the report as, since an API
 * key or the cron has no session. Before it did, those renders ran as the
 * system and skipped the data-source ACL. So a token must carry its viewer
 * signed, and a token without one must not render at all.
 *
 * It also says whether the page shows the blocks that viewer may see (an
 * on-demand export) or filters them as nobody (a scheduled delivery). That
 * flag is signed too, and a token without it gets the narrower one.
 */
import { describe, it, expect } from "vitest";
import { mintRenderToken, verifyRenderToken, type RenderTokenPayload } from "./renderToken";
import { signCapabilityToken } from "@/lib/security/capabilityToken";
import { mintEmbedToken } from "@/lib/embed/token";

const REPORT = "rep-1";
const VIEWER = { id: "u-dev", isAdmin: false, roles: ["finance"] };

describe("mintRenderToken / verifyRenderToken round-trip", () => {
  it("verifies against the report it was minted for and carries the tenant and viewer", () => {
    const token = mintRenderToken({ tenantId: "tenant-a", reportId: REPORT, viewer: VIEWER });
    expect(verifyRenderToken(token, REPORT)).toEqual({ tenantId: "tenant-a", viewer: VIEWER, blocksAsViewer: false });
  });

  it("carries whether the page shows the viewer's blocks, off unless asked for", () => {
    // Off is a scheduled delivery: blocks filter as nobody whoever created it.
    const exportToken = mintRenderToken({ tenantId: "tenant-a", reportId: REPORT, viewer: VIEWER, blocksAsViewer: true });
    expect(verifyRenderToken(exportToken, REPORT)?.blocksAsViewer).toBe(true);
    const deliveryToken = mintRenderToken({ tenantId: "tenant-a", reportId: REPORT, viewer: VIEWER, blocksAsViewer: false });
    expect(decode(deliveryToken)).not.toHaveProperty("b");
    expect(verifyRenderToken(deliveryToken, REPORT)?.blocksAsViewer).toBe(false);
  });

  it("defaults to a minutes-long TTL, not the days embed tokens use", () => {
    const token = mintRenderToken({ tenantId: "tenant-a", reportId: REPORT, viewer: VIEWER });
    const exp = decode(token).exp;
    expect(exp - Date.now()).toBeGreaterThan(60_000);
    expect(exp - Date.now()).toBeLessThanOrEqual(10 * 60_000);
  });

  it("stays a short URL parameter for a member with several custom roles", () => {
    const roles = ["executive", "analyst", "new_hire", "finance_lead", "regional_manager_apac"];
    const token = mintRenderToken({ tenantId: "cmq99qd5p0000u4fu8zueguqa", reportId: "cmuexw5gi0003n3qa4albbqvj", viewer: { id: "cmq99qd800002u4fud8e4nwhr", isAdmin: false, roles } });
    expect(token.length).toBeLessThan(600);
  });
});

describe("verifyRenderToken — the checks the viewer page depends on", () => {
  it("refuses a token minted for a DIFFERENT report", () => {
    // Otherwise one legitimate export leaks every other report in the
    // tenant: same signature, different id in the URL.
    const token = mintRenderToken({ tenantId: "tenant-a", reportId: "rep-other", viewer: VIEWER });
    expect(verifyRenderToken(token, REPORT)).toBeNull();
  });

  it("refuses an expired token", () => {
    const token = mintRenderToken({ tenantId: "tenant-a", reportId: REPORT, viewer: VIEWER, ttlMs: -1 });
    expect(verifyRenderToken(token, REPORT)).toBeNull();
  });

  it("refuses a token whose payload was edited to another tenant", () => {
    const token = mintRenderToken({ tenantId: "tenant-a", reportId: REPORT, viewer: VIEWER });
    expect(verifyRenderToken(edit(token, (p) => { p.t = "tenant-victim"; }), REPORT)).toBeNull();
  });

  it("refuses a token whose viewer was edited to an admin, or given more roles", () => {
    // The viewer is what the ACL runs for. Editable, a viewer-role key's
    // token would render as an admin.
    const token = mintRenderToken({ tenantId: "tenant-a", reportId: REPORT, viewer: VIEWER });
    expect(verifyRenderToken(edit(token, (p) => { p.v.a = true; }), REPORT)).toBeNull();
    expect(verifyRenderToken(edit(token, (p) => { p.v.g.push("executive"); }), REPORT)).toBeNull();
    expect(verifyRenderToken(edit(token, (p) => { p.v.u = "u-owner"; }), REPORT)).toBeNull();
  });

  it("refuses a delivery's token edited to show the viewer's blocks", () => {
    // Editable, an admin's scheduled email would pick up role-gated blocks.
    const token = mintRenderToken({ tenantId: "tenant-a", reportId: REPORT, viewer: { ...VIEWER, isAdmin: true } });
    expect(verifyRenderToken(edit(token, (p) => { p.b = true; }), REPORT)).toBeNull();
  });

  it("reads anything but a signed true as filtering blocks as nobody", () => {
    for (const b of [1, "true", false, null]) {
      const token = signCapabilityToken({ k: "render", t: "tenant-a", r: REPORT, v: { u: "u-dev", a: true, g: [] }, b, exp: Date.now() + 60_000 } as any);
      expect(verifyRenderToken(token, REPORT)?.blocksAsViewer).toBe(false);
    }
  });

  it("refuses a token with a flipped signature byte", () => {
    const token = mintRenderToken({ tenantId: "tenant-a", reportId: REPORT, viewer: VIEWER });
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(verifyRenderToken(flipped, REPORT)).toBeNull();
  });

  it("refuses a well-signed token that omits the tenant", () => {
    // Signed by us, so the HMAC passes — but an empty tenant would scope the
    // report lookup to nothing, or worse, be treated as absent downstream.
    const token = signCapabilityToken<RenderTokenPayload>({
      k: "render", t: "", r: REPORT, v: { u: "u-dev", a: false, g: [] }, exp: Date.now() + 60_000,
    });
    expect(verifyRenderToken(token, REPORT)).toBeNull();
  });

  it("refuses a well-signed token that names no viewer, so nothing renders as the system", () => {
    // The shape every token had before viewers were added. Accepted, it
    // would run the report with no ACL at all.
    const legacy = signCapabilityToken({ k: "render", t: "tenant-a", r: REPORT, exp: Date.now() + 60_000 });
    expect(verifyRenderToken(legacy, REPORT)).toBeNull();
    for (const v of [null, {}, { u: "", a: false, g: [] }, { u: "u", a: "false", g: [] }, { u: "u", a: false }, { u: "u", a: false, g: [1] }]) {
      const token = signCapabilityToken({ k: "render", t: "tenant-a", r: REPORT, v, exp: Date.now() + 60_000 } as any);
      expect(verifyRenderToken(token, REPORT)).toBeNull();
    }
  });

  it("refuses an embed token for a block of the same report, even one that named a viewer", () => {
    // Same signing key, and it carries t and r too. Before render tokens
    // named a viewer, a one-block embed link (any reader can mint one, and it
    // lives a year) rendered the whole report as the system via ?print=1&rt=.
    // An embed token that named its minter would pass the viewer check.
    const embed = mintEmbedToken({ tenantId: "tenant-a", reportId: REPORT, blockId: "b_title" });
    expect(verifyRenderToken(embed, REPORT)).toBeNull();
    const withViewer = signCapabilityToken({ t: "tenant-a", r: REPORT, b: "b_title", v: { u: "u-admin", a: true, g: [] }, exp: Date.now() + 60_000 });
    expect(verifyRenderToken(withViewer, REPORT)).toBeNull();
  });

  it("refuses missing, empty and malformed tokens", () => {
    for (const bad of [undefined, null, "", "not-a-token", "a.b", "....."]) {
      expect(verifyRenderToken(bad as any, REPORT)).toBeNull();
    }
  });
});

function decode(token: string): RenderTokenPayload {
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
}

/** Re-encode an edited payload under the original signature. */
function edit(token: string, change: (p: RenderTokenPayload) => void): string {
  const p = decode(token);
  change(p);
  return `${Buffer.from(JSON.stringify(p)).toString("base64url")}.${token.split(".")[1]}`;
}
