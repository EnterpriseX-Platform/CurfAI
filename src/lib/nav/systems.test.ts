import { describe, it, expect } from "vitest";
import { SYSTEMS, visibleSystems, locate, railPins, MAX_PINS, type NavViewer } from "./systems";

/** What the old flat sidebar (AppShell before C1) listed, by who saw it. */
const OLD = {
  all: ["/brief", "/ask", "/reports", "/on-screen", "/dashboards", "/operate/watchers", "/decisions"],
  builder: ["/build", "/notebooks", "/operate/templates", "/operate/insights", "/operate/incidents", "/tables", "/catalog", "/metrics", "/connections", "/knowledge", "/data/quality", "/marketplace", "/templates"],
  inbox: ["/operate"],
  admin: ["/admin/tenant", "/admin/users", "/admin/org", "/admin/api-keys", "/admin/api-explorer", "/admin/billing", "/admin/integrations", "/admin/external-tables", "/admin/audit", "/admin/workspace-templates", "/admin/compliance", "/admin/release-log"],
  platform: ["/admin/waitlist", "/admin/platform/ai-costs", "/admin/platform/models"],
};
const hrefs = (v: NavViewer) => new Set(visibleSystems(v).flatMap((s) => s.sections.map((x) => x.href)));

describe("the systems map keeps every page the old sidebar listed", () => {
  it.each([
    ["admin", true, [...OLD.all, ...OLD.builder, ...OLD.inbox, ...OLD.admin, ...OLD.platform]],
    ["admin", false, [...OLD.all, ...OLD.builder, ...OLD.inbox, ...OLD.admin]],
    ["developer", false, [...OLD.all, ...OLD.builder, ...OLD.inbox]],
    ["editor", false, [...OLD.all, ...OLD.builder]],
    ["executive", false, [...OLD.all, ...OLD.inbox]],
    ["viewer", false, OLD.all],
  ] as const)("%s (platform operator: %s)", (role, isPlatformAdmin, expected) => {
    const seen = hrefs({ role, isPlatformAdmin });
    expect(expected.filter((h) => !seen.has(h))).toEqual([]);
  });

  it("shows no one a builder or admin page the old sidebar hid from them", () => {
    expect([...hrefs({ role: "viewer" })].filter((h) => h.startsWith("/admin") || h === "/build" || h === "/tables")).toEqual([]);
    expect([...hrefs({ role: "editor" })].filter((h) => h.startsWith("/admin") || h === "/operate")).toEqual([]);
  });

  it("files every page under one section only", () => {
    const all = SYSTEMS.flatMap((s) => s.sections.flatMap((x) => [x.href, ...(x.also ?? [])]));
    expect(all.filter((h, i) => all.indexOf(h) !== i)).toEqual([]);
  });

  it("keeps the Community edition to its own pages", () => {
    const seen = [...hrefs({ role: "admin", community: true })].sort();
    expect(seen).toEqual(["/admin/audit", "/admin/compliance", "/admin/release-log", "/admin/tenant", "/admin/users", "/connections", "/dashboards", "/on-screen", "/reports", "/reports/import", "/tables", "/templates"]);
    expect(visibleSystems({ role: "admin", community: true }, [{ slug: "a", title: "A" }]).some((s) => s.id === "apps")).toBe(false);
  });
});

describe("locate", () => {
  const systems = visibleSystems({ role: "admin", isPlatformAdmin: true }, [{ slug: "budget", title: "Budget" }]);
  it.each([
    ["/operate", "home", "inbox"],
    ["/operate/abc123", "home", "inbox"],
    ["/operate/templates/abc/analytics", "operate", "workflows"],
    ["/reports/r1/edit", "reports", "all"],
    ["/reports/import", "reports", "import"],
    ["/admin/brief/delivery", "briefs", "delivery"],
    ["/admin/connections/c1/syncs", "connections", "syncs"],
    ["/connections/engine/e1", "connections", "sources"],
    ["/admin/dbt", "connections", "external"],
    ["/admin/roles", "admin", "members"],
    ["/admin", "admin", "overview"],
    ["/apps/budget/pack", "apps", "budget"],
  ])("%s → %s / %s", (path, system, section) => {
    const hit = locate(path, systems);
    expect([hit?.system.id, hit?.section.id]).toEqual([system, section]);
  });
  it("claims nothing for a page outside the map", () => {
    expect(locate("/account", systems)).toBeNull();
  });
});

describe("railPins", () => {
  const admin: NavViewer = { role: "admin", isPlatformAdmin: true };
  const systems = visibleSystems(admin, [{ slug: "budget", title: "Budget" }]);
  it("starts from the role's defaults, then Apps and Platform", () => {
    expect(railPins(admin, systems)).toEqual(["home", "ask", "reports", "builder", "data", "operate", "admin", "apps"]);
    expect(railPins({ role: "editor" }, visibleSystems({ role: "editor" }))).toEqual(["home", "ask", "reports", "data", "notebooks", "operate"]);
  });
  it("keeps what the person pinned, minus systems they cannot see, up to the limit", () => {
    const editor = visibleSystems({ role: "editor" });
    expect(railPins({ role: "editor" }, editor, ["data", "admin", "home"])).toEqual(["data", "home"]);
    expect(railPins(admin, systems, SYSTEMS.map((s) => s.id))).toHaveLength(MAX_PINS);
  });
});

describe("apps in the menu", () => {
  it("tells two apps with the same title apart by their slug, and leaves a unique one alone", () => {
    const apps = [
      { slug: "exec", title: "Executive" },
      { slug: "exec-2", title: "Executive" },
      { slug: "retail", title: "Retail", titleI18n: { th: "ค้าปลีก" } },
    ];
    const labels = (locale?: string) => visibleSystems({ role: "admin" }, apps, locale).find((s) => s.id === "apps")!.sections.map((x) => x.label);
    expect(labels()).toEqual(["Executive · exec", "Executive · exec-2", "Retail"]);
    expect(labels("th")).toEqual(["Executive · exec", "Executive · exec-2", "ค้าปลีก"]);
  });
});
