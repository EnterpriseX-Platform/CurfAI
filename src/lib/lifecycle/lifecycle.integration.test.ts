/**
 * The customer lifecycle end to end against a real Postgres, through the app's own client as the non-superuser curf_app role
 * (row-level security on): schedule a deletion, cancel it, schedule again, purge it (rows, files, certificate), the audit
 * trail's own retention, and erasing a person.
 *
 * Skipped unless RLS_TEST_DATABASE_URL points at such a database — see db.rls.integration.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const URL = process.env.RLS_TEST_DATABASE_URL;
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;

describe.skipIf(!URL)("customer lifecycle against Postgres", () => {
  let prisma: typeof import("@/lib/db").prisma;
  let sys: typeof import("@/lib/dbContext").withSystemDbContext;
  let deletion: typeof import("./deletion");
  let purge: typeof import("./purge");
  let person: typeof import("./person");
  let files: typeof import("./files");
  let guard: typeof import("@/lib/tenantGuard");
  const run = `lc${Date.now().toString(36)}`;
  const T = `${run}-tenant`;     // the workspace that is deleted
  const S = `${run}-sole`;       // a workspace whose only member is erased
  const lakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "curf-lifecycle-it-"));
  const ids = { admin: `${run}-admin`, member: `${run}-member`, solo: `${run}-solo` };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.CURF_LAKE_DIR = lakeDir;
    process.env.CURF_DELETION_GRACE_DAYS = "0";
    ({ prisma } = await import("@/lib/db"));
    ({ withSystemDbContext: sys } = await import("@/lib/dbContext"));
    deletion = await import("./deletion");
    purge = await import("./purge");
    person = await import("./person");
    files = await import("./files");
    guard = await import("@/lib/tenantGuard");

    await sys(async () => {
      for (const [k, id] of Object.entries(ids)) await prisma.user.create({ data: { id, email: `${id}@lc.test`, name: k } });
      for (const id of [T, S]) await prisma.tenant.create({ data: { id, slug: id, name: id } });
      await prisma.membership.createMany({ data: [
        { tenantId: T, userId: ids.admin, role: "admin" }, { tenantId: T, userId: ids.member, role: "viewer" },
        { tenantId: S, userId: ids.solo, role: "admin" },
      ] });
      await prisma.report.create({ data: { tenantId: T, name: "Quarterly", definition: "{}", createdById: ids.admin } });
      await prisma.auditEvent.create({ data: { tenantId: T, userId: ids.member, userEmail: `${ids.member}@lc.test`, kind: "report.view", target: "x", ip: "203.0.113.9" } });
    });
    // Something on disk for it.
    for (const t of (await files.workspaceFileTargets(T)).filter((x) => x.kind === "dir").slice(0, 3)) {
      fs.mkdirSync(t.path, { recursive: true });
      fs.writeFileSync(path.join(t.path, "data.bin"), "customer data");
    }
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    await sys(async () => {
      await prisma.workspaceExport.deleteMany({ where: { tenantId: { in: [T, S] } } });
      await prisma.workspaceDeletion.deleteMany({ where: { targetTenantId: { in: [T, S] } } });
      await prisma.dataSubjectRequest.deleteMany({ where: { subjectEmail: { contains: run } } });
      await prisma.membership.deleteMany({ where: { tenantId: { in: [T, S] } } });
      await prisma.report.deleteMany({ where: { tenantId: { in: [T, S] } } });
      await prisma.tenant.deleteMany({ where: { id: { in: [T, S] } } });
      await prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
    });
    await prisma.$disconnect();
    fs.rmSync(lakeDir, { recursive: true, force: true });
  });

  const status = (id: string) => sys(() => prisma.tenant.findUnique({ where: { id }, select: { status: true } })).then((t) => t?.status ?? null);

  it("scheduling closes the workspace, starts an export and records the request; cancelling restores it", async () => {
    const r = await deletion.scheduleDeletion(T, { email: `${ids.admin}@lc.test`, id: ids.admin }, { via: "admin", reason: "test" });
    expect(await status(T)).toBe("pending_deletion");
    expect(await guard.tenantIsOpen(T)).toBe(false);
    expect(r.exportId).toBeTruthy();
    // A second request is refused, and the audit row for the first was written.
    await expect(deletion.scheduleDeletion(T, { email: "x@lc.test" }, { via: "admin" })).rejects.toThrow(/already scheduled/);
    const audit = await sys(() => prisma.auditEvent.count({ where: { tenantId: T, kind: "tenant.delete.schedule" } }));
    expect(audit).toBe(1);

    // The export is built in the background; wait for it.
    let exp: Awaited<ReturnType<typeof prisma.workspaceExport.findUnique>> = null;
    for (let i = 0; i < 50; i++) {
      exp = await sys(() => prisma.workspaceExport.findUnique({ where: { id: r.exportId! } }));
      if (exp && exp.status !== "queued" && exp.status !== "running") break;
      await new Promise((res) => setTimeout(res, 200));
    }
    expect(exp?.status, exp?.error ?? "").toBe("ready");
    expect(fs.existsSync(exp!.filePath!)).toBe(true);
    const zip = fs.readFileSync(exp!.filePath!);
    expect(zip.subarray(0, 2).toString()).toBe("PK");
    const text = zip.toString("latin1");
    for (const name of ["manifest.json", "workspace.json", "members.csv", "audit-log.csv", "README.txt"]) expect(text).toContain(name);
    expect(text).toContain("reports/quarterly-");

    const c = await deletion.cancelDeletion(T, { email: `${ids.admin}@lc.test`, id: ids.admin });
    expect(c.restoredTo).toBe("active");
    expect(await status(T)).toBe("active");
    expect(await guard.tenantIsOpen(T)).toBe(true);
    const rec = await sys(() => prisma.workspaceDeletion.findUnique({ where: { targetTenantId: T } }));
    expect(rec?.status).toBe("cancelled");
  });

  it("a suspended workspace goes back to suspended, not active, when its deletion is cancelled", async () => {
    await sys(() => prisma.tenant.update({ where: { id: T }, data: { status: "suspended" } }));
    await deletion.scheduleDeletion(T, { email: "op@lc.test" }, { via: "operator", reason: "test" });
    expect((await deletion.cancelDeletion(T, { email: "op@lc.test" })).restoredTo).toBe("suspended");
    await sys(() => prisma.tenant.update({ where: { id: T }, data: { status: "active" } }));
  });

  it("purge refuses an open workspace, then removes rows, files and the tenant, and writes a certificate", async () => {
    await expect(purge.purgeWorkspace(T)).rejects.toThrow(/not scheduled/);
    await deletion.scheduleDeletion(T, { email: `${ids.admin}@lc.test`, id: ids.admin }, { via: "admin" });
    // Let the export finish before the purge removes its directory.
    for (let i = 0; i < 50; i++) {
      const n = await sys(() => prisma.workspaceExport.count({ where: { tenantId: T, status: { in: ["queued", "running"] } } }));
      if (n === 0) break;
      await new Promise((res) => setTimeout(res, 200));
    }
    expect((await files.workspaceFilesRemaining(T)).length).toBeGreaterThan(0);

    const dry = await purge.purgeWorkspace(T, { dryRun: true });
    expect(dry.ok).toBe(true);
    expect(await status(T)).toBe("pending_deletion"); // a dry run changes nothing

    const rep = await purge.purgeWorkspace(T);
    expect(rep.ok, JSON.stringify(rep.steps)).toBe(true);
    expect(await status(T)).toBeNull();
    expect(await sys(() => prisma.report.count({ where: { tenantId: T } }))).toBe(0);
    expect(await sys(() => prisma.membership.count({ where: { tenantId: T } }))).toBe(0);
    expect(await files.workspaceFilesRemaining(T)).toEqual([]);

    const rec = await sys(() => prisma.workspaceDeletion.findUnique({ where: { targetTenantId: T } }));
    expect(rec?.status).toBe("purged");
    expect(rec?.stepsJson).toContain("files");
    // The audit trail outlives the workspace...
    expect(await sys(() => prisma.auditEvent.count({ where: { tenantId: T } }))).toBeGreaterThan(0);
    // ...until its own retention ends.
    const later = new Date(Date.now() + 400 * 86_400_000);
    await purge.purgeAuditAfterRetention(later);
    expect(await sys(() => prisma.auditEvent.count({ where: { tenantId: T } }))).toBe(0);
  });

  it("erasing a person anonymises the account, scrubs their audit rows and schedules a workspace they alone belonged to", async () => {
    // Before: the only admin of a workspace with others can't be erased (T is gone, so use a fresh pair).
    const r = await person.erasePerson(ids.solo, { email: `${ids.solo}@lc.test`, id: ids.solo });
    expect(r.anonymized).toBe(true);
    expect(r.workspacesScheduledForDeletion).toEqual([S]);
    expect(await status(S)).toBe("pending_deletion");
    const u = await sys(() => prisma.user.findUnique({ where: { id: ids.solo } }));
    expect(u?.email).toBe(person.erasedEmail(ids.solo));
    expect(u?.name).toBeNull();
    expect(await sys(() => prisma.membership.count({ where: { userId: ids.solo } }))).toBe(0);
    // Their audit rows keep the event, not the person.
    const rows = await sys(() => prisma.auditEvent.findMany({ where: { userId: ids.solo }, select: { userEmail: true, ip: true } }));
    for (const row of rows) expect(row.userEmail ?? "").not.toContain("@lc.test");
  });

  it("a sole admin with other members is refused until someone else is admin", async () => {
    const R = `${run}-shared`;
    await sys(async () => {
      // The purge above removed these two accounts (they belonged to nothing else), which is its own check.
      expect(await prisma.user.count({ where: { id: { in: [ids.admin, ids.member] } } })).toBe(0);
      for (const id of [ids.admin, ids.member]) await prisma.user.create({ data: { id, email: `${id}@lc.test` } });
      await prisma.tenant.create({ data: { id: R, slug: R, name: R } });
      await prisma.membership.createMany({ data: [{ tenantId: R, userId: ids.admin, role: "admin" }, { tenantId: R, userId: ids.member, role: "viewer" }] });
    });
    try {
      await expect(person.erasePerson(ids.admin, { email: `${ids.admin}@lc.test`, id: ids.admin })).rejects.toThrow(/only admin|can't erase/i);
      const b = await person.erasureBlockers(ids.admin);
      expect(b.map((x) => x.tenantId)).toEqual([R]);
    } finally {
      await sys(async () => {
        await prisma.membership.deleteMany({ where: { tenantId: R } });
        await prisma.tenant.delete({ where: { id: R } });
      });
    }
  });

  it("exports a person's own data", async () => {
    await sys(() => prisma.user.findUnique({ where: { id: ids.member } })); // recreated by the previous test
    const d: any = await person.exportPersonalData(ids.member);
    expect(JSON.stringify(d)).toContain(`${ids.member}@lc.test`);
  });
});
