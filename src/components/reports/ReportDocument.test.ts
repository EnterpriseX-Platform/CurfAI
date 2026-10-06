/**
 * Issue 04 (QA log): PDF export always had a trailing blank page.
 * PageRenderer forced `break-after: page` on every printed page section,
 * including the last one — a break with nothing left to fill starts a new,
 * empty page in the PDF output. Pins that the last page never gets one.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PageRenderer } from "./ReportDocument";
import type { Page, Report } from "@/lib/reporting/schema";

const PAGE: Page = { id: "p1", size: "A4", orientation: "portrait", blocks: [] };
const REPORT = { name: "Test Report" } as Report;

const render = (pageIndex: number, totalPages: number) =>
  renderToStaticMarkup(
    createElement(PageRenderer as any, {
      page: PAGE, report: REPORT, dataset: {}, params: {}, print: true,
      pageIndex, totalPages,
    }),
  );

describe("PageRenderer — print pagination", () => {
  it("breaks after every page except the last, when printing a multi-page report", () => {
    const first = render(0, 3);
    const middle = render(1, 3);
    const last = render(2, 3);
    expect(first).toContain("break-after:page");
    expect(middle).toContain("break-after:page");
    expect(last).not.toContain("break-after:page");
  });

  it("a single-page report never breaks (no trailing blank page)", () => {
    const only = render(0, 1);
    expect(only).not.toContain("break-after:page");
  });

  it("never breaks when not printing (interactive viewer)", () => {
    const html = renderToStaticMarkup(
      createElement(PageRenderer as any, {
        page: PAGE, report: REPORT, dataset: {}, params: {}, print: false,
        pageIndex: 0, totalPages: 2,
      }),
    );
    expect(html).not.toContain("break-after:page");
  });
});
