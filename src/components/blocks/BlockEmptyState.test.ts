/**
 * A block whose query FAILED used to show "No data to show yet." — the same
 * words as a query that simply returned nothing, and worded as "come back
 * later" where the truth is "this is broken". The failed state has to say so
 * and show the reason; the ordinary empty state must be unchanged.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BlockEmptyState } from "./BlockEmptyState";
import { queryNotRun } from "@/lib/reporting/queryRunState";
import { t } from "@/lib/i18n/dict";

// What a client block passes: its type's name and the words for its state, in the reader's language.
const render = (props: Record<string, any>) =>
  renderToStaticMarkup(createElement(BlockEmptyState as any, {
    type: "kpi", blockId: "b1", title: "Churn", typeLabel: t("en", "blockType.kpi"),
    description: t("en", props.notRun ? (props.notRun.kind === "failed" ? "blockEmpty.queryFailed" : "blockEmpty.restricted") : "blockEmpty.noData"),
    ...props,
  }));

describe("queryNotRun", () => {
  const rec = (over: object) => ({ queryId: "q", ...over }) as any;
  it("is undefined for a query that ran (including one that returned nothing) and for a missing record", () => {
    expect(queryNotRun(rec({ rowCount: 0 }))).toBeUndefined();
    expect(queryNotRun(undefined)).toBeUndefined();
  });
  it("carries the reason for a failed or restricted query", () => {
    expect(queryNotRun(rec({ executionError: "boom" }))).toEqual({ kind: "failed", reason: "boom" });
    expect(queryNotRun(rec({ accessDeniedNote: "hidden" }))).toEqual({ kind: "restricted", reason: "hidden" });
  });
});

describe("BlockEmptyState", () => {
  it("an ordinary empty block still says there's no data, with no failure markup", () => {
    const html = render({});
    expect(html).toContain("No data to show yet.");
    expect(html).not.toContain("data-block-not-run");
    expect(html).not.toContain('role="alert"');
  });

  it("a failed query says it didn't run, and shows the reason verbatim", () => {
    const html = render({ notRun: { kind: "failed", reason: 'Binder Error: Referenced column "nope" not found' } });
    expect(html).toContain('data-block-not-run="failed"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Binder Error: Referenced column &quot;nope&quot; not found");
    expect(html).toContain("This query didn&#x27;t run.");
    expect(html).toContain("line-clamp-2"); // a short block must not clip the reason
    expect(html).toContain("title=\"Binder Error");
    expect(html).not.toContain("No data to show yet.");
    expect(html).toContain("text-destructive");
  });

  it("a restricted query says so, in the warning tone", () => {
    const html = render({ notRun: { kind: "restricted", reason: "Hidden by visibility" } });
    expect(html).toContain('data-block-not-run="restricted"');
    expect(html).toContain("You don&#x27;t have access");
    expect(html).toContain("text-warning");
  });

  it("uses a caller's translated description when given one", () => {
    expect(render({ notRun: { kind: "failed", reason: "x" }, description: "คิวรีนี้ทำงานไม่สำเร็จ" })).toContain("คิวรีนี้ทำงานไม่สำเร็จ");
  });
});
