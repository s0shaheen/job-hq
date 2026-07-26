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

/** The Queue view's visible columns in view order, plus the URL the Title cell
 *  links to — the exact column contract the copy/export payloads must carry. */
const QUEUE_EXPORT_KEYS = ["company", "title", "comp", "minYoe", "workModel", "location", "posted", "url"];
const QUEUE_EXPORT_COLS = QUEUE_EXPORT_KEYS.map((k) => JOB_COLUMNS.find((c) => c.key === k)!);

test.beforeEach(async ({ page, context }) => {
  await page.clock.setFixedTime(FIXTURE_NOW);
  // Fresh store per test: bulk triage mutates it, and sharing would make these
  // counts depend on scheduling order.
  await context.addCookies([
    {
      name: "hq_demo_id",
      value: `gs-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      url: "http://127.0.0.1:3210",
    },
  ]);
});

async function gotoJobs(page: Page, path = "/jobs") {
  await page.goto(path);
  await expect(page.locator('[data-testid="jobs-grid"][data-ready="true"]')).toBeAttached();
}

function companyCell(page: Page, company: string) {
  return page
    .locator('[role="gridcell"][data-col="company"]')
    .filter({ hasText: new RegExp(`^${company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
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

test("click selects one row, the bar appears with the count, Clear empties it", async ({ page }) => {
  await gotoJobs(page);
  await expect(bar(page)).toHaveCount(0); // no selection, no bar

  await companyCell(page, "Ramp").click();
  await expect(bar(page)).toContainText("1 selected");
  expect(await selectedKeys(page)).toEqual([QUEUE_SORTED[0].key]);

  // Clicking another row REPLACES the selection — plain click never accumulates.
  await companyCell(page, "Chime").click();
  await expect(bar(page)).toContainText("1 selected");

  await bar(page).getByRole("button", { name: "Clear" }).click();
  await expect(bar(page)).toHaveCount(0);
  await expect(page.locator('[role="row"][aria-selected="true"]')).toHaveCount(0);
});

test("⌘-click toggles; Escape clears; the grid does not shift when the bar appears", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "modifier-key affordance");
  await gotoJobs(page);

  const firstRowTop = () =>
    page
      .locator('[role="row"][aria-rowindex="2"]')
      .evaluate((el) => Math.round(el.getBoundingClientRect().top));
  const before = await firstRowTop();

  await companyCell(page, "Ramp").click();
  await companyCell(page, "Chime").click({ modifiers: ["ControlOrMeta"] });
  await expect(bar(page)).toContainText("2 selected");

  // The bar overlays the grid; it must not push rows around when it appears.
  expect(await firstRowTop()).toBe(before);

  await companyCell(page, "Ramp").click({ modifiers: ["ControlOrMeta"] });
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

  await companyCell(page, leaves[1].company).click();
  await companyCell(page, leaves[4].company).click({ modifiers: ["Shift"] });

  await expect(bar(page)).toContainText("4 selected");
  expect((await selectedKeys(page)).sort()).toEqual(
    leaves.slice(1, 5).map((j) => j.key).sort(),
  );
  // Group headers exist on screen and none of them is selected.
  await expect(page.getByTestId("group-header")).toHaveCount(QUEUED);
  await expect(page.locator('[data-testid="group-header"][aria-selected="true"]')).toHaveCount(0);

  // Re-pinning the range from the SAME anchor shrinks it — the old tail must
  // not stay selected.
  await companyCell(page, leaves[2].company).click({ modifiers: ["Shift"] });
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
  await companyCell(page, "Chime").click();
  await expect(bar(page)).toContainText("1 selected");

  const search = page.getByLabel("Quick search");
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

  await companyCell(page, QUEUE_SORTED[0].company).click();
  await companyCell(page, QUEUE_SORTED[1].company).click({ modifiers: ["ControlOrMeta"] });
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
  await companyCell(page, "Ramp").click();
  await companyCell(page, "Plaid").click({ modifiers: ["ControlOrMeta"] });
  await companyCell(page, "Chime").click({ modifiers: ["ControlOrMeta"] });
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
  await expect(page.getByTestId("grid-export-note")).toContainText("Hidden columns are excluded");

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
  await companyCell(page, picks[0].company).click();
  await companyCell(page, picks[1].company).click({ modifiers: ["ControlOrMeta"] });
  await companyCell(page, picks[2].company).click({ modifiers: ["ControlOrMeta"] });
  await page.keyboard.press("i");

  // One toast, one undo — not three of each.
  await expect(page.getByText("Saved 3 roles")).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(1);

  // The rows left the queue set optimistically and the stated count follows.
  for (const j of picks) await expect(companyCell(page, j.company)).toHaveCount(0);
  await expect(page.getByTestId("grid-count")).toContainText(`${QUEUED - 3} of ${TOTAL}`);

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
  await companyCell(page, picks[0].company).click();
  await companyCell(page, picks[1].company).click({ modifiers: ["ControlOrMeta"] });
  await companyCell(page, picks[2].company).click({ modifiers: ["ControlOrMeta"] });
  await page.keyboard.press("i");
  await expect(page.getByText("Saved 3 roles")).toBeVisible();
  for (const j of picks) await expect(companyCell(page, j.company)).toHaveCount(0);

  await page.getByRole("button", { name: "Undo" }).click();

  // ALL three come back, and the count agrees.
  for (const j of picks) await expect(companyCell(page, j.company)).toHaveCount(1);
  await expect(page.getByTestId("grid-count")).toContainText(`${QUEUED} of ${TOTAL}`);

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
  await expect(other.getByText(`Passed on ${QUEUE_SORTED[0].company}`, { exact: false })).toBeVisible();

  // Tab A: bulk-dismiss a selection that includes the stale row.
  await companyCell(page, QUEUE_SORTED[0].company).click();
  await companyCell(page, "Chime").click({ modifiers: ["ControlOrMeta"] });
  await companyCell(page, "Mercury").click({ modifiers: ["ControlOrMeta"] });
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
  await expect(check.getByTestId("grid-count")).toContainText("2 of");
  await expect(companyCell(check, QUEUE_SORTED[0].company)).toHaveCount(1);
  await expect(companyCell(check, "Notion")).toHaveCount(1);
  await expect(companyCell(check, "Chime")).toHaveCount(0);
  await expect(companyCell(check, "Mercury")).toHaveCount(0);
});

test("bulk s snoozes the whole selection with a wake date", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "keyboard-only affordance");
  await gotoJobs(page);

  await companyCell(page, "Chime").click();
  await companyCell(page, "Mercury").click({ modifiers: ["ControlOrMeta"] });
  await page.keyboard.press("s");

  await expect(page.getByText("Snoozed 2 roles")).toBeVisible();
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

  await companyCell(page, "Chime").click();
  await companyCell(page, "Mercury").click({ modifiers: ["ControlOrMeta"] });
  await bar(page).getByRole("button", { name: /Pass/ }).click();

  await expect(page.getByText("Passed on 2 roles")).toBeVisible();
  await expect(companyCell(page, "Chime")).toHaveCount(0);
  await expect(companyCell(page, "Mercury")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Layout: the bar must not break the 280px guarantee
// ---------------------------------------------------------------------------

test("at 280px a selection paints nothing past the page edge", async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 900 });
  await gotoJobs(page);

  await companyCell(page, "Ramp").click();
  await companyCell(page, "Chime").click({ modifiers: ["ControlOrMeta"] });
  await expect(bar(page)).toContainText("2 selected");

  const offenders = await page.evaluate(collectPaintedOverflow);
  expect(offenders, describeOffenders(offenders)).toEqual([]);
});
