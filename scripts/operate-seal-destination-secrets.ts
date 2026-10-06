/**
 * One-off: encrypt Operate destination credentials that were stored in
 * plaintext before lib/operate/destinationSecrets.ts existed.
 *
 * API responses already mask these (so nothing leaks once the fix is
 * deployed); this closes the at-rest half. Covers ActionTemplate
 * .destinationConfigJson and every ActionRequest snapshot. Idempotent —
 * already-sealed values are left alone.
 *
 * Usage: npx tsx scripts/operate-seal-destination-secrets.ts [--dry-run]
 */
import { prisma } from "../src/lib/db";
import { withSystemDbContext } from "../src/lib/dbContext";
import { hasPlaintextSecrets, openDestinationConfig, sealDestinationConfig } from "../src/lib/operate/destinationSecrets";

const reseal = (kind: string, cfg: unknown) => sealDestinationConfig(kind, openDestinationConfig(kind, cfg));
const parse = (s: string | null) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  await withSystemDbContext(async () => {
    const templates: any[] = await (prisma as any).actionTemplate.findMany({ select: { id: true, destinationKind: true, destinationConfigJson: true } });
    let t = 0;
    for (const row of templates) {
      const cfg = parse(row.destinationConfigJson);
      if (!hasPlaintextSecrets(row.destinationKind, cfg)) continue;
      t++;
      if (!dryRun) await (prisma as any).actionTemplate.update({ where: { id: row.id }, data: { destinationConfigJson: JSON.stringify(reseal(row.destinationKind, cfg)) } });
    }
    const requests: any[] = await (prisma as any).actionRequest.findMany({ select: { id: true, destinationKind: true, destinationConfigSnapshotJson: true } });
    let r = 0;
    for (const row of requests) {
      const cfg = parse(row.destinationConfigSnapshotJson);
      if (!hasPlaintextSecrets(row.destinationKind, cfg)) continue;
      r++;
      if (!dryRun) await (prisma as any).actionRequest.update({ where: { id: row.id }, data: { destinationConfigSnapshotJson: JSON.stringify(reseal(row.destinationKind, cfg)) } });
    }
    console.log(`${dryRun ? "[dry-run] would seal" : "Sealed"} ${t} template(s) and ${r} request snapshot(s).`);
  });
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
