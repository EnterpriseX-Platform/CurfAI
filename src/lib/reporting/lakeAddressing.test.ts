/**
 * A lake DataSource must be addressed by the row's own tenantId, never by the
 * `connection` label.
 *
 * The starter pack clones the demo tenant's DataSource rows into every new
 * workspace, copying `connection: "lake://<demo-tenant-id>"` verbatim. The
 * runner resolved the lake file from that string, so a brand-new workspace
 * opened the DEMO tenant's lake: its own uploaded tables were invisible
 * ("no such table"), and any same-named table would have served another
 * tenant's rows. 39 rows in the local database were mis-addressed this way.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const runnerSrc = readFileSync(join(process.cwd(), "src/lib/reporting/runner.ts"), "utf8");
const provisionSrc = readFileSync(join(process.cwd(), "src/lib/tenant/provision.ts"), "utf8");

describe("lake file addressing", () => {
  it("the runner never derives the lake path from the connection string", () => {
    // Both lake branches previously did:
    //   tenantLakePath(dsRow.connection.replace(/^lake:\/\//, ""))
    expect(runnerSrc).not.toMatch(/tenantLakePath\(\s*dsRow\.connection/);
    expect(runnerSrc).not.toMatch(/connection\.replace\(\s*\/\^lake/);
  });

  it("both lake branches resolve the path from dsRow.tenantId", () => {
    const matches = runnerSrc.match(/tenantLakePath\(dsRow\.tenantId\)/g) ?? [];
    // One in runReportWithProof's dispatch, one in the single-query path.
    expect(matches.length).toBe(2);
  });

  it("cloning a workspace re-addresses the lake connection to the new tenant", () => {
    expect(provisionSrc).toMatch(/kind === "lake"/);
    expect(provisionSrc).toMatch(/lake:\/\/\$\{newTenantId\}/);
  });
});
