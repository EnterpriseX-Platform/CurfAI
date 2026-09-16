import { describe, it, expect } from "vitest";
import { refineManualOrigin } from "./originLabel";

describe("refineManualOrigin", () => {
  it("returns null for a non-manual sourceKind regardless of config", () => {
    expect(refineManualOrigin("upload", { kind: "cdc" })).toBeNull();
  });

  it("returns null for manual with no sourceConfig — the genuinely-manual case", () => {
    expect(refineManualOrigin("manual", null)).toBeNull();
    expect(refineManualOrigin("manual", undefined)).toBeNull();
  });

  it("returns null for manual with an unrecognised config shape", () => {
    expect(refineManualOrigin("manual", { something: "else" })).toBeNull();
  });

  it("recognises a CDC change feed, carrying the source table as detail", () => {
    expect(refineManualOrigin("manual", { kind: "cdc", sourceTable: "public.orders" }))
      .toEqual({ labelKey: "tables.source.cdc", detail: "public.orders" });
  });

  it("recognises a materialized view / saved result", () => {
    expect(refineManualOrigin("manual", { kind: "materialized_view", mvId: "mv1" }))
      .toEqual({ labelKey: "tables.source.materializedView" });
  });

  it("recognises Master Builder", () => {
    expect(refineManualOrigin("manual", { provenance: "master-builder", buildId: "b1" }))
      .toEqual({ labelKey: "tables.source.masterBuilder" });
  });

  it("recognises a pipeline step", () => {
    expect(refineManualOrigin("manual", { provenance: "pipeline", pipelineId: "p1" }))
      .toEqual({ labelKey: "tables.source.pipeline" });
  });

  it("recognises a workspace template seed", () => {
    expect(refineManualOrigin("manual", { provenance: "workspace-template", templateId: "t1" }))
      .toEqual({ labelKey: "tables.source.workspaceTemplate" });
  });

  it.each([
    ["line", "tables.source.syncLine"],
    ["postgres", "tables.source.syncPostgres"],
    ["salesforce", "tables.source.syncSalesforce"],
    ["stripe", "tables.source.syncStripe"],
  ])("recognises a %s sync connector", (connectorKind, labelKey) => {
    const result = refineManualOrigin("manual", { provenance: "sync", connectorKind, sourceObject: "Opportunity" });
    expect(result?.labelKey).toBe(labelKey);
  });

  it("carries the sourceObject as detail for postgres/salesforce/stripe but not line", () => {
    expect(refineManualOrigin("manual", { provenance: "sync", connectorKind: "postgres", sourceObject: "orders" })?.detail).toBe("orders");
    expect(refineManualOrigin("manual", { provenance: "sync", connectorKind: "line", sourceObject: "orders" })?.detail).toBeUndefined();
  });

  it("falls back to a generic synced label for an unrecognised connector", () => {
    expect(refineManualOrigin("manual", { provenance: "sync", connectorKind: "hubspot" }))
      .toEqual({ labelKey: "tables.source.sync", detail: undefined });
  });
});
