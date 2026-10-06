// Runs a report through Curf's REAL runner (src/lib/reporting/runner.ts) against a Postgres data source and
// writes the dataset + provenance to a file, so the engine's output can be compared with it.
import { writeFileSync } from "node:fs";
import { prisma as db } from "@/lib/db";
import { encodePgConnection } from "@/lib/connections/postgres";
import { runReportWithProof } from "@/lib/reporting/runner";
import { ReportSchema } from "@/lib/reporting/schema";

const q = (id: string, name: string, sql: string) => ({ id, name, dataSourceId: "__SOURCE__", sql });

const definition = {
  version: 1,
  name: "Parity report",
  parameters: [
    { name: "from", label: "From", type: "date", default: "2026-01-01" },
    { name: "min", label: "Min", type: "number", default: 0 },
  ],
  dataSources: [
    q("ds_by_agency", "By agency",
      "SELECT agency_code, count(*) AS n, sum(amount) AS total FROM agency_data WHERE created >= :from AND amount >= :min GROUP BY agency_code ORDER BY agency_code"),
    q("ds_rows", "Rows",
      "SELECT id, agency_code, name, email, salary, amount FROM agency_data WHERE created >= :from AND amount >= :min ORDER BY id"),
    q("ds_dates", "Dates", "SELECT id, created FROM agency_data WHERE id <= 3 ORDER BY id"),
    q("ds_cast", "Casts", "SELECT id, amount::float8 AS f, (salary * 1.5)::numeric(12,2) AS s, salary::bigint AS big FROM agency_data WHERE id <= 3 ORDER BY id"),
    q("ds_thai", "Thai", "SELECT id, \"ที่อยู่\" AS addr, name FROM agency_data WHERE id <= 3 ORDER BY id"),
    q("ds_empty", "Empty", "SELECT id FROM agency_data WHERE id < 0"),
    q("ds_bad", "Bad", "SELECT * FROM missing_table_xyz"),
  ],
  pages: [{
    id: "p1", size: "A4", orientation: "portrait",
    blocks: ["ds_by_agency", "ds_rows", "ds_dates", "ds_cast", "ds_thai", "ds_empty", "ds_bad"].map((queryId, i) => ({
      id: `b${i}`, type: "table", x: 0, y: i * 4, w: 12, h: 4, config: { queryId, columns: [] },
    })),
  }],
};

const tenant = await db.tenant.upsert({ where: { slug: "parity" }, update: {}, create: { slug: "parity", name: "Parity" } });
const source = await db.dataSource.create({
  data: {
    tenantId: tenant.id, name: `agency-${Date.now()}`, kind: "postgres",
    connection: encodePgConnection({
      host: process.env.TARGET_HOST!, port: Number(process.env.TARGET_PORT), database: process.env.TARGET_DB!,
      user: "curf_reader", password: "Pw-test-1",
    }),
  },
});

const cases: Record<string, Record<string, unknown>> = {
  defaults: { from: "2026-01-01", min: 0 },
  filtered: { from: "2026-02-01", min: 50 },
};

const out: Record<string, unknown> = { definition };
for (const [name, params] of Object.entries(cases)) {
  const report = ReportSchema.parse(JSON.parse(JSON.stringify(definition).replaceAll("__SOURCE__", source.id)));
  const res = await runReportWithProof({ report, tenantId: tenant.id, params, viewer: "system" });
  out[name] = { params, dataset: res.dataset, provenance: res.provenance };
}
writeFileSync(process.env.OUT!, JSON.stringify(out, null, 1));
await db.dataSource.delete({ where: { id: source.id } });
await db.$disconnect();
console.log("curf runner done");
