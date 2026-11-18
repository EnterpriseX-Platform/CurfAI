import { describe, expect, it } from "vitest";
import { requestIdFrom, routeTemplate } from "./http";
import { scrapeVerdict } from "./scrapeAuth";

describe("routeTemplate", () => {
  it("collapses ids to :id so a route is one series, not one per record", () => {
    expect(routeTemplate("/api/reports/cm9x1y2z3a4b5c6d7e8f9g0h1/runs")).toBe("/api/reports/:id/runs");
    expect(routeTemplate("/api/schedules/123")).toBe("/api/schedules/:id");
    expect(routeTemplate("/api/x/3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe("/api/x/:id");
    expect(routeTemplate("/s/AbCdEfGhIjKlMnOpQrStUv")).toBe("/s/:id");
  });
  it("keeps the static shape and caps the depth", () => {
    expect(routeTemplate("/api/health/ready")).toBe("/api/health/ready");
    expect(routeTemplate("/a/b/c/d/e/f/g/h")).toBe("/a/b/c/d/e/f");
    expect(routeTemplate("/")).toBe("/");
  });
  it("gives assets one label", () => {
    expect(routeTemplate("/_next/static/chunks/main-abc.js")).toBe("static");
    expect(routeTemplate("/favicon.ico")).toBe("static");
    expect(routeTemplate("/docs/quickstart")).toBe("static");
  });
  it("labels an absurdly long segment instead of putting it in a label", () => {
    expect(routeTemplate("/x/" + "y".repeat(41) + "!")).toBe("/x/:long");
  });
});

describe("requestIdFrom", () => {
  it("keeps a sane caller id", () => expect(requestIdFrom("abc-123_DEF.456")).toBe("abc-123_DEF.456"));
  it("replaces anything unsafe or missing", () => {
    for (const bad of [undefined, "", "short", "has space in it 123", "x".repeat(65), "line\nbreak12345", "<script>alert(1)</script>"]) {
      expect(requestIdFrom(bad)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe("scrapeVerdict", () => {
  const h = (o: Record<string, string>) => (n: string) => o[n];
  it("is closed when no secret is configured, even for a caller that sends one", () => {
    expect(scrapeVerdict(h({ "x-prom-secret": "x" }), "")).toBe("unconfigured");
    expect(scrapeVerdict(h({}), undefined)).toBe("unconfigured");
  });
  it("accepts the header or a bearer token, nothing else", () => {
    expect(scrapeVerdict(h({ "x-prom-secret": "s3cret" }), "s3cret")).toBe("ok");
    expect(scrapeVerdict(h({ authorization: "Bearer s3cret" }), "s3cret")).toBe("ok");
    expect(scrapeVerdict(h({ authorization: "bearer s3cret" }), "s3cret")).toBe("ok");
    expect(scrapeVerdict(h({}), "s3cret")).toBe("unauthorized");
    expect(scrapeVerdict(h({ "x-prom-secret": "nope" }), "s3cret")).toBe("unauthorized");
    expect(scrapeVerdict(h({ authorization: "Basic s3cret" }), "s3cret")).toBe("unauthorized");
    expect(scrapeVerdict(h({ "x-prom-secret": "s3cret-and-more" }), "s3cret")).toBe("unauthorized");
  });
});
