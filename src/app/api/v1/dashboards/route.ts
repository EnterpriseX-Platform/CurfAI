/**
 * GET /api/v1/dashboards — public-API alias of /api/dashboards.
 *
 * Same handler, same auth (session cookie or `Bearer curf_...`); living
 * under /api/v1 additionally gives it the CORS headers external frontends
 * need (see src/middleware.ts).
 */
export { GET } from "@/app/api/dashboards/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
