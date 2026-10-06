/**
 * The one door into a single lake table for the /api/lake/tables/[name]/*
 * routes (and v1's rows): find it in the caller's workspace and decide what
 * they may do with it.
 *
 *   "read"  — the table's ACL (lib/lake/acl.ts canRead: owner-only, or
 *             restricted to roles, admins included). A table the caller
 *             can't read answers 404, as if it weren't there.
 *   "build" — read, and a builder role (admin/developer). Changing a table
 *             you can't read is never allowed: the audit of 2026-09-30 found
 *             a developer adding columns to, and re-tagging, a table that
 *             answered them 404 — with its values in the response.
 *
 * A report-scoped API key is refused before anything else: it's allowlisted
 * to reports and has no mandate over tables (blockScopedApiKey).
 *
 * Whatever a route returns from here that carries column samples goes
 * through `redactSamples(schema, access.viewer)` — a sample is a value from
 * the table, masked like the rows.
 */
import { NextResponse } from "next/server";
import type { LakeTable } from "@prisma/client";
import { prisma } from "@/lib/db";
import { blockScopedApiKey, tenantWhere, type CurfSessionUser } from "@/lib/auth";
import { canRead, loadRoleSlugs, type LakeViewer } from "@/lib/lake/acl";
import type { RedactionViewer } from "@/lib/lake/redaction";
import { canBuild } from "@/lib/roles";

export type LakeTableAccess = {
  row: LakeTable;
  /** For canRead-style checks on other tables. */
  lakeViewer: LakeViewer;
  /** For masking rows and samples (redaction.ts). */
  viewer: RedactionViewer;
};

const notFound = () => NextResponse.json({ error: "Table not found" }, { status: 404 });

/** `name` is the table's name as stored (callers decode the route param). */
export async function lakeTableFor(
  user: CurfSessionUser,
  name: string,
  need: "read" | "build",
): Promise<LakeTableAccess | NextResponse> {
  const scoped = blockScopedApiKey(user);
  if (scoped) return scoped;

  const row = await prisma.lakeTable.findFirst({ where: { ...tenantWhere(user), name } });
  if (!row) return notFound();

  const roleSlugs = await loadRoleSlugs(user.id, user.tenantId);
  const lakeViewer: LakeViewer = { id: user.id, tenantId: user.tenantId, role: user.role, roleSlugs };
  if (!canRead(lakeViewer, row)) return notFound();
  if (need === "build" && !canBuild(user.role)) {
    return NextResponse.json({ error: "Editors only" }, { status: 403 });
  }
  return { row, lakeViewer, viewer: { id: user.id, role: user.role, roleSlugs } };
}
