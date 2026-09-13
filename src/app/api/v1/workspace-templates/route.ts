/**
 * GET /api/v1/workspace-templates — list available templates (metadata only).
 *
 * Anonymous-readable so the marketing site can render a "browse templates"
 * gallery without authentication. The list is small + static; we don't
 * paginate.
 */
import { NextResponse } from "next/server";
import { WORKSPACE_TEMPLATES } from "@/lib/templates/workspaces/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    items: WORKSPACE_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      tagline: t.tagline,
      description: t.description,
      highlights: t.highlights,
      estimatedSeconds: t.estimatedSeconds,
    })),
  });
}
