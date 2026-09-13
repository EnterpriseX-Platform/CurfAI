/**
 * API key minting — the one place that generates a raw curf_... token and
 * writes the ApiKey row, shared by POST /api/admin/api-keys (an admin
 * mints one for a script/CI/dashboard) and the MCP OAuth token endpoint
 * (a consenting user mints one for themselves via /oauth/authorize —
 * see prisma/schema.prisma's OAuthClient/OAuthAuthorizationCode comment
 * for why that flow ends here instead of inventing a second credential
 * type). Two callers with different authorization rules around it;
 * exactly one implementation of what a key actually IS.
 */
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import type { MembershipRole } from "@/lib/auth";

export function mintApiKeyToken(): { token: string; prefix: string } {
  const raw = randomBytes(24).toString("base64url");
  const token = "curf_" + raw;
  const prefix = token.slice(0, 12);
  return { token, prefix };
}

export type CreateApiKeyResult = {
  id: string;
  name: string;
  prefix: string;
  role: string;
  expiresAt: Date | null;
  createdAt: Date;
  /** The raw secret — returned exactly once, at mint time. Never persisted anywhere but the bcrypt hash. */
  token: string;
};

export async function createApiKey(opts: {
  tenantId: string;
  name: string;
  role: MembershipRole;
  createdById: string;
  expiresAt?: Date | null;
  /** Pre-validated — callers are responsible for confirming every id belongs to this tenant before calling. */
  scopedReportIds?: string[];
}): Promise<CreateApiKeyResult> {
  const { token, prefix } = mintApiKeyToken();
  const hashedSecret = await bcrypt.hash(token, 10);
  const created = await prisma.apiKey.create({
    data: {
      tenantId: opts.tenantId,
      name: opts.name,
      prefix,
      hashedSecret,
      role: opts.role,
      expiresAt: opts.expiresAt ?? null,
      createdById: opts.createdById,
      scopedReportIds: opts.scopedReportIds?.length ? JSON.stringify(opts.scopedReportIds) : null,
    },
    select: { id: true, name: true, prefix: true, role: true, expiresAt: true, createdAt: true },
  });
  return { ...created, token };
}
