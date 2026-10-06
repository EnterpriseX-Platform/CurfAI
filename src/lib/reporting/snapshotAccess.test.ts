/**
 * A saved ReportRun holds the rows of whoever ran it. Replay, the diff page,
 * KPI history, the Brief's comparisons, Ask's causal pass and watcher diffs
 * read other people's saved runs raw: role-restricted sources, someone's
 * private CSV, unredacted lake columns. savedRunReader() puts each stored
 * query through the gate a live run applies, as the reader.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    dataSource: { findUnique: vi.fn(), findFirst: vi.fn() },
    metric: { findFirst: vi.fn() },
  },
}));
vi.mock("@/lib/reporting/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reporting/runner")>()),
  lakeGate: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { lakeGate, HIDDEN_BY_VISIBILITY } from "@/lib/reporting/runner";
import { hashQueryDef } from "@/lib/reporting/provenance";
import { visibleReport } from "@/lib/reporting/visibleReport";
import { savedRunReader, parseSavedRun, WITHHELD_NOTE } from "./snapshotAccess";

const db = prisma as any;
const gate = vi.mocked(lakeGate);
const T = "t1";

// By name, as snapshotAccess.ts looks a run's source up.
const SOURCES: Record<string, any> = {
  Warehouse: { id: "ds_wh", kind: "postgres", ownerUserId: null, visibleToRolesJson: "[]" },
  Payroll: { id: "ds_pay", kind: "postgres", ownerUserId: null, visibleToRolesJson: '["finance"]' },
  "Bob CSV": { id: "ds_bob", kind: "excel", ownerUserId: "u_bob", visibleToRolesJson: null },
  Lake: { id: "ds_lake", kind: "lake", ownerUserId: null, visibleToRolesJson: "[]" },
};
const BY_ID = Object.fromEntries(Object.values(SOURCES).map((s) => [s.id, s]));
const METRICS: Record<string, any> = { revenue: { dataSourceId: "ds_pay", sql: "SELECT SUM(amount) AS v FROM payroll" } };

const member = { id: "u_member", isAdmin: false, roles: [] as string[] };
const financeMember = { id: "u_fin", isAdmin: false, roles: ["finance"] };
const admin = { id: "u_admin", isAdmin: true, roles: [] as string[] };

const q = (id: string, sql = `SELECT * FROM ${id}`) => ({ id, name: id, dataSourceId: "ds", sql });
const kpi = (id: string, queryId: string, extra: object = {}) => ({
  id, type: "kpi", x: 0, y: 0, w: 4, h: 3, ...extra,
  config: { queryId, label: id, valueField: "v", format: "number" },
});
const report = (dataSources: any[], blocks: any[] = []): any => ({
  version: 1, name: "R", parameters: [], dataSources,
  pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks }],
});
const prov = (queryId: string, dataSourceName: string, extra: object = {}): any => ({
  queryId, queryName: queryId, queryHash: "sha256:old", runAt: "2026-09-01T00:00:00Z", durationMs: 5,
  rowCount: 1, dataHash: "sha256:rows", dataSourceName, dataSourceKind: SOURCES[dataSourceName]?.kind ?? "postgres",
  ...extra,
});
const ROWS = [{ name: "Alice", salary: 123456 }];

beforeEach(() => {
  vi.clearAllMocks();
  db.dataSource.findUnique.mockImplementation(async ({ where }: any) => SOURCES[where.tenantId_name.name] ?? null);
  db.dataSource.findFirst.mockImplementation(async ({ where }: any) => BY_ID[where.id] ?? null);
  db.metric.findFirst.mockImplementation(async ({ where }: any) => METRICS[where.slug] ?? null);
  gate.mockResolvedValue({ ok: true, redacts: false, redact: (rows) => rows });
});

describe("savedRunReader", () => {
  it("keeps rows and provenance from a source the reader can see", async () => {
    const p = prov("q_sales", "Warehouse");
    const out = await savedRunReader(T, report([q("q_sales")]), member)({
      dataset: { q_sales: ROWS }, provenance: { q_sales: p }, params: { region: "north" },
    });
    expect(out).toEqual({ dataset: { q_sales: ROWS }, provenance: { q_sales: p }, params: { region: "north" } });
    expect(db.dataSource.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId_name: { tenantId: T, name: "Warehouse" } },
    }));
  });

  it("role-restricted source: hidden from a member without the role, kept for an admin", async () => {
    const r = report([q("q_pay")]);
    const saved = { dataset: { q_pay: ROWS }, provenance: { q_pay: prov("q_pay", "Payroll") }, params: {} };

    const asMember = await savedRunReader(T, r, member)(saved);
    expect(asMember.dataset.q_pay).toEqual([]);
    expect(asMember.provenance.q_pay).toMatchObject({ rowCount: 0, accessDeniedNote: HIDDEN_BY_VISIBILITY });

    const asAdmin = await savedRunReader(T, r, admin)(saved);
    expect(asAdmin.dataset.q_pay).toEqual(ROWS);
    expect(asAdmin.provenance.q_pay.accessDeniedNote).toBeUndefined();
  });

  it("owner-only source owned by someone else: hidden even for an admin", async () => {
    const out = await savedRunReader(T, report([q("q_csv")]), admin)({
      dataset: { q_csv: ROWS }, provenance: { q_csv: prov("q_csv", "Bob CSV") }, params: {},
    });
    expect(out.dataset.q_csv).toEqual([]);
    expect(out.provenance.q_csv.accessDeniedNote).toBe(HIDDEN_BY_VISIBILITY);
  });

  it("an attached source the reader can't see hides the query; an attached lake source withholds it", async () => {
    const r = report([q("q_join")]);
    const joined = (name: string, kind: string) => ({
      dataset: { q_join: ROWS },
      provenance: { q_join: prov("q_join", "Warehouse", { attachedSources: [{ name, kind, alias: "x" }] }) },
      params: {},
    });

    const payroll = await savedRunReader(T, r, member)(joined("Payroll", "postgres"));
    expect(payroll.dataset.q_join).toEqual([]);
    expect(payroll.provenance.q_join.accessDeniedNote).toBe(HIDDEN_BY_VISIBILITY);

    // Even an admin: the joined-in lake columns can't be re-redacted.
    const lake = await savedRunReader(T, r, admin)(joined("Lake", "lake"));
    expect(lake.dataset.q_join).toEqual([]);
    expect(lake.provenance.q_join.accessDeniedNote).toBe(WITHHELD_NOTE);
  });

  it("withholds a query with no provenance, or whose source is no longer found (renamed)", async () => {
    const r = report([q("q_a"), q("q_b")]);
    const out = await savedRunReader(T, r, admin)({
      dataset: { q_a: ROWS, q_b: ROWS },
      provenance: { q_b: prov("q_b", "Old Warehouse Name") },
      params: {},
    });
    expect(out.dataset).toEqual({ q_a: [], q_b: [] });
    expect(out.provenance.q_a).toMatchObject({ queryId: "q_a", rowCount: 0, accessDeniedNote: WITHHELD_NOTE });
    expect(out.provenance.q_b).toMatchObject({ dataSourceName: "Old Warehouse Name", accessDeniedNote: WITHHELD_NOTE });
  });

  it("passes a query that didn't run through as stored", async () => {
    const denied = prov("q_denied", "Payroll", { rowCount: 0, accessDeniedNote: HIDDEN_BY_VISIBILITY });
    const failed = prov("q_failed", "Gone", { rowCount: 0, executionError: "timeout" });
    const out = await savedRunReader(T, report([q("q_denied"), q("q_failed")]), member)({
      dataset: { q_denied: [], q_failed: [] }, provenance: { q_denied: denied, q_failed: failed }, params: {},
    });
    expect(out.dataset).toEqual({ q_denied: [], q_failed: [] });
    expect(out.provenance).toEqual({ q_denied: denied, q_failed: failed });
    expect(db.dataSource.findUnique).not.toHaveBeenCalled();
  });

  describe("lake source", () => {
    const LAKE_SQL = "SELECT name, email FROM customers WHERE region = :region";
    const def = q("q_lake", LAKE_SQL);
    const params = { region: "north" };
    const stored = [{ name: "Alice", email: "alice@example.com" }];
    const saved = (queryHash: string) => ({
      dataset: { q_lake: stored }, provenance: { q_lake: prov("q_lake", "Lake", { queryHash }) }, params,
    });

    it("withholds rows when the query's SQL has changed since the run", async () => {
      const before = hashQueryDef(q("q_lake", "SELECT name, email, ssn FROM customers WHERE region = :region"), params);
      const out = await savedRunReader(T, report([def]), admin)(saved(before));
      expect(out.dataset.q_lake).toEqual([]);
      expect(out.provenance.q_lake.accessDeniedNote).toBe(WITHHELD_NOTE);
      expect(gate).not.toHaveBeenCalled();
    });

    it("on a hash match, runs lakeGate with the current SQL and the reader and returns its redaction", async () => {
      const redact = vi.fn((rows: any[]) => rows.map((r) => ({ ...r, email: "***" })));
      gate.mockResolvedValue({ ok: true, redacts: true, redact });
      const out = await savedRunReader(T, report([def]), member)(saved(hashQueryDef(def, params)));
      expect(gate).toHaveBeenCalledWith(T, LAKE_SQL, member);
      expect(redact).toHaveBeenCalledWith(stored);
      expect(out.dataset.q_lake).toEqual([{ name: "Alice", email: "***" }]);
      expect(out.provenance.q_lake.accessDeniedNote).toBeUndefined();
    });

    it("hides rows when lakeGate refuses the reader", async () => {
      gate.mockResolvedValue({ ok: false, error: "no access to customers" });
      const out = await savedRunReader(T, report([def]), member)(saved(hashQueryDef(def, params)));
      expect(out.dataset.q_lake).toEqual([]);
      expect(out.provenance.q_lake.accessDeniedNote).toBe(HIDDEN_BY_VISIBILITY);
    });
  });

  it("gates a metric:<slug> key by the metric's source", async () => {
    const r = report([], [kpi("k_rev", "metric:revenue")]);
    const saved = { dataset: { "metric:revenue": [{ v: 42 }] }, provenance: {}, params: {} };

    const asMember = await savedRunReader(T, r, member)(saved);
    expect(asMember.dataset["metric:revenue"]).toEqual([]);
    expect(asMember.provenance["metric:revenue"]).toMatchObject({ queryId: "metric:revenue", accessDeniedNote: HIDDEN_BY_VISIBILITY });

    const asFinance = await savedRunReader(T, r, financeMember)(saved);
    expect(asFinance.dataset["metric:revenue"]).toEqual([{ v: 42 }]);
    expect(db.metric.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: T, slug: "revenue" } }));
    expect(db.dataSource.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "ds_pay", tenantId: T } }));
    // The first test to reach the metric path pays its cold module import
    // (~4.8 s alone), which sat right at vitest's 5 s default and failed
    // whenever the full suite loaded the machine.
  }, 20_000);

  it("drops keys the reader's view doesn't read: a query since removed, a hidden block's query", async () => {
    const full = report([q("q_open"), q("q_salaries")], [
      kpi("k_open", "q_open"),
      kpi("k_salaries", "q_salaries", { visibleToRoles: ["finance"] }),
    ]);
    const out = await savedRunReader(T, visibleReport(full, member), member)({
      dataset: { q_open: ROWS, q_salaries: ROWS, q_removed: ROWS },
      provenance: {
        q_open: prov("q_open", "Warehouse"),
        q_salaries: prov("q_salaries", "Warehouse"),
        q_removed: prov("q_removed", "Warehouse"),
      },
      params: {},
    });
    expect(Object.keys(out.dataset)).toEqual(["q_open"]);
    expect(Object.keys(out.provenance)).toEqual(["q_open"]);
  });

  it("looks each source and lake gate up once across several runs", async () => {
    const lakeDef = q("q_lake");
    const r = report([q("q_sales"), q("q_pay"), lakeDef]);
    const saved = {
      dataset: { q_sales: ROWS, q_pay: ROWS, q_lake: ROWS },
      provenance: {
        q_sales: prov("q_sales", "Warehouse"),
        q_pay: prov("q_pay", "Payroll"),
        q_lake: prov("q_lake", "Lake", { queryHash: hashQueryDef(lakeDef, {}) }),
      },
      params: {},
    };
    const read = savedRunReader(T, r, admin);
    const outs = await Promise.all([read(saved), read(saved), read(saved)]);
    expect(outs.every((o) => o.dataset.q_pay.length === 1 && o.dataset.q_lake.length === 1)).toBe(true);
    expect(db.dataSource.findUnique).toHaveBeenCalledTimes(3);
    expect(gate).toHaveBeenCalledTimes(1);
  });
});

describe("parseSavedRun", () => {
  it("reads a malformed JSON column as {}", () => {
    expect(parseSavedRun({ dataset: "{not json", provenance: '{"q":{"queryId":"q"}}', params: null })).toEqual({
      dataset: {}, provenance: { q: { queryId: "q" } }, params: {},
    });
  });
});
