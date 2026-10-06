/**
 * runLakeImportJob — a staged file into a table, a batch at a time. Runs the
 * real lake writers against a real (temporary) lake directory; only the
 * Prisma row writes, the staging lookup, the quota and the catalog
 * registration are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = vi.hoisted(() => {
  const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "curf-import-"));
  process.env.CURF_LAKE_DIR = dir;
  return dir as string;
});

const jobUpdates: any[] = [];
vi.mock("@/lib/db", () => ({
  prisma: { aiJob: { update: vi.fn(async (args: any) => { jobUpdates.push(args.data); return args.data; }) } },
}));
vi.mock("@/ee", () => ({ ee: {} }));

let stagedPath = "";
let stagedName = "data.csv";
const deleteStagedUpload = vi.fn(async () => {});
vi.mock("./uploadStaging", () => ({
  getStagedUpload: vi.fn(async () => ({ upload: { filename: stagedName, size: 1 }, dataPath: stagedPath, received: 1 })),
  deleteStagedUpload: (...a: unknown[]) => deleteStagedUpload(...(a as [])),
}));

let quotaMaxBytes: number | null = null;
vi.mock("./quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./quota")>()),
  getQuotaForTenant: vi.fn(async () => ({ tier: "growth", maxBytes: quotaMaxBytes, maxTables: null })),
}));

const registerCreatedTable = vi.fn(async (opts: any) => ({ id: "tbl1", name: opts.name, rowCount: opts.rowCount, sizeBytes: 0 }));
vi.mock("./tableRegistration", () => ({ registerCreatedTable: (o: any) => registerCreatedTable(o) }));

const recordStandardImport = vi.fn(async (opts: any) => ({ id: "std1", name: opts.ds.tableName, sizeBytes: 0 }));
const saveImportMapping = vi.fn(async (_opts: any) => {});
const refreshRetailMetrics = vi.fn(async (_user: any) => ({ tables: [{ name: "stock_status", rowCount: 1 }] }));
vi.mock("./retailMetrics", () => ({ refreshRetailMetrics: (u: any) => refreshRetailMetrics(u) }));
vi.mock("@/lib/templates/retail/setup", () => ({ keepRetailReportsCurrent: vi.fn(async () => undefined) }));
vi.mock("./standardImport", () => ({
  recordStandardImport: (o: any) => recordStandardImport(o),
  saveImportMapping: (o: any) => saveImportMapping(o),
}));

import { runLakeImportJob, claimImportTarget } from "./importJob";
import { closeLake, openLake } from "./storage";
import { headerSignature } from "./columnMapping";

afterAll(() => {
  // Windows can't delete a SQLite file that is still open.
  closeLake(user.tenantId);
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.CURF_LAKE_DIR;
});

const user = { id: "u1", tenantId: "tenantImport", role: "admin", email: "a@b.c" } as any;

function stage(name: string, body: string) {
  stagedName = name;
  stagedPath = path.join(root, `staged-${Date.now()}-${Math.random()}.csv`);
  fs.writeFileSync(stagedPath, body);
}

beforeEach(() => {
  jobUpdates.length = 0;
  deleteStagedUpload.mockClear();
  registerCreatedTable.mockClear();
  recordStandardImport.mockClear();
  saveImportMapping.mockClear();
  refreshRetailMetrics.mockClear();
  quotaMaxBytes = null;
});

async function run(name: string, extra: Partial<Parameters<typeof runLakeImportJob>[0]> = {}) {
  expect(claimImportTarget(user.tenantId, name)).toBe(true);
  await runLakeImportJob({ jobId: "job1", user, uploadId: "x".repeat(32), name, textRepair: null, ...extra });
  return jobUpdates[jobUpdates.length - 1];
}

describe("runLakeImportJob", () => {
  it("imports every row across batches and keeps the user's column types the whole way", async () => {
    // "code" LOOKS numeric ("1,234") but the user kept it as text in the
    // preview. Re-deriving types per batch would clean later batches'
    // values to 1234 part-way through the file.
    const lines = ["code,qty"];
    for (let i = 0; i < 12_345; i++) lines.push(`"1,${String(i % 1000).padStart(3, "0")}",${i}`);
    stage("codes.csv", lines.join("\n"));

    const last = await run("codes", { columnTypeOverrides: { code: "text", qty: "number" } });

    expect(last).toMatchObject({ status: "done", progressPct: 100 });
    const rows = openLake(user.tenantId).prepare(`SELECT code FROM "codes"`).all() as Array<{ code: string }>;
    expect(rows).toHaveLength(12_345);
    expect(rows.every((r) => /^1,\d{3}$/.test(r.code))).toBe(true);
    expect(registerCreatedTable).toHaveBeenCalledWith(expect.objectContaining({ name: "codes", rowCount: 12_345, sourceKind: "upload" }));
    expect(deleteStagedUpload).toHaveBeenCalled();
  });

  it("repairs garbled text in headers and values when asked", async () => {
    const garbled = (s: string) => Array.from(Buffer.from(s, "utf8"))
      .map((b) => (b < 0x80 ? String.fromCharCode(b) : new TextDecoder("macintosh").decode(new Uint8Array([b])))).join("");
    stage("thai.csv", `${garbled("สาขา")},qty\n${garbled("บางนา")},1\n`);

    await run("thai", { textRepair: "mac_roman" });

    const rows = openLake(user.tenantId).prepare(`SELECT * FROM "thai"`).all();
    expect(rows).toEqual([{ สาขา: "บางนา", qty: "1" }]);
  });

  it("stops at the lake quota, drops the partial table and keeps the file for a retry", async () => {
    const lines = ["n"];
    for (let i = 0; i < 12_000; i++) lines.push(String(i));
    stage("toobig.csv", lines.join("\n"));
    quotaMaxBytes = 1; // Any write at all goes past it.

    const last = await run("toobig");

    expect(last.status).toBe("failed");
    expect(JSON.parse(last.errorJson).error).toMatch(/Lake storage cap reached after 5,000 rows/);
    const exists = openLake(user.tenantId).prepare(`SELECT name FROM sqlite_master WHERE name = 'toobig'`).get();
    expect(exists).toBeUndefined();
    expect(registerCreatedTable).not.toHaveBeenCalled();
    expect(deleteStagedUpload).not.toHaveBeenCalled();
  });

  it("releases the table name when it finishes, so the next import can claim it", async () => {
    stage("again.csv", "a\n1\n");
    await run("again");
    expect(claimImportTarget(user.tenantId, "again")).toBe(true);
  });
});

/**
 * Importing into a standard dataset: rows mapped onto sales_lines /
 * inventory, staged, and merged in — replacing the period the file covers,
 * so the same export uploaded twice never counts twice.
 */
describe("runLakeImportJob — standard datasets", () => {
  const SALES_MAP = {
    sale_date: { column: "Date" }, product: { column: "Item" }, qty: { column: "Qty" }, net_amount: { column: "Total" },
  };
  const sales = (branch: string) => ({ dataset: "sales_lines" as const, mapping: { ...SALES_MAP, branch: { value: branch } } });
  const db = () => openLake(user.tenantId);
  const count = (where = "1=1") => (db().prepare(`SELECT COUNT(*) AS n FROM sales_lines WHERE ${where}`).get() as { n: number }).n;
  const sum = () => (db().prepare("SELECT SUM(CAST(net_amount AS REAL)) AS s FROM sales_lines").get() as { s: number }).s;
  const result = (u: any) => JSON.parse(u.resultJson);

  it("maps, merges, and doesn't double-count the same file uploaded again", async () => {
    stage("siam-sep.csv", "Date,Item,Qty,Total\n01/09/2026,Latte,2,130\n15/09/2026,Tea,1,40\n30/09/2026,Latte,1,65\nTotal,,4,235\n");
    const first = await run("sales_lines", { standard: sales("สยาม") });
    expect(first.status).toBe("done");
    expect(result(first).standard).toMatchObject({
      dataset: "sales_lines", inserted: 3, replaced: 0, skipped: { sale_date: 1 },
      periods: [{ partition: "สยาม", from: "2026-09-01", to: "2026-09-30" }],
    });
    expect(count()).toBe(3);
    expect(sum()).toBe(235);
    // The stock and sales figures follow every import into a standard table.
    expect(refreshRetailMetrics).toHaveBeenCalledTimes(1);
    expect(result(first).standard.metrics).toEqual({ tables: [{ name: "stock_status", rowCount: 1 }] });
    // Remembered for this layout, so next month's export maps itself.
    expect(saveImportMapping).toHaveBeenCalledWith(expect.objectContaining({
      signature: headerSignature(["Date", "Item", "Qty", "Total"]), filename: "siam-sep.csv",
      mapping: expect.objectContaining({ branch: { value: "สยาม" } }),
    }));

    const again = await run("sales_lines", { standard: sales("สยาม") });
    expect(result(again).standard).toMatchObject({ inserted: 3, replaced: 3 });
    expect(count()).toBe(3);
    expect(sum()).toBe(235);
  });

  it("keeps each branch's rows apart, and replaces only the dates a later file covers", async () => {
    stage("ari-sep.csv", "Date,Item,Qty,Total\n10/09/2026,Mocha,1,70\n");
    await run("sales_lines", { standard: sales("อารีย์") });
    expect(count("branch = 'อารีย์'")).toBe(1);
    expect(count("branch = 'สยาม'")).toBe(3);

    // A corrected export of 15–30 Sep for สยาม: 1 Sep stays, 15 and 30 Sep are replaced.
    stage("siam-late-sep.csv", "Date,Item,Qty,Total\n15/09/2026,Tea,2,80\n20/09/2026,Cake,1,90\n30/09/2026,Latte,1,65\n");
    const fix = await run("sales_lines", { standard: sales("สยาม") });
    expect(result(fix).standard).toMatchObject({ inserted: 3, replaced: 2 });
    expect(count("branch = 'สยาม'")).toBe(4);
    expect(db().prepare("SELECT sale_date, source_file FROM sales_lines WHERE branch = 'สยาม' ORDER BY sale_date").all()).toEqual([
      { sale_date: "2026-09-01", source_file: "siam-sep.csv" },
      { sale_date: "2026-09-15", source_file: "siam-late-sep.csv" },
      { sale_date: "2026-09-20", source_file: "siam-late-sep.csv" },
      { sale_date: "2026-09-30", source_file: "siam-late-sep.csv" },
    ]);
    expect(count("branch = 'อารีย์'")).toBe(1);
  });

  it("replaces a stock snapshot by its exact dates", async () => {
    const stock = { dataset: "inventory" as const, mapping: { snapshot_date: { column: "day_sid" }, branch: { column: "store_no" }, sku: { column: "prod_num" }, on_hand: { column: "inv_soh_qty" } } };
    stage("aging-20.csv", "day_sid,store_no,prod_num,inv_soh_qty\n20260920,17,100226,5\n20260920,17,100953,2\n");
    await run("inventory", { standard: stock });
    stage("aging-21.csv", "day_sid,store_no,prod_num,inv_soh_qty\n20260921,17,100226,4\n");
    await run("inventory", { standard: stock });
    stage("aging-21-fixed.csv", "day_sid,store_no,prod_num,inv_soh_qty\n20260921,17,100226,3\n20260921,17,100953,2\n");
    const fix = await run("inventory", { standard: stock });
    expect(result(fix).standard).toMatchObject({ inserted: 2, replaced: 1 });
    expect(db().prepare("SELECT snapshot_date, sku, on_hand FROM inventory ORDER BY snapshot_date, sku").all()).toEqual([
      { snapshot_date: "2026-09-20", sku: "100226", on_hand: "5" },
      { snapshot_date: "2026-09-20", sku: "100953", on_hand: "2" },
      { snapshot_date: "2026-09-21", sku: "100226", on_hand: "3" },
      { snapshot_date: "2026-09-21", sku: "100953", on_hand: "2" },
    ]);
  });

  it("fails on a mapping the file's headers don't have, leaving the table and nothing staged behind", async () => {
    const before = count();
    stage("renamed.csv", "Day,Menu,Qty,Total\n01/10/2026,Latte,1,65\n");
    const failed = await run("sales_lines", { standard: sales("สยาม") });
    expect(failed.status).toBe("failed");
    expect(JSON.parse(failed.errorJson).error).toMatch(/the file has no column "Date"/);
    expect(count()).toBe(before);
    const leftovers = db().prepare("SELECT name FROM sqlite_master WHERE name LIKE 'import_%'").all();
    expect(leftovers).toEqual([]);
    expect(recordStandardImport).not.toHaveBeenCalled();
    expect(saveImportMapping).not.toHaveBeenCalled();
    expect(refreshRetailMetrics).not.toHaveBeenCalled();
  });

  it("fails when every row is skipped, saying why", async () => {
    stage("totals-only.csv", "Date,Item,Qty,Total\n,Total,4,235\n");
    const failed = await run("sales_lines", { standard: sales("สยาม") });
    expect(JSON.parse(failed.errorJson).error).toMatch(/None of the 1 rows could be imported — each was missing sale_date/);
  });
});
