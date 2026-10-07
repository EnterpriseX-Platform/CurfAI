import { describe, it, expect } from "vitest";
import { detectDelimiter, importIsSendable, importPayload, looksLikeHeader, parseAttributeImport, parseDelimited, IMPORT_MAX_ROWS } from "./attributeCsv";

describe("detectDelimiter", () => {
  it("finds tabs, commas and semicolons", () => {
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
    expect(detectDelimiter("a,b,c")).toBe(",");
    expect(detectDelimiter("a;b;c")).toBe(";");
  });
  it("ignores separators inside quotes and later lines", () => {
    expect(detectDelimiter('"a,b,c";x;y\n1,2,3,4')).toBe(";");
  });
  it("defaults to a comma", () => expect(detectDelimiter("hello")).toBe(","));
  it("skips leading blank lines", () => expect(detectDelimiter("\n\na;b;c")).toBe(";"));
});

describe("parseDelimited", () => {
  it("handles CRLF, LF and CR, and drops blank lines", () => {
    const r = parseDelimited("a,b\r\n\r\nc,d\ne,f\rg,h", ",");
    expect(r.map((x) => x.cells)).toEqual([["a", "b"], ["c", "d"], ["e", "f"], ["g", "h"]]);
  });
  it("reports the line each record starts on", () => {
    expect(parseDelimited("a,b\n\nc,d", ",").map((x) => x.line)).toEqual([1, 3]);
  });
  it("reads quoted fields with delimiters, escaped quotes and line breaks", () => {
    const r = parseDelimited('a,"b,1","say ""hi""","x\ny"\nnext,1,2,3', ",");
    expect(r[0].cells).toEqual(["a", "b,1", 'say "hi"', "x\ny"]);
    expect(r[1].line).toBe(3);
  });
  it("strips a BOM", () => expect(parseDelimited("﻿email,x", ",")[0].cells[0]).toBe("email"));
  it("keeps an empty quoted cell and a last line without a newline", () => {
    expect(parseDelimited('a,"",c', ",")[0].cells).toEqual(["a", "", "c"]);
    expect(parseDelimited("a,b", ",")).toHaveLength(1);
  });
  it("reads Thai text", () => expect(parseDelimited("สมชาย,หน่วยงาน", ",")[0].cells).toEqual(["สมชาย", "หน่วยงาน"]));
});

describe("looksLikeHeader", () => {
  it("detects an email header, not an address", () => {
    expect(looksLikeHeader({ line: 1, cells: ["Email", "attribute", "value"] })).toBe(true);
    expect(looksLikeHeader({ line: 1, cells: ["email address"] })).toBe(true);
    expect(looksLikeHeader({ line: 1, cells: ["email@x.com", "a", "b"] })).toBe(false);
    expect(looksLikeHeader(undefined)).toBe(false);
  });
});

describe("parseAttributeImport", () => {
  it("parses a header, groups values per person and attribute, lowercases emails", () => {
    const p = parseAttributeImport("email,attribute,value\nAna@x.com,agency_code,A001\nana@x.com,agency_code,A002\nana@x.com,agency_code,A001\nbob@x.com,region,N");
    expect(p.headerSkipped).toBe(true);
    expect(p.totalRows).toBe(4);
    expect(p.problems).toEqual([]);
    expect(p.sets).toEqual([
      { email: "ana@x.com", name: "agency_code", values: ["A001", "A002"] },
      { email: "bob@x.com", name: "region", values: ["N"] },
    ]);
    expect(p.people).toBe(2);
    expect(p.attributes).toEqual(["agency_code", "region"]);
    expect(importIsSendable(p)).toBe(true);
    expect(importPayload(p)).toHaveLength(4);
  });
  it("works without a header, with tabs from a spreadsheet and Thai values", () => {
    const p = parseAttributeImport("a@x.com\tagency\tกรมบัญชีกลาง\r\nb@x.com\tagency\tสำนักงบประมาณ\r\n");
    expect(p.headerSkipped).toBe(false);
    expect(p.delimiter).toBe("\t");
    expect(p.sets.map((s) => s.values[0])).toEqual(["กรมบัญชีกลาง", "สำนักงบประมาณ"]);
  });
  it("reports each bad row by line and blocks sending", () => {
    const p = parseAttributeImport("email,attribute,value\na@x.com,ok,1\nnot-an-email,ok,1\nb@x.com,1bad,1\nc@x.com,ok,\nd@x.com,ok\ne@x.com,ok," + "x".repeat(201));
    expect(p.problems.map((x) => [x.line, x.code])).toEqual([[3, "email"], [4, "name"], [5, "valueMissing"], [6, "columns"], [7, "valueTooLong"]]);
    expect(p.rows).toHaveLength(1);
    expect(importIsSendable(p)).toBe(false);
  });
  it("flags a control character in a value", () => {
    expect(parseAttributeImport("a@x.com,ok,x\u0001y").problems[0].code).toBe("valueControl");
  });
  it("flags too many values for one person and attribute", () => {
    const lines = Array.from({ length: 1001 }, (_, i) => `a@x.com,ok,v${i}`).join("\n");
    const p = parseAttributeImport(lines);
    expect(p.problems.map((x) => x.code)).toEqual(["tooManyValues"]);
    expect(p.sets).toEqual([]);
  });
  it("refuses more than the row limit and says so", () => {
    const lines = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `p${i}@x.com,ok,1`).join("\n");
    const p = parseAttributeImport(lines);
    expect(p.tooMany).toBe(true);
    expect(importIsSendable(p)).toBe(false);
    expect(parseAttributeImport(lines.split("\n").slice(0, IMPORT_MAX_ROWS).join("\n")).tooMany).toBe(false);
  });
  it("is not sendable when empty", () => {
    expect(importIsSendable(parseAttributeImport(""))).toBe(false);
    expect(importIsSendable(parseAttributeImport("email,attribute,value"))).toBe(false);
  });
  it("accepts semicolons and quoted cells", () => {
    const p = parseAttributeImport('"a@x.com";"agency_code";"A;1"');
    expect(p.sets[0]).toEqual({ email: "a@x.com", name: "agency_code", values: ["A;1"] });
  });
});
