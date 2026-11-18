import { describe, expect, it } from "vitest";
import { createLogger, addLogContext, withLogContext } from "./log";

function capture(level: "debug" | "info" | "warn" | "error" | "silent" = "info") {
  const lines: Record<string, any>[] = [];
  const log = createLogger({ level, sink: (l) => lines.push(JSON.parse(l)), now: () => new Date("2026-11-16T10:00:00Z") });
  return { log, lines };
}

describe("log", () => {
  it("writes one JSON object with level, time and message", () => {
    const { log, lines } = capture();
    log.info("hello", { n: 3 });
    expect(lines).toEqual([{ n: 3, level: "info", time: "2026-11-16T10:00:00.000Z", msg: "hello" }]);
  });

  it("drops lines under the threshold, and everything when silent", () => {
    const a = capture("warn");
    a.log.info("x"); a.log.warn("y");
    expect(a.lines.map((l) => l.msg)).toEqual(["y"]);
    const b = capture("silent");
    b.log.error("z");
    expect(b.lines).toEqual([]);
  });

  it("redacts fields named like credentials, at any depth", () => {
    const { log, lines } = capture();
    log.info("x", { password: "hunter2", nested: { apiKey: "k", clientSecret: "s", accessToken: "t", fine: 1 }, authorization: "Bearer abc", passwordEnc: "zz", cookie: "c" });
    const l = lines[0];
    expect(l.password).toBe("[redacted]");
    expect(l.nested).toEqual({ apiKey: "[redacted]", clientSecret: "[redacted]", accessToken: "[redacted]", fine: 1 });
    expect(l.authorization).toBe("[redacted]");
    expect(l.passwordEnc).toBe("[redacted]");
    expect(l.cookie).toBe("[redacted]");
  });

  it("masks email addresses wherever they appear: values, messages, error text", () => {
    const { log, lines } = capture();
    log.warn("could not mail somebody.name+tag@example.co.th", { to: "a@b.com", list: ["x@y.org"], err: new Error("Keycloak says user bob@corp.example exists") });
    const l = lines[0];
    expect(JSON.stringify(l)).not.toMatch(/@(example|b\.com|y\.org|corp)/);
    expect(l.msg).toContain("[email]");
    expect(l.err.message).toBe("Keycloak says user [email] exists");
    expect(l.err.type).toBe("Error");
  });

  it("keeps a short stack, cuts long strings, survives circular objects", () => {
    const { log, lines } = capture();
    const loop: any = { a: 1 }; loop.self = loop;
    log.error("x", { err: new Error("boom"), big: "z".repeat(2000), loop });
    const l = lines[0];
    expect(l.err.stack.split("\n").length).toBeLessThanOrEqual(6);
    expect(l.big.length).toBeLessThan(510);
    expect(l.loop.self).toBe("[circular]");
  });

  it("stamps the request context on every line and lets it grow", async () => {
    const { log, lines } = capture();
    await withLogContext({ requestId: "req-1" }, async () => {
      log.info("before");
      await Promise.resolve();
      addLogContext({ tenantId: "t1", userId: "u1" });
      log.info("after");
    });
    log.info("outside");
    expect(lines[0]).toMatchObject({ requestId: "req-1" });
    expect(lines[1]).toMatchObject({ requestId: "req-1", tenantId: "t1", userId: "u1" });
    expect(lines[2].requestId).toBeUndefined();
  });

  it("a caller field cannot overwrite the line's own level, time or request id", () => {
    const { log, lines } = capture();
    withLogContext({ requestId: "real" }, () => log.info("x", { level: "fatal", requestId: "fake", time: "never" }));
    expect(lines[0]).toMatchObject({ level: "info", requestId: "real", time: "2026-11-16T10:00:00.000Z" });
  });

  it("never throws when the sink does", () => {
    const log = createLogger({ level: "info", sink: () => { throw new Error("disk full"); } });
    expect(() => log.error("x")).not.toThrow();
  });
});
