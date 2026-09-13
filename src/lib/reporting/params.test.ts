import { describe, it, expect } from "vitest";
import { defaultParamValues, parseParams } from "./params";
import type { Parameter } from "@/lib/reporting/schema";

describe("defaultParamValues", () => {
  it("uses a declared default when one exists", () => {
    const params: Parameter[] = [{ name: "region", label: "Region", type: "string", required: false, default: "APAC" }];
    expect(defaultParamValues(params)).toEqual({ region: "APAC" });
  });

  it("falls back to an empty string for a parameter with no default — the bug this fixes", () => {
    // A non-required string parameter with no `default` used to be left out
    // of the params object entirely (loadBrief passed `{}`), which binds
    // as SQL NULL. A report whose SQL reads `(:site = '' OR site_code =
    // :site)` for "no filter" then matches zero rows against every real
    // row, silently zeroing out every KPI that depends on it.
    const params: Parameter[] = [{ name: "site", label: "Site", type: "string", required: false }];
    expect(defaultParamValues(params)).toEqual({ site: "" });
  });

  it("gives every declared parameter a bound value, not just the ones with a default", () => {
    const params: Parameter[] = [
      { name: "region", label: "Region", type: "string", required: false, default: "APAC" },
      { name: "site", label: "Site", type: "string", required: false },
      { name: "minAmount", label: "Min amount", type: "number", required: false },
    ];
    expect(defaultParamValues(params)).toEqual({ region: "APAC", site: "", minAmount: "" });
  });

  it("returns an empty object for a report with no declared parameters", () => {
    expect(defaultParamValues([])).toEqual({});
  });
});

/**
 * parseParams is defaultParamValues's sibling for a caller that DOES have a
 * URL to read overrides from — the four export routes (XLSX/DOCX/CSV call
 * runReport with its output directly; PDF replays the viewer's own URL
 * through Puppeteer, so it never hits this function's bug). It had the
 * exact same gap defaultParamValues was fixed for above, just never
 * mirrored here: a parameter with no `default` and no `?p.name=` on the
 * URL was left out of the object entirely instead of bound to "". Found
 * live — exporting "Sales & Margin Trends" (an undefaulted "store"
 * parameter) or "Claims Register" (undefaulted "site") to XLSX/DOCX/CSV
 * produced a 200, a plausible-looking file, and zero rows of real data,
 * because runReport threw "Missing parameter" on every data source and
 * the export routes never surfaced that failure to the caller.
 */
describe("parseParams", () => {
  function urlWith(query: string): URL {
    return new URL(`http://localhost/api/reports/x/export/csv${query}`);
  }

  it("uses a declared default when the URL carries no override", () => {
    const params: Parameter[] = [{ name: "region", label: "Region", type: "string", required: false, default: "APAC" }];
    expect(parseParams(urlWith(""), params)).toEqual({ region: "APAC" });
  });

  it("falls back to an empty string for an undefaulted parameter absent from the URL — the bug this fixes", () => {
    const params: Parameter[] = [{ name: "site", label: "Site", type: "string", required: false }];
    expect(parseParams(urlWith(""), params)).toEqual({ site: "" });
  });

  it("still reads a real override off the URL ahead of any default", () => {
    const params: Parameter[] = [{ name: "site", label: "Site", type: "string", required: false, default: "S-101" }];
    expect(parseParams(urlWith("?p.site=S-106"), params)).toEqual({ site: "S-106" });
  });

  it("coerces number and boolean overrides, unaffected by the fallback path", () => {
    const params: Parameter[] = [
      { name: "minAmount", label: "Min amount", type: "number", required: false },
      { name: "onlyOpen", label: "Only open", type: "boolean", required: false },
    ];
    expect(parseParams(urlWith("?p.minAmount=500&p.onlyOpen=true"), params)).toEqual({
      minAmount: 500, onlyOpen: true,
    });
  });

  it("binds every declared parameter, mixing defaults, overrides, and the empty-string fallback", () => {
    const params: Parameter[] = [
      { name: "region", label: "Region", type: "string", required: false, default: "APAC" },
      { name: "site", label: "Site", type: "string", required: false },
      { name: "minAmount", label: "Min amount", type: "number", required: false },
    ];
    expect(parseParams(urlWith("?p.region=EMEA"), params)).toEqual({
      region: "EMEA", site: "", minAmount: "",
    });
  });
});
