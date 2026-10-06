/**
 * One-time migration: clear `Tenant.llmModel` / `Tenant.llmFastModel` for
 * any workspace still pinned to an LLM model id the upstream provider has
 * since retired. A tenant that explicitly set a model keeps using that
 * exact string forever (see lib/llm/index.ts's resolution order — the
 * tenant value always wins over the driver's current default), so when a
 * provider sunsets a model, every affected tenant's calls start failing
 * with no code change on our side to point at, until someone re-saves the
 * LLM settings form by hand.
 *
 * Confirmed retired (moonshot.ai / moonshot.cn, live account check
 * 2026-09-13 — see lib/llm/providers/openai-compatible.ts and
 * lib/llm/pricing.ts for the same list): the entire moonshot-v1 line, and
 * kimi-k2 / kimi-k2-0711-preview / kimi-k2-turbo-preview / kimi-k2-thinking
 * / kimi-k2.5. kimi-k2.6 and the kimi-k2.7-code* / kimi-k3 ids are current
 * and never touched by this script.
 *
 * Clears to null rather than rewriting to a specific replacement id —
 * null already means "use the provider's current default" (see the
 * settings UI's own "leave blank to use the provider's default", and
 * DELETE /api/admin/tenant/llm which nulls the same fields), so this
 * stays correct automatically the next time a default model changes
 * instead of hardcoding today's replacement and going stale again later.
 *
 * Usage:
 *   npx tsx scripts/migrate-retired-llm-models.ts          # dry run, writes nothing
 *   npx tsx scripts/migrate-retired-llm-models.ts --apply  # commits
 *
 * Idempotent: a tenant with no retired id set matches nothing and is left
 * untouched; safe to re-run.
 */
import { prisma } from "../src/lib/db";

const APPLY = process.argv.includes("--apply");

const RETIRED_EXACT = new Set([
  "kimi-k2",
  "kimi-k2-0711-preview",
  "kimi-k2-turbo-preview",
  "kimi-k2-thinking",
  "kimi-k2.5",
]);

function isRetired(model: string | null): boolean {
  if (!model) return false;
  const m = model.trim();
  return m.startsWith("moonshot-v1") || RETIRED_EXACT.has(m);
}

async function main() {
  const tenants = await prisma.tenant.findMany({
    select: { id: true, name: true, llmProvider: true, llmModel: true, llmFastModel: true },
  });

  const affected = tenants.filter((t) => isRetired(t.llmModel) || isRetired(t.llmFastModel));

  console.log(`Tenants scanned: ${tenants.length}`);
  console.log(`Tenants with a retired model pinned: ${affected.length}\n`);

  for (const t of affected) {
    const clearing: string[] = [];
    if (isRetired(t.llmModel)) clearing.push(`llmModel=${t.llmModel}`);
    if (isRetired(t.llmFastModel)) clearing.push(`llmFastModel=${t.llmFastModel}`);
    console.log(`[${APPLY ? "APPLY" : "DRY-RUN"}] ${t.id} (${t.name}, provider=${t.llmProvider}) — clearing ${clearing.join(", ")}`);

    if (APPLY) {
      await prisma.tenant.update({
        where: { id: t.id },
        data: {
          llmModel: isRetired(t.llmModel) ? null : undefined,
          llmFastModel: isRetired(t.llmFastModel) ? null : undefined,
        },
      });
    }
  }

  console.log(APPLY ? "\nMode: APPLY — done." : "\nMode: DRY-RUN (nothing written — pass --apply to write)");
}

main()
  .catch((e) => { console.error("FATAL:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
