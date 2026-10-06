import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { appBase } from "./appBase";

function req(headers: Record<string, string>, url: string): any {
  const map = new Map(Object.entries(headers));
  return { url, headers: { get: (k: string) => map.get(k) ?? null } };
}

describe("appBase", () => {
  const originalNextAuthUrl = process.env.NEXTAUTH_URL;
  afterEach(() => {
    if (originalNextAuthUrl === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = originalNextAuthUrl;
  });

  it("uses the configured NEXTAUTH_URL first", () => {
    process.env.NEXTAUTH_URL = "https://curfai.centerapp.io/";
    const r = req(
      { "x-forwarded-proto": "https", "x-forwarded-host": "curfai.centerapp.io" },
      "https://localhost:3100/api/forgot",
    );
    expect(appBase(r)).toBe("https://curfai.centerapp.io");
  });

  it("a caller-supplied X-Forwarded-Host can't redirect a reset or invite link", () => {
    // No proxy in front (a self-hosted deployment): the client sends the
    // forwarded headers itself. A reset link built from them would carry a
    // valid token to the attacker's domain.
    process.env.NEXTAUTH_URL = "https://curf.example.com";
    const r = req(
      { "x-forwarded-proto": "https", "x-forwarded-host": "attacker.example", host: "attacker.example" },
      "http://curf.example.com/api/forgot",
    );
    expect(appBase(r)).toBe("https://curf.example.com");
  });

  it("falls back to the forwarded headers when NEXTAUTH_URL is unset", () => {
    delete process.env.NEXTAUTH_URL;
    const r = req(
      { "x-forwarded-proto": "https", "x-forwarded-host": "curfai.centerapp.io" },
      "https://localhost:3100/api/apps/x/viewers",
    );
    expect(appBase(r)).toBe("https://curfai.centerapp.io");
  });

  it("falls back to the request's own origin when neither is available — the local-dev case", () => {
    delete process.env.NEXTAUTH_URL;
    const r = req({}, "http://localhost:3100/api/apps/x/viewers");
    expect(appBase(r)).toBe("http://localhost:3100");
  });

  it("never resolves to the pod's own origin on a real deployment — the live bug this guards", () => {
    // Live case (again on 2026-09-24): behind the k8s ingress req.url is the
    // pod's https://localhost:3100, so every link built from it — reset and
    // invite emails, embed snippets, delivery deep links — was unreachable.
    process.env.NEXTAUTH_URL = "https://curfai.centerapp.io";
    const r = req({}, "https://localhost:3100/api/reports/r1/embed-token");
    expect(appBase(r)).not.toMatch(/localhost/);
  });
});

describe("links are built through appBase()", () => {
  // Thirteen routes still built links from new URL(req.url).origin long after
  // this helper existed. Anything that needs its own origin goes through it.
  it("no route or server module builds a link from the request's own URL", () => {
    const root = join(__dirname, "..", "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name) || p.endsWith(join("http", "appBase.ts"))) continue;
        const src = readFileSync(p, "utf8");
        if (/new URL\(\s*(req|request|ctx\.req)\.url\s*\)\.origin|\breq(uest)?\.nextUrl\.origin/.test(src)) offenders.push(relative(root, p));
      }
    };
    walk(join(root, "app"));
    walk(join(root, "ee"));
    walk(join(root, "lib"));
    expect(offenders).toEqual([]);
  });
});
