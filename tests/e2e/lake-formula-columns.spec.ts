/**
 * E2E spec — formula columns on a lake table, and the spreadsheet view.
 *
 * The journey the feature exists for: an editor opens a table, adds a column
 * worked out from the others (typed, or written by the model from a
 * description), sees it checked as they type, saves it, and opens the whole
 * table as a spreadsheet to sort, find and scroll through it. Plus the
 * invariants that make it safe to hand to a workspace: a formula over a
 * masked column is masked too, nobody can sort by what they can't see, and a
 * viewer gets none of it.
 *
 * Strategy: its own workspace, its own table, its own people — created
 * through the API so the run is repeatable — with a real browser for
 * everything a person would do, and API calls for the refusals the UI never
 * offers a way to attempt.
 *
 * "Curf writes the formula" needs a model configured for the workspace
 * (CURF_LLM / CURF_LLM_PROVIDER); that one test skips, never fails, without
 * one. Everything else runs anywhere the suite runs.
 */
import { test, expect, type Page } from "@playwright/test";
import { signIn, SEED_ADMIN } from "./helpers";

const STAMP = Date.now();
const PASSWORD = "e2e-formula-pass-123";
const EDITOR = `e2e.formula.editor+${STAMP}@example.test`;
const VIEWER = `e2e.formula.viewer+${STAMP}@example.test`;
const TABLE = `orders_e2e_${STAMP}`;

/** Two pages of rows for the sheet (it asks for 200 at a time), one column tagged pii. */
const ROWS = Array.from({ length: 450 }, (_, i) => ({
  order_id: `ORD-${100001 + i}`,
  order_date: new Date(Date.UTC(2025, 0, 1) + i * 3600e3 * 7).toISOString().slice(0, 10),
  store: ["Lakeshore", "Old Town", "Westway", "Online"][i % 4]!,
  customer_email: `person${i + 1}@example.com`,
  qty: String(1 + (i * 7) % 6),
  revenue: String(((i * 37) % 900) + 100),
  margin_pct: String(((i * 13) % 50) / 100),
}));

const DIALOG = '[role="dialog"][data-state="open"]';
// The spreadsheet is a full-screen overlay over the table page, which keeps
// its own Add column button in the DOM behind it — scope to the overlay.
const SHEET = '[role="dialog"][aria-modal="true"]:not([data-state])';
const GRID = '[role="grid"]';
const FIRST_DATA_ROW = '[role="grid"] [role="row"][aria-rowindex="2"]';

/** The table page, and its spreadsheet. */
const tableUrl = `/tables/${TABLE}`;

/**
 * Sign in through the credentials provider, without assuming where the person
 * lands: signIn() in helpers waits for /brief, and a viewer is sent to the
 * Executive view instead (usesExecutiveView() in src/lib/roles.ts), so that
 * helper can't carry every role this spec needs.
 *
 * Through page.request, which shares the browser context's cookies, so the
 * browser is signed in afterwards. Not from inside a loaded page: next-auth's
 * client fetches its own CSRF token on mount, and that rotates the cookie out
 * from under a token fetched alongside it ("signin?csrf=true").
 */
async function asMember(page: Page, email: string) {
  await page.context().clearCookies();
  const { csrfToken } = await page.request.get("/api/auth/csrf").then((r) => r.json());
  const res = await page.request.post("/api/auth/callback/credentials", {
    form: { csrfToken, email, password: PASSWORD, json: "true" },
    maxRedirects: 0,
  });
  // next-auth answers 200 either way; the URL it hands back is what says
  // whether the credentials took.
  expect(await res.text(), `${email} should be able to sign in`).not.toContain("error");
  await expect.poll(
    async () => page.request.get("/api/auth/session").then((r) => r.json()).then((s) => s?.user?.email ?? null),
    { timeout: 30_000 },
  ).toBe(email);
}

/** The cells of a named column, top rows first — the sheet draws only a window. */
async function columnCells(page: Page, column: string, count = 3): Promise<Array<string | undefined>> {
  return page.evaluate(({ name, n }) => {
    const head = [...document.querySelectorAll('[role="columnheader"]')]
      .find((x) => x.querySelector(".truncate")?.textContent === name);
    if (!head) return [];
    const idx = head.getAttribute("aria-colindex");
    return [...document.querySelectorAll('[role="row"]')].slice(1, 1 + n)
      .map((r) => r.querySelector(`[aria-colindex="${idx}"]`)?.textContent ?? undefined);
  }, { name: column, n: count });
}

/** Wait for the sheet to have rows on screen. */
async function openSheet(page: Page) {
  await page.goto(`${tableUrl}?view=sheet`);
  await page.locator(FIRST_DATA_ROW).first().waitFor({ timeout: 45_000 });
}

test.describe("Lake formula columns + the spreadsheet view", () => {
  // Longer than the suite default: each test walks a real journey against a
  // dev server that compiles routes on first hit, and the fixture uploads a
  // table before anything else can run.
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  test("a table with a masked column, two formula columns, and people to look at them", async ({ page }) => {
    // The seeded admin's workspace, as the rest of the suite uses it — this
    // spec adds only its own uniquely-named table and its own two members.
    await signIn(page, SEED_ADMIN.email, SEED_ADMIN.password);

    for (const [email, role] of [[EDITOR, "developer"], [VIEWER, "viewer"]] as const) {
      const invite = await page.request.post("/api/admin/users", { data: { email, role, name: `E2E ${role}` } });
      expect(invite.ok(), await invite.text()).toBeTruthy();
      const j = await invite.json();
      expect(j.role).toBe(role);
      // Dev servers hand the accept link back when SMTP is unset; with mail
      // configured the token is only emailed, and these people can't be given
      // a password here — skip rather than fail.
      test.skip(!j.acceptUrl, "SMTP is configured, so the invite token isn't returned");
      const token = new URL(j.acceptUrl, "http://localhost").pathname.split("/").pop()!;
      const set = await page.request.post("/api/reset", { data: { token, password: PASSWORD } });
      expect(set.ok(), await set.text()).toBeTruthy();
    }

    const made = await page.request.post("/api/lake/tables", { data: { name: TABLE, rows: ROWS } });
    expect(made.ok(), await made.text()).toBeTruthy();

    // customer_email holds addresses, so it's tagged — this is what the
    // masking assertions below hang on.
    const tagged = await page.request.post(`/api/lake/tables/${TABLE}/sensitivity`, {
      data: { column: "customer_email", sensitivity: "pii", unredactedForRoles: [] },
    });
    expect(tagged.ok(), await tagged.text()).toBeTruthy();

    // One formula over plain columns, one over the masked one.
    for (const [name, formula] of [["profit", "revenue * margin_pct"], ["email_domain", "RIGHT(customer_email, 11)"]] as const) {
      const r = await page.request.post(`/api/lake/tables/${TABLE}/schema`, { data: { action: "addFormula", name, formula } });
      expect(r.ok(), await r.text()).toBeTruthy();
      expect((await r.json()).schema.find((c: any) => c.name === name).formula).toBe(formula);
    }

    // Warm the routes the journeys below wait on. A Next dev server compiles
    // each route on its first request, and that compile would otherwise land
    // inside someone's wait for the formula preview — seconds of compiling,
    // not of work (measured: ~4s cold, ~0.7s after).
    await page.request.post(`/api/lake/tables/${TABLE}/formula`, { data: { action: "preview", formula: "revenue * 2" } });
    await page.request.get(`/api/lake/tables/${TABLE}/rows?limit=5`);
  });

  test("an editor adds a formula column, checked as they type", async ({ page }) => {
    await asMember(page, EDITOR);
    await page.goto(tableUrl);

    // Each formula column shows its own formula under it.
    await expect(page.getByText("= revenue * margin_pct").first()).toBeVisible();

    await page.getByRole("button", { name: "Add column", exact: true }).first().click();
    const dialog = page.locator(DIALOG);
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder("gross_profit").fill("net_profit");

    // A missing bracket is caught in the browser, before any request.
    await dialog.getByPlaceholder("revenue * margin_pct").fill("revenue * (margin_pct - 0.1");
    await expect(dialog.getByText(/Missing a closing \)/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Add column", exact: true })).toBeDisabled();

    // A good one checks out, and the server tries it on the table's own rows.
    await dialog.getByPlaceholder("revenue * margin_pct").fill("ROUND(revenue * (margin_pct - 0.1), 2)");
    await expect(dialog.getByText(/Checks out — gives number/)).toBeVisible();
    // Generous: the preview itself takes under a second, but on a dev server
    // this is often the first request to that route and waits on its compile.
    await expect(dialog.getByText(/Tried on [\d,]+ rows|Leaves [\d,]+ of/)).toBeVisible({ timeout: 90_000 });

    await dialog.getByRole("button", { name: "Add column", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    // The page picks the new column up on its own — no reload.
    await expect(page.getByText("= ROUND(revenue * (margin_pct - 0.1), 2)").first()).toBeVisible({ timeout: 30_000 });
  });

  test("the same mistake reads in the reader's own language", async ({ page }) => {
    await asMember(page, EDITOR);
    // Reading in Thai is the person's own choice, kept in rd_locale — set it
    // on the origin the page is already on, then come back to the table.
    await page.goto(tableUrl);
    await page.context().addCookies([{ name: "rd_locale", value: "th", url: page.url() }]);
    await page.reload();

    await page.getByRole("button", { name: "เพิ่มคอลัมน์", exact: true }).first().click();
    const dialog = page.locator(DIALOG);
    await dialog.getByPlaceholder("revenue * margin_pct").fill("reveune * 2");
    // Thai, naming both the column that doesn't exist and the one it meant.
    await expect(dialog.getByText(/ไม่มีคอลัมน์ชื่อ reveune.*revenue/)).toBeVisible();
  });

  test("the spreadsheet opens, pages as you scroll, and sorts by a formula column", async ({ page }) => {
    await asMember(page, EDITOR);
    await page.goto(tableUrl);
    await page.getByRole("link", { name: /Open as spreadsheet/ }).first().click();
    await page.locator(FIRST_DATA_ROW).first().waitFor({ timeout: 45_000 });
    expect(page.url()).toContain("view=sheet");

    // A window of rows, not all 450 — that's what makes a million-row table work.
    const drawn = await page.locator(`${GRID} [role="row"]`).count();
    expect(drawn).toBeGreaterThan(1);
    expect(drawn).toBeLessThan(200);
    await expect(page.getByText(/200 of 450 rows loaded/)).toBeVisible();

    // Scrolling towards the end of what's loaded fetches the next page — one
    // page per approach, so keep scrolling until the whole table is in.
    const loaded = page.getByText(/of 450 rows loaded/);
    await expect.poll(async () => {
      await page.locator(GRID).evaluate((g) => { g.scrollTop = g.scrollHeight; });
      return (await loaded.textContent().catch(() => "")) ?? "";
    }, { timeout: 90_000, intervals: [1_000] }).toContain("450 of 450");
    await page.locator(GRID).evaluate((g) => { g.scrollTop = 0; });

    // Sorting is the server's, over the whole table, including formula
    // columns. The header marks itself sorted as soon as it's clicked, so
    // wait on the rows themselves rather than on aria-sort.
    const profit = page.locator('[role="columnheader"]').filter({ hasText: "profit" }).first();
    const orderOfProfit = async (want: "ascending" | "descending") => {
      const v = (await columnCells(page, "profit", 4)).map(Number);
      const ok = v.length > 1 && v.every((x, i) => i === 0 || (want === "ascending" ? v[i - 1]! <= x : v[i - 1]! >= x));
      return ok ? want : `not ${want}: ${v.join(", ")}`;
    };

    await profit.getByRole("button").first().click();
    await expect(profit).toHaveAttribute("aria-sort", "ascending", { timeout: 30_000 });
    await expect.poll(() => orderOfProfit("ascending"), { timeout: 30_000 }).toBe("ascending");

    await profit.getByRole("button").first().click();
    await expect(profit).toHaveAttribute("aria-sort", "descending", { timeout: 30_000 });
    await expect.poll(() => orderOfProfit("descending"), { timeout: 30_000 }).toBe("descending");

    // Find runs over the table, not over the rows on screen.
    await page.getByRole("searchbox").fill("Westway");
    await expect(page.getByText(/matching rows/)).toBeVisible({ timeout: 30_000 });
    await expect.poll(
      async () => [...new Set(await columnCells(page, "store", 5))].join(","),
      { timeout: 30_000 },
    ).toBe("Westway");
  });

  test("a column can be resized, and the width is still there next time", async ({ page }) => {
    await asMember(page, EDITOR);
    await openSheet(page);

    const third = page.locator('[role="columnheader"]').nth(2);
    const grip = third.locator("span[aria-hidden]").first();
    const box = await grip.boundingBox();
    expect(box).not.toBeNull();
    const before = (await third.boundingBox())!.width;
    await page.mouse.move(box!.x + 3, box!.y + 10);
    await page.mouse.down();
    await page.mouse.move(box!.x + 83, box!.y + 10, { steps: 5 });
    await page.mouse.up();
    const after = (await third.boundingBox())!.width;
    expect(after).toBeGreaterThan(before + 40);

    await openSheet(page);
    expect(Math.abs((await page.locator('[role="columnheader"]').nth(2).boundingBox())!.width - after)).toBeLessThan(6);
  });

  test("a masked column is locked, and a formula over it is masked too", async ({ page }) => {
    await asMember(page, EDITOR);
    await openSheet(page);

    // The addresses are masked, and can't be sorted or searched by.
    const email = page.locator('[role="columnheader"]').filter({ hasText: "customer_email" }).first();
    await expect(email.getByRole("button").first()).toBeDisabled();
    for (const cells of [await columnCells(page, "customer_email"), await columnCells(page, "email_domain")]) {
      expect(cells.join(" "), "no address reaches an editor's screen").not.toContain("@example.com");
    }

    // Nor through the API, sorted or otherwise — and not in the samples either.
    const refused = await page.request.get(`/api/lake/tables/${TABLE}/rows?limit=5&sort=customer_email`);
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error).toMatch(/masked/i);

    const table = await page.request.get(`/api/lake/tables/${TABLE}`).then((r) => r.json());
    const column = (n: string) => table.schema.find((c: any) => c.name === n);
    expect(String(column("customer_email").sample ?? "")).not.toContain("@");
    expect(column("email_domain").sensitivity, "a formula carries the tags of what it reads").toBe("pii");
    expect(JSON.stringify(table.preview[0])).not.toContain("@example.com");
  });

  test("an admin, who may see the addresses, does", async ({ page }) => {
    await signIn(page, SEED_ADMIN.email, SEED_ADMIN.password);
    const table = await page.request.get(`/api/lake/tables/${TABLE}`).then((r) => r.json());
    expect(JSON.stringify(table.preview[0])).toContain("@example.com");
  });

  test("a formula can be edited and removed, and a blank column added", async ({ page }) => {
    await asMember(page, EDITOR);
    await openSheet(page);
    const dialog = page.locator(DIALOG);

    // A blank column with a value for the rows already there.
    // The sheet offers it twice — the toolbar, and the + at the end of the
    // header row. The toolbar one is first.
    await page.locator(SHEET).getByRole("button", { name: "Add column", exact: true }).first().click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Blank", exact: true }).click();
    await dialog.getByPlaceholder("promo_code").fill("target");
    await dialog.getByPlaceholder("Leave empty").fill("1500");
    await dialog.getByRole("button", { name: "number", exact: true }).click();
    await dialog.getByRole("button", { name: "Add column", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await page.locator(GRID).evaluate((g) => { g.scrollLeft = g.scrollWidth; });
    await expect(page.locator('[role="columnheader"]').filter({ hasText: "target" }).first()).toBeVisible({ timeout: 30_000 });
    expect((await columnCells(page, "target", 1)).join("")).toMatch(/1,?500/);

    // Changing profit's formula works every row out again.
    const before = await columnCells(page, "profit");
    await page.locator('button[aria-label="Edit formula · profit"]').click();
    await expect(dialog.getByRole("heading", { name: "Edit profit" })).toBeVisible();
    await dialog.getByPlaceholder("revenue * margin_pct").fill("revenue * margin_pct * 2");
    await expect(dialog.getByText(/Checks out — gives number/)).toBeVisible();
    await dialog.getByRole("button", { name: "Save formula", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect
      .poll(async () => (await columnCells(page, "profit")).join(","), { timeout: 30_000 })
      .not.toBe(before.join(","));

    // And it can go away again.
    await page.locator('button[aria-label="Edit formula · email_domain"]').click();
    await dialog.getByRole("button", { name: "Remove column", exact: true }).click();
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page.locator('[role="columnheader"]').filter({ hasText: "email_domain" })).toHaveCount(0, { timeout: 30_000 });
  });

  test("Curf writes the formula from a description", async ({ page }) => {
    test.setTimeout(300_000); // a model round-trip, retried once if what it writes does not compile
    await asMember(page, EDITOR);
    // No model configured for this workspace — nothing to test, so skip
    // rather than fail (the same call the dialog's button makes).
    const probe = await page.request.post(`/api/lake/tables/${TABLE}/formula`, {
      data: { action: "suggest", description: "revenue plus a 7% sales tax" },
    }).then((r) => r.json());
    test.skip(probe?.ok === false && probe?.code === "failed", `no model for the workspace: ${probe?.error}`);

    await openSheet(page);
    // The sheet offers it twice — the toolbar, and the + at the end of the
    // header row. The toolbar one is first.
    await page.locator(SHEET).getByRole("button", { name: "Add column", exact: true }).first().click();
    const dialog = page.locator(DIALOG);
    await dialog.getByPlaceholder(/profit on each order/).fill("revenue after a 7% sales tax is added");
    await dialog.getByRole("button", { name: "Write formula", exact: true }).click();

    // Whatever it writes goes through the same check as a typed formula.
    await expect(dialog.getByText(/Checks out — gives number/)).toBeVisible({ timeout: 120_000 });
    const written = await dialog.getByPlaceholder("revenue * margin_pct").inputValue();
    expect(written).toMatch(/revenue/);
    const named = await dialog.getByPlaceholder("gross_profit").inputValue();
    expect(named).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);

    await dialog.getByRole("button", { name: "Add column", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await page.locator(GRID).evaluate((g) => { g.scrollLeft = g.scrollWidth; });
    await expect(page.locator('[role="columnheader"]').filter({ hasText: named }).first()).toBeVisible({ timeout: 30_000 });
  });

  test("the API refuses what the dialog gives no way to ask for", async ({ page }) => {
    await asMember(page, EDITOR);
    const post = (data: unknown) => page.request.post(`/api/lake/tables/${TABLE}/schema`, { data });

    // A misspelt column: a 400 that says which column, where in the formula,
    // and carries the key the browser shows it in the reader's language with.
    const typo = await post({ action: "addFormula", name: "oops", formula: "revnue * 2" });
    expect(typo.status()).toBe(400);
    const body = await typo.json();
    expect(body.error).toMatch(/no column called revnue/i);
    expect(typeof body.at).toBe("number");
    expect(body.key).toBeTruthy();

    // A column another formula is worked out from can't just be dropped.
    expect((await post({ action: "addFormula", name: "e2e_base", formula: "revenue * 2" })).ok()).toBeTruthy();
    expect((await post({ action: "addFormula", name: "e2e_dependent", formula: "e2e_base + 1" })).ok()).toBeTruthy();
    const blocked = await post({ action: "dropColumn", name: "e2e_base" });
    expect(blocked.status()).toBe(400);
    expect((await blocked.json()).error).toMatch(/e2e_dependent/);
    // In the right order, both go.
    expect((await post({ action: "dropColumn", name: "e2e_dependent" })).ok()).toBeTruthy();
    expect((await post({ action: "dropColumn", name: "e2e_base" })).ok()).toBeTruthy();

    // Names the lake can't hold.
    expect((await post({ action: "addFormula", name: "x".repeat(70), formula: "1" })).status()).toBe(400);
  });

  test("a viewer gets none of it", async ({ page }) => {
    await asMember(page, VIEWER);

    // Viewers live in the Executive view, not the Console — middleware sends
    // them there (usesExecutiveView() in src/lib/roles.ts). The Community
    // edition has no Executive view, so only assert the routing where it exists.
    const hasExecutiveView = (await page.request.get("/executive")).status() !== 404;
    await page.goto(tableUrl);
    if (hasExecutiveView) expect(page.url()).toContain("/executive");
    await expect(page.getByRole("button", { name: "Add column", exact: true })).toHaveCount(0);

    await page.goto(`${tableUrl}?view=sheet`);
    if (hasExecutiveView) {
      expect(page.url()).toContain("/executive");
      await expect(page.locator(GRID)).toHaveCount(0);
    }

    // And the API refuses a viewer outright, wherever they ask from.
    const tried = await page.request.post(`/api/lake/tables/${TABLE}/schema`, {
      data: { action: "addFormula", name: "sneaky", formula: "revenue * 2" },
    });
    expect(tried.status()).toBe(403);
    // Reading it is fine — masked, like it is for an editor.
    const read = await page.request.get(`/api/lake/tables/${TABLE}`);
    expect(read.ok()).toBeTruthy();
    expect(JSON.stringify((await read.json()).preview?.[0] ?? {})).not.toContain("@example.com");
  });
});
