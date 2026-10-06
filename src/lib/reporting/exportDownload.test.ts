import { describe, it, expect, vi, afterEach } from "vitest";
import { exportFailureToast, fetchExport, reportExportUrl } from "./exportDownload";
import { t as translate } from "@/lib/i18n/dict";

function answer(res: Response | Error) {
  vi.stubGlobal("fetch", vi.fn(async () => { if (res instanceof Error) throw res; return res; }));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("reportExportUrl", () => {
  it("sends filter values as p.<name> and leaves out empty ones", () => {
    expect(reportExportUrl("r1", "xlsx", { region: "APAC", site: "", year: 2026, owner: null }))
      .toBe("/api/reports/r1/export/xlsx?p.region=APAC&p.year=2026");
  });

  it("has no query string without filters", () => {
    expect(reportExportUrl("r1", "pdf")).toBe("/api/reports/r1/export/pdf");
  });
});

describe("fetchExport", () => {
  it("returns the file and the name from Content-Disposition", async () => {
    answer(new Response("a,b\n1,2", {
      headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="sales.csv"' },
    }));
    const res = await fetchExport("/x", "report.csv");
    expect(res.ok && res.filename).toBe("sales.csv");
    expect(res.ok && await res.blob.text()).toBe("a,b\n1,2");
  });

  it("falls back to the given name when there's no Content-Disposition", async () => {
    answer(new Response("%PDF"));
    const res = await fetchExport("/x", "report.pdf");
    expect(res.ok && res.filename).toBe("report.pdf");
  });

  it("reports a saturated renderer's 503 as busy, with its Retry-After", async () => {
    answer(Response.json(
      { error: "Too many exports are rendering right now. Try again in a minute." },
      { status: 503, headers: { "Retry-After": "30" } },
    ));
    expect(await fetchExport("/x", "report.pdf")).toEqual({ ok: false, kind: "busy", retryAfterSec: 30 });
  });

  it("reports a 503 without a usable Retry-After as busy with no wait", async () => {
    answer(new Response("<html>Service Unavailable</html>", { status: 503, headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" } }));
    expect(await fetchExport("/x", "report.pdf")).toEqual({ ok: false, kind: "busy", retryAfterSec: null });
  });

  it("passes on the route's error message for any other failure", async () => {
    answer(Response.json({ error: "No table block to export as CSV" }, { status: 400 }));
    expect(await fetchExport("/x", "report.csv")).toEqual({ ok: false, kind: "failed", message: "No table block to export as CSV" });
  });

  it("has no message when the failure body isn't JSON", async () => {
    answer(new Response("Internal Server Error", { status: 500 }));
    expect(await fetchExport("/x", "report.docx")).toEqual({ ok: false, kind: "failed", message: null });
  });

  it("reports a request that never got an answer as a network failure", async () => {
    answer(new TypeError("Failed to fetch"));
    expect(await fetchExport("/x", "report.xlsx")).toEqual({ ok: false, kind: "network" });
  });

  it("sends the request options it's given, for a schedule's POST run", async () => {
    answer(new Response("%PDF", { headers: { "Content-Disposition": 'attachment; filename="weekly-sales.pdf"' } }));
    const res = await fetchExport("/api/schedules/s1/run", "report", { method: "POST" });
    expect(fetch).toHaveBeenCalledWith("/api/schedules/s1/run", { method: "POST" });
    expect(res.ok && res.filename).toBe("weekly-sales.pdf");
  });
});

describe("exportFailureToast", () => {
  const en = (key: string) => translate("en", key);

  it("says the renderer is busy, with the wait from Retry-After, whatever the caller's title", () => {
    expect(exportFailureToast({ ok: false, kind: "busy", retryAfterSec: 30 }, en, "Run failed")).toEqual({
      variant: "destructive",
      title: "Exports are busy right now",
      description: "Other exports are still rendering, so this one didn't start. Try again in about 30 seconds.",
    });
  });

  it("says to try again in a minute when the 503 had no usable Retry-After", () => {
    expect(exportFailureToast({ ok: false, kind: "busy", retryAfterSec: null }, en, "Run failed").description)
      .toBe("Other exports are still rendering, so this one didn't start. Try again in a minute.");
  });

  it("is in the reader's language, not the route's English error", () => {
    const th = (key: string) => translate("th", key);
    const toast = exportFailureToast({ ok: false, kind: "busy", retryAfterSec: 30 }, th, th("schedules.runFailed"));
    expect(toast.title).toBe(translate("th", "export.busyTitle"));
    expect(toast.description).toContain("30");
    expect(toast.description).not.toMatch(/[A-Za-z]/);
  });

  it("puts the route's message under the caller's title for any other failure", () => {
    expect(exportFailureToast({ ok: false, kind: "failed", message: "Navigation timeout" }, en, "Run failed")).toEqual({
      variant: "destructive",
      title: "Run failed",
      description: "Navigation timeout",
    });
  });

  it("falls back to a generic message when the route sent none", () => {
    expect(exportFailureToast({ ok: false, kind: "failed", message: null }, en, "Couldn't export PDF").description)
      .toBe("Something went wrong while generating the file. Try again.");
  });

  it("tells the reader to check their connection when the request never got an answer", () => {
    expect(exportFailureToast({ ok: false, kind: "network" }, en, "Run failed").description)
      .toBe("Couldn't reach the server. Check your connection and try again.");
  });
});
