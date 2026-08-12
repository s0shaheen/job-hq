import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import { collectPaintedOverflow, describeOffenders } from "./painted-overflow";
import { FIXTURE_APPLICATIONS, FIXTURE_JOBS } from "@/lib/data/fixtures";
import { JOB_COLUMNS } from "@/lib/export/columns";
import { toCsv, toTsv } from "@/lib/export/delimited";

/**
 * G4: selection, ⌘C, export scope, bulk triage (plan §5; matrix rows 33/34 and
 * the H22 criterion). The trust rule these tests exist to hold: the rows a
 * copy or an export emits are EXACTLY the selected rows still on screen, and a
 * bulk decision is one transaction with one undo — never a half-applied batch.
 */

const FIXTURE_NOW = new Date("2026-07-21T15:00:00.000Z");

const TOTAL = FIXTURE_JOBS.length;

/** The queue predicate, derived inline — never by importing the code under test. */
const QUEUE_ROWS = FIXTURE_JOBS.filter(
  (j) =>
    j.disposition === "qualified" &&
    j.triage === "" &&
    (j.status ?? "").trim().toLowerCase() !== "closed",
);
const QUEUED = QUEUE_ROWS.length;

/** The grid's display order: byFreshness, as jobs() serves it. */
const byFreshness = (a: (typeof FIXTURE_JOBS)[number], b: (typeof FIXTURE_JOBS)[number]) =>
  (b.firstSeen ?? "").localeCompare(a.firstSeen ?? "") ||
  (a.key < b.key ? 1 : a.key > b.key ? -1 : 0);
const QUEUE_SORTED = [...QUEUE_ROWS].sort(byFreshness);

/**
 * Bulk-interested creates a Queued application per row — but only for rows
 * that do not already carry one (Ramp and Plaid do, and the no-duplicate guard
 * is correct). Tests that count created applications pick clean keys, same as
 * tests/unit/bulk-triage-fixture.test.ts.
 */
const HAS_APP = new Set(FIXTURE_APPLICATIONS.map((a) => a.postingKey).filter(Boolean));
const CLEAN = QUEUE_SORTED.filter((j) => !HAS_APP.has(j.key));

/** Jobs keeps the existing full export contract even though the screen is
 * deliberately trimmed to six data columns. */
const QUEUE_EXPORT_COLS = JOB_COLUMNS;

const ORIGIN = "http://127.0.0.1:3210";

/** The interested working set's fixture baseline, derived inline like QUEUED. */
const INTERESTED = FIXTURE_JOBS.filter((j) => j.triage === "interested").length;
const interestedCount = (n: number) => `${n} ${n === 1 ? "role" : "roles"}`;

test.beforeEach(async ({ page, context }) => {
  await page.clock.setFixedTime(FIXTURE_NOW);
  // Fresh store per test: bulk triage mutates it, and sharing would make these
  // counts depend on scheduling order.
  await context.addCookies([
    {
      name: "hq_demo_id",
      value: `gs-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      url: ORIGIN,
    },
  ]);
});

async function gotoJobs(page: Page, path = "/jobs") {
  await page.goto(path);
  await expect(page.locator('[data-testid="jobs-grid"][data-ready="true"]')).toBeAttached();
}

function companyCell(page: Page, company: string) {
  return companyRow(page, company).locator('[role="gridcell"][data-col="company"]');
}

function companyRow(page: Page, company: string) {
  return page.locator('[role="row"][data-key]').filter({
    has: page.locator(`[role="gridcell"][data-col="company"] span[title="${company}"]`),
  });
}

async function selectCompany(
  page: Page,
  company: string,
  options?: { modifiers?: ("Shift" | "ControlOrMeta")[] },
) {
  await companyRow(page, company).getByRole("checkbox", { name: /^Select / }).click(options);
}

function selectedKeys(page: Page) {
  return page.locator('[role="row"][aria-selected="true"]').evaluateAll((rows) =>
    rows.map((r) => (r as HTMLElement).dataset.key ?? ""),
  );
}

const bar = (page: Page) => page.getByTestId("selection-bar");

// ---------------------------------------------------------------------------
// Selection semantics
// ---------------------------------------------------------------------------

test("checkboxes build a selection, and Clear empties it", async ({ page }) => {
  await gotoJobs(page);
  await expect(bar(page)).toHaveCount(0); // no selection, no bar

  await selectCompany(page, "Ramp");
  await expect(bar(page)).toContainText("1 selected");
  expect(await selectedKeys(page)).toEqual([QUEUE_SORTED[0].key]);

  await selectCompany(page, "Chime");
  await expect(bar(page)).toContainText("2 selected");

  await bar(page).getByRole("button", { name: "Clear selection" }).click();
  await expect(bar(page)).toHaveCount(0);
  await expect(page.locator('[role="row"][aria-selected="true"]')).toHaveCount(0);
});

test("checkboxes toggle; Escape clears; the grid does not shift when the bar appears", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "modifier-key affordance");
  await gotoJobs(page);

  const firstRowTop = () =>
    page
      .locator('[role="row"][aria-rowindex="2"]')
      .evaluate((el) => Math.round(el.getBoundingClientRect().top));
  const before = await firstRowTop();

  await selectCompany(page, "Ramp");
  await selectCompany(page, "Chime");
  await expect(bar(page)).toContainText("2 selected");

  // The bar overlays the grid; it must not push rows around when it appears.
  expect(await firstRowTop()).toBe(before);

  await selectCompany(page, "Ramp");
  await expect(bar(page)).toContainText("1 selected");

  await page.keyboard.press("Escape");
  await expect(bar(page)).toHaveCount(0);
});

test("shift-click ranges from the anchor across sort and group boundaries — headers never selected (row 34)", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "modifier-key affordance");
  // Sorted comp desc, grouped by company: the display interleaves a header
  // before every row, so a range across four rows crosses four headers.
  await gotoJobs(page, "/jobs?sort=comp.desc&group=company");

  // Expected leaf order: stated comp desc, unknowns last in byFreshness order.
  const stated = QUEUE_SORTED.filter((j) => j.compMaxK !== null).sort(
    (a, b) => b.compMaxK! - a.compMaxK!,
  );
  const unknown = QUEUE_SORTED.filter((j) => j.compMaxK === null);
  const leaves = [...stated, ...unknown];

  await selectCompany(page, leaves[1].company);
  await selectCompany(page, leaves[4].company, { modifiers: ["Shift"] });

  await expect(bar(page)).toContainText("4 selected");
  expect((await selectedKeys(page)).sort()).toEqual(
    leaves.slice(1, 5).map((j) => j.key).sort(),
  );
  // Group headers exist on screen and none of them is selected.
  await expect(page.getByTestId("group-header")).toHaveCount(QUEUED);
  await expect(page.locator('[data-testid="group-header"][aria-selected="true"]')).toHaveCount(0);

  // Re-pinning the range from the SAME anchor shrinks it — the old tail must
  // not stay selected.
  await selectCompany(page, leaves[2].company, { modifiers: ["Shift"] });
  await expect(bar(page)).toContainText("2 selected");
  expect((await selectedKeys(page)).sort()).toEqual(
    leaves.slice(1, 3).map((j) => j.key).sort(),
  );
});

test("Space toggles the active row, Shift+j/k extends and shrinks", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "keyboard-only affordance");
  await gotoJobs(page);

  await page.keyboard.press("j"); // cursor parks on row 1
  await page.keyboard.press(" ");
  await expect(bar(page)).toContainText("1 selected");

  await page.keyboard.press("Shift+j");
  await page.keyboard.press("Shift+j");
  await expect(bar(page)).toContainText("3 selected");
  expect((await selectedKeys(page)).sort()).toEqual(
    QUEUE_SORTED.slice(0, 3).map((j) => j.key).sort(),
  );

  await page.keyboard.press("Shift+k"); // shrink back
  await expect(bar(page)).toContainText("2 selected");
});

test("typing in the quick search never triages or copies — the guard, for i/x/s (row 38's rule)", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "keyboard-only affordance");
  await gotoJobs(page);
  await selectCompany(page, "Chime");
  await expect(bar(page)).toContainText("1 selected");

  const search = page.getByLabel("Search roles");
  await search.click();
  await search.pressSequentially("ixs");
  await expect(search).toHaveValue("ixs");
  // No decision happened: no toast, and the row is still undecided on screen
  // once the search is cleared.
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await search.fill("");
  await expect(companyCell(page, "Chime")).toHaveCount(1);
});

// ---------------------------------------------------------------------------
// ⌘C and the prune rule (matrix row 33's shape)
// ---------------------------------------------------------------------------

test("⌘C copies the selected rows as TSV — visible columns in view order, byte-asserted", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "keyboard-only affordance");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await gotoJobs(page);

  await selectCompany(page, QUEUE_SORTED[0].company);
  await selectCompany(page, QUEUE_SORTED[1].company);
  await page.keyboard.press("ControlOrMeta+c");

  await expect(page.getByText("Copied 2 rows")).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(toTsv(QUEUE_SORTED.slice(0, 2), QUEUE_EXPORT_COLS));
});

test("selection prunes when a filter hides selected rows: copy and export carry ONLY the visible ones", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "modifier-key affordance");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await gotoJobs(page);

  // Select three rows; the coming filter (work model = Remote (US)) keeps
  // exactly one of them (Plaid) and hides Ramp and Chime.
  await selectCompany(page, "Ramp");
  await selectCompany(page, "Plaid");
  await selectCompany(page, "Chime");
  await expect(bar(page)).toContainText("3 selected");

  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByLabel("Filter field").selectOption("workModel");
  await page.getByRole("checkbox", { name: "Remote (US)" }).check();
  await page.getByRole("button", { name: "Add filter" }).click();

  // The bar restates the pruned truth…
  await expect(bar(page)).toContainText("1 selected");

  // …⌘C emits exactly the still-visible selected row…
  await page.keyboard.press("ControlOrMeta+c");
  await expect(page.getByText("Copied 1 row", { exact: false })).toBeVisible();
  const plaid = FIXTURE_JOBS.find((j) => j.company === "Plaid")!;
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    toTsv([plaid], QUEUE_EXPORT_COLS),
  );

  // …the export menu states the pruned count and the file matches it…
  await page.getByTestId("grid-export").click();
  await expect(page.getByTestId("grid-export-selection")).toContainText("Selection (1)");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("grid-export-selection").click(),
  ]);
  const file = fs.readFileSync((await download.path())!, "utf8");
  expect(file).toBe(toCsv([plaid], QUEUE_EXPORT_COLS));

  // …and removing the filter does NOT resurrect the pruned rows: the user
  // stopped being able to see them, so they left the selection for good.
  await page.getByRole("button", { name: /^Remove filter/ }).click();
  await expect(companyCell(page, "Ramp")).toHaveCount(1);
  await expect(bar(page)).toContainText("1 selected");
});

// ---------------------------------------------------------------------------
// The export menu (H22): stated counts are the file's counts
// ---------------------------------------------------------------------------

test("export menu: current view exports exactly the filtered rows it promised (H22)", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the toolbar menu is desktop chrome");
  await gotoJobs(page);

  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByLabel("Filter field").selectOption("workModel");
  await page.getByRole("checkbox", { name: "Remote (US)" }).check();
  await page.getByRole("button", { name: "Add filter" }).click();

  const expected = QUEUE_SORTED.filter(
    (j) => (j.workModel ?? "").toLowerCase() === "remote (us)",
  );
  expect(expected.length).toBeGreaterThan(1); // or the scopes cannot differ

  await page.getByTestId("grid-export").click();
  // Every scope line states its count; the menu also owns up to the column set.
  await expect(page.getByTestId("grid-export-view")).toContainText(
    `Current view (${expected.length} rows)`,
  );
  await expect(page.getByTestId("grid-export-selection")).toContainText("Selection (0)");
  await expect(page.getByTestId("grid-export-all")).toContainText(`All (${TOTAL} rows)`);
  await expect(page.getByTestId("grid-export-note")).toContainText(
    "all role fields plus the posting URL",
  );

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("grid-export-view").click(),
  ]);
  expect(download.suggestedFilename()).toBe("job-search-hq-jobs-2026-07-21.csv");
  const file = fs.readFileSync((await download.path())!, "utf8");
  // Byte-for-byte: the stated 3 rows, the view's visible columns, nothing else.
  expect(file).toBe(toCsv(expected, QUEUE_EXPORT_COLS));
  await expect(page.getByText(`Exported ${expected.length} rows`)).toBeVisible();

  // The All scope really is a different file — every posting, not the view.
  await page.getByTestId("grid-export").click();
  const [all] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("grid-export-all").click(),
  ]);
  const allFile = fs.readFileSync((await all.path())!, "utf8");
  expect(allFile.trim().split("\r\n")).toHaveLength(TOTAL + 1);
});

// ---------------------------------------------------------------------------
// Bulk triage: one action, one transaction, one undo
// ---------------------------------------------------------------------------

test("bulk i on 3 rows creates 3 applications through one action with ONE undo toast", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "keyboard-only affordance");
  await gotoJobs(page);

  const picks = CLEAN.slice(0, 3);
  await selectCompany(page, picks[0].company);
  await selectCompany(page, picks[1].company);
  await selectCompany(page, picks[2].company);
  await page.keyboard.press("i");

  // One toast, one undo — not three of each.
  await expect(page.getByText("Marked 3 roles interested")).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(1);

  // The rows left the queue set optimistically and the stated count follows.
  for (const j of picks) await expect(companyCell(page, j.company)).toHaveCount(0);
  await expect(page.getByTestId("grid-count")).toHaveText(`${QUEUED - 3} roles`);

  // The store really holds three new Queued applications: a second page reads
  // them back — client state cannot fake this.
  const pipeline = await context.newPage();
  await pipeline.goto("/pipeline");
  // Scoped to the surface rather than a bare getByText: a pipeline row carries
  // its company in the visible text AND in two control aria-labels, so the
  // loose locator now matches three elements and trips strict mode.
  const surface = pipeline.getByTestId("pipeline");
  for (const j of picks) await expect(surface).toContainText(j.company);
});

test("the single Undo reverts the whole batch — rows return, applications are gone", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "keyboard-only affordance");
  await gotoJobs(page);

  const picks = CLEAN.slice(0, 3);
  await selectCompany(page, picks[0].company);
  await selectCompany(page, picks[1].company);
  await selectCompany(page, picks[2].company);
  await page.keyboard.press("i");
  await expect(page.getByText("Marked 3 roles interested")).toBeVisible();
  for (const j of picks) await expect(companyCell(page, j.company)).toHaveCount(0);

  await page.getByRole("button", { name: "Undo" }).click();

  // ALL three come back, and the count agrees.
  for (const j of picks) await expect(companyCell(page, j.company)).toHaveCount(1);
  await expect(page.getByTestId("grid-count")).toHaveText(`${QUEUED} roles`);

  // The compensating batch reached the store: no application survives.
  const pipeline = await context.newPage();
  await pipeline.goto("/pipeline");
  await expect(pipeline.getByTestId("export-open")).toBeVisible();
  for (const j of picks) await expect(pipeline.getByText(j.company)).toHaveCount(0);
});

test("a conflict inside the batch applies NOTHING: full revert plus a changed-elsewhere toast", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "keyboard-only affordance");
  // Tab A loads the grid and holds (soon to be) stale row versions.
  await gotoJobs(page);

  // Tab B, same store, dismisses the queue's first card (Ramp) — Tab A's copy
  // of that row is now stale.
  const other = await context.newPage();
  await other.goto("/queue");
  await expect(other.locator('[data-testid="triage"][data-ready="true"]')).toBeAttached();
  await other.getByTestId("pass").click();
  await expect(other.getByText("Passed", { exact: true })).toBeVisible();

  // Tab A: bulk-dismiss a selection that includes the stale row.
  await selectCompany(page, QUEUE_SORTED[0].company);
  await selectCompany(page, "Chime");
  await selectCompany(page, "Mercury");
  await page.keyboard.press("x");

  await expect(page.getByText(/changed on another device/i)).toBeVisible();
  // The optimistic removal reverted for the non-conflicting rows too.
  await expect(companyCell(page, "Chime")).toHaveCount(1);
  await expect(companyCell(page, "Mercury")).toHaveCount(1);

  // And the STORE proves atomicity: only the other tab's dismissal (plus the
  // Notion fixture) exists — Chime and Mercury were not half-applied.
  const check = await context.newPage();
  await check.goto("/jobs?set=dismissed");
  await expect(check.locator('[data-testid="jobs-grid"][data-ready="true"]')).toBeAttached();
  await expect(check.getByTestId("grid-count")).toHaveText("2 roles");
  await expect(companyCell(check, QUEUE_SORTED[0].company)).toHaveCount(1);
  await expect(companyCell(check, "Notion")).toHaveCount(1);
  await expect(companyCell(check, "Chime")).toHaveCount(0);
  await expect(companyCell(check, "Mercury")).toHaveCount(0);
});

test("a failed write reverts the whole batch and says so — and the store holds nothing", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "keyboard-only affordance");
  // The generic write-error branch of the shared write path (#198): decisions.ts
  // reverts every optimistic row and toasts "Couldn't save that." with Retry.
  // `hq_demo_fail` arms the store's next WRITE on every resolve while the cookie
  // is set (get-source.ts), so it is set immediately before the gesture and
  // cleared immediately after the failure — a read that resolves the store while
  // it lingers would re-arm the seam under the follow-up gesture below.
  await gotoJobs(page);

  const picks = CLEAN.slice(0, 3);
  await selectCompany(page, picks[0].company);
  await selectCompany(page, picks[1].company);
  await selectCompany(page, picks[2].company);
  await expect(bar(page)).toContainText("3 selected");

  await context.addCookies([{ name: "hq_demo_fail", value: "the store said no", url: ORIGIN }]);
  await page.keyboard.press("i");

  // The failure is on screen with the store's own words and a way forward.
  await expect(page.getByText("Couldn't save that.")).toBeVisible();
  await expect(page.getByText("the store said no")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

  // Every optimistic row came back — including the two that would have
  // succeeded alone. A toast beside a wrong grid is the worse bug, so the
  // assertion is on the CELLS, not merely on the toast having appeared.
  for (const j of picks) await expect(companyCell(page, j.company)).toHaveCount(1);
  await expect(page.getByTestId("grid-count")).toHaveText(`${QUEUED} roles`);

  // The surface came back LIVE: onRevert restored the selection the gesture
  // consumed, and `busy` did not stay stuck holding the controls disabled.
  await expect(bar(page)).toContainText("3 selected");
  await expect(bar(page).getByRole("button", { name: "Interested 3" })).toBeEnabled();

  await context.clearCookies({ name: "hq_demo_fail" });

  // The STORE holds nothing — the revert is not a repaint. A second page reads
  // the interested set fresh (cookie already cleared, so this read re-arms
  // nothing) and finds only the fixture's own row.
  const check = await context.newPage();
  await check.goto("/jobs?set=interested");
  await expect(check.locator('[data-testid="jobs-grid"][data-ready="true"]')).toBeAttached();
  await expect(check.getByTestId("grid-count")).toHaveText(interestedCount(INTERESTED));
  for (const j of picks) await expect(companyCell(check, j.company)).toHaveCount(0);

  // And the returned rows are selectable ROWS, not a dead overlay: toggling one
  // still moves the count, and a follow-up `i` on the restored selection acts.
  await selectCompany(page, picks[0].company);
  await expect(bar(page)).toContainText("2 selected");
  await selectCompany(page, picks[0].company);
  await expect(bar(page)).toContainText("3 selected");
  await page.keyboard.press("i");
  await expect(page.getByText("Marked 3 roles interested")).toBeVisible();
  for (const j of picks) await expect(companyCell(page, j.company)).toHaveCount(0);
  await expect(page.getByTestId("grid-count")).toHaveText(`${QUEUED - 3} roles`);
});

test("the toast's Retry re-issues the failed batch and lands it once the seam is cleared", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "keyboard-only affordance");
  await gotoJobs(page);

  const picks = CLEAN.slice(0, 3);
  await selectCompany(page, picks[0].company);
  await selectCompany(page, picks[1].company);
  await selectCompany(page, picks[2].company);
  await context.addCookies([{ name: "hq_demo_fail", value: "the store said no", url: ORIGIN }]);
  await page.keyboard.press("i");
  await expect(page.getByText("Couldn't save that.")).toBeVisible();

  // Cleared BEFORE Retry, necessarily: the cookie re-arms the failure on every
  // store resolve, so a Retry pressed while it is set fails again, legitimately.
  await context.clearCookies({ name: "hq_demo_fail" });

  // Retry calls decide() again, which mints a FRESH idempotency key — a
  // re-issue, not a replay of the failed attempt's key. Triage is by-value, so
  // the outcome is single either way; that is why everything below asserts
  // final STORE STATE and never write counts or key equality. Do not "fix"
  // these assertions into counting calls — that would pin a mechanism the
  // contract does not promise, and flake the day the re-issue changes shape.
  await page.getByRole("button", { name: "Retry" }).click();

  await expect(page.getByText("Marked 3 roles interested")).toBeVisible();
  for (const j of picks) await expect(companyCell(page, j.company)).toHaveCount(0);
  await expect(page.getByTestId("grid-count")).toHaveText(`${QUEUED - 3} roles`);

  // The working set agrees on a fresh read — the sibling conflict test's store
  // check, pointed at the set the decision moved rows INTO.
  const check = await context.newPage();
  await check.goto("/jobs?set=interested");
  await expect(check.locator('[data-testid="jobs-grid"][data-ready="true"]')).toBeAttached();
  await expect(check.getByTestId("grid-count")).toHaveText(interestedCount(INTERESTED + 3));
  for (const j of picks) await expect(companyCell(check, j.company)).toHaveCount(1);
});

test("bulk s saves the whole selection for later with a wake date", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "keyboard-only affordance");
  await gotoJobs(page);

  await selectCompany(page, "Chime");
  await selectCompany(page, "Mercury");
  await page.keyboard.press("s");

  await expect(page.getByText("Saved 2 roles for later")).toBeVisible();
  await expect(companyCell(page, "Chime")).toHaveCount(0);

  const check = await context.newPage();
  await check.goto("/jobs?set=snoozed");
  await expect(check.locator('[data-testid="jobs-grid"][data-ready="true"]')).toBeAttached();
  await expect(companyCell(check, "Chime")).toHaveCount(1);
  await expect(companyCell(check, "Mercury")).toHaveCount(1);
});

test("the selection bar buttons drive the same bulk path as the keys", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "modifier-key affordance");
  await gotoJobs(page);

  await selectCompany(page, "Chime");
  await selectCompany(page, "Mercury");
  await bar(page).getByRole("button", { name: /Pass/ }).click();

  await expect(page.getByText("Passed 2 roles")).toBeVisible();
  await expect(companyCell(page, "Chime")).toHaveCount(0);
  await expect(companyCell(page, "Mercury")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Layout: the bar must not break the 280px guarantee
// ---------------------------------------------------------------------------

test("at 280px a selection paints nothing past the page edge", async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 900 });
  await gotoJobs(page);

  await selectCompany(page, "Ramp");
  await selectCompany(page, "Chime");
  await expect(bar(page)).toContainText("2 selected");

  const offenders = await page.evaluate(collectPaintedOverflow);
  expect(offenders, describeOffenders(offenders)).toEqual([]);
});
