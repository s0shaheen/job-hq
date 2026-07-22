import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_JOBS } from "@/lib/data/fixtures";

/**
 * The URL is the source of truth for navigational grid state — matrix row 19
 * and acceptance criterion 22. Three properties, each with the failure it
 * blocks:
 *
 *   1. A cold deep link renders exactly its state ON THE SERVER — no
 *      post-hydration pop where the grid flashes unfiltered and then snaps.
 *   2. Back/forward replays filter and sort DECISIONS, one per step — not
 *      keystrokes, and not nothing.
 *   3. A malformed param drops that clause loudly (a toast) and never takes
 *      the page down or silently "repairs" itself into a different filter.
 *
 * Expected row sets are derived from FIXTURE_JOBS with inline predicates —
 * never by calling the engine under test, and never as hardcoded totals.
 */

const FIXTURE_NOW = new Date("2026-07-21T15:00:00.000Z");
const TOTAL = FIXTURE_JOBS.length;
const QUEUE = FIXTURE_JOBS.filter(
  (j) =>
    j.disposition === "qualified" &&
    j.triage === "" &&
    (j.status ?? "").trim().toLowerCase() !== "closed",
);

test.beforeEach(async ({ page, context }) => {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await context.addCookies([
    {
      name: "hq_demo_id",
      value: `gu-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      url: "http://127.0.0.1:3210",
    },
  ]);
});

async function ready(page: Page) {
  await expect(
    page.locator('[data-testid="jobs-grid"][data-ready="true"]'),
  ).toBeAttached();
}

const companyCells = (page: Page) => page.locator('[role="gridcell"][data-col="company"]');

test("a cold deep link renders its exact state in the server HTML — no post-hydration pop", async ({
  page,
}) => {
  // Work-model filter + comp sort, both from the URL alone.
  const url = "/jobs?set=all&f=workModel.in.Remote|Remote+(US)&sort=comp.desc";
  const expected = FIXTURE_JOBS.filter((j) =>
    ["remote", "remote (us)"].includes((j.workModel ?? "").toLowerCase()),
  ).sort((a, b) => (b.compMaxK ?? -Infinity) - (a.compMaxK ?? -Infinity));
  expect(expected.length).toBeGreaterThan(2); // the fixture must make this non-trivial

  // The RAW response, before any client JS: the filtered count and the sorted
  // order must already be in it. This is the assertion that catches a grid
  // which server-renders everything and filters after hydration.
  const html = await (await page.request.get(url)).text();
  expect(html).toContain(`${expected.length} of ${TOTAL} postings match`);
  const first = html.indexOf(`>${expected[0].company}<`);
  const second = html.indexOf(`>${expected[1].company}<`);
  expect(first, `${expected[0].company} not in the server HTML`).toBeGreaterThan(-1);
  expect(second, `${expected[1].company} not in the server HTML`).toBeGreaterThan(-1);
  expect(first, "server HTML is not sorted comp-desc").toBeLessThan(second);

  // And the hydrated page shows the same state.
  await page.goto(url);
  await ready(page);
  await expect(companyCells(page)).toHaveText(expected.map((j) => j.company));
  await expect(page.locator('[role="columnheader"][data-col="comp"]')).toHaveAttribute(
    "aria-sort",
    "descending",
  );
});

test("back/forward replays filter and sort decisions, one per step (criterion 22)", async ({
  page,
}) => {
  await page.goto("/jobs");
  await ready(page);

  // Decision 1: work model any-of "Remote (US)" via the clause builder.
  // exact: a chip's remove button ("Remove filter: …") substring-matches too
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByLabel("Filter field").selectOption("workModel");
  await page.getByRole("checkbox", { name: "Remote (US)" }).check();
  await page.getByRole("button", { name: "Add filter" }).click();
  const afterOne = FIXTURE_JOBS.filter(
    (j) => QUEUE.includes(j) && (j.workModel ?? "").toLowerCase() === "remote (us)",
  );
  await expect(companyCells(page)).toHaveText(afterOne.map((j) => j.company));
  await expect(page).toHaveURL(/f=workModel\.in\./);

  // Decision 2: min YoE at most 3.
  // exact: a chip's remove button ("Remove filter: …") substring-matches too
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByLabel("Filter field").selectOption("minYoe");
  await page.getByLabel("Filter operator").selectOption("lte");
  await page.getByLabel("Filter value").fill("3");
  await page.getByRole("button", { name: "Add filter" }).click();
  const afterTwo = afterOne.filter((j) => j.minYoe !== null && j.minYoe <= 3);
  await expect(companyCells(page)).toHaveText(afterTwo.map((j) => j.company));

  // Decision 3: sort by comp.
  await page.getByRole("button", { name: "Comp", exact: true }).click();
  await expect(page).toHaveURL(/sort=comp\.asc/);
  const fullUrl = page.url();

  // Leave, come back: the exact state, not an approximation of it.
  await page.locator('a[href="/queue"]').first().click();
  await page.waitForURL("**/queue");
  await page.goBack();
  await ready(page);
  expect(page.url()).toBe(fullUrl);
  await expect(companyCells(page)).toHaveText(afterTwo.map((j) => j.company));
  await expect(page.getByTestId("grid-count")).toContainText(
    `${afterTwo.length} of ${QUEUE.length}`,
  );

  // One more step back: the sort decision unwinds, the filters stay.
  await page.goBack();
  await expect(page).not.toHaveURL(/sort=/);
  await expect(page).toHaveURL(/f=minYoe\.lte\.3/);

  // And forward restores it.
  await page.goForward();
  expect(page.url()).toBe(fullUrl);
  await expect(page.locator('[role="columnheader"][data-col="comp"]')).toHaveAttribute(
    "aria-sort",
    "ascending",
  );

  // The deep link is the whole state: a fresh load of the final URL renders
  // the identical grid.
  await page.goto(fullUrl);
  await ready(page);
  await expect(companyCells(page)).toHaveText(afterTwo.map((j) => j.company));
});

test("a malformed param drops that clause loudly and keeps its valid siblings", async ({
  page,
}) => {
  await page.goto("/jobs?f=garbage,minYoe.lte.3&sort=comp.sideways&group=metro");
  await ready(page);

  // The page stands, the readable clause applies…
  const expected = QUEUE.filter((j) => j.minYoe !== null && j.minYoe <= 3);
  await expect(companyCells(page)).toHaveText(expected.map((j) => j.company));

  // …the unreadable ones are announced, not silently vanished…
  await expect(page.getByText(/Ignored 3 unrecognized/)).toBeVisible();

  // …and neither the bogus sort nor the bogus grouping half-applied.
  await expect(page.locator('[role="columnheader"][data-col="comp"]')).not.toHaveAttribute(
    "aria-sort",
    /.*/,
  );
  await expect(page.getByTestId("group-header")).toHaveCount(0);
});

test("typing in quick search coalesces into ONE history entry — Back steps over it, not through it", async ({
  page,
}) => {
  await page.goto("/jobs");
  await ready(page);

  // A discrete decision first (push), so the typing session below has a prior
  // entry to collapse onto — replace mutates the current entry by design.
  await page.getByRole("button", { name: "All postings" }).click();
  await expect(page).toHaveURL(/set=all/);

  const search = page.getByLabel("Quick search");
  await search.click();
  await search.pressSequentially("mod");
  await expect(page).toHaveURL(/q=mod(&|$)/);
  await search.pressSequentially("ern trea");
  await expect(page).toHaveURL(/q=modern\+trea/);

  await expect(companyCells(page)).toHaveText(["Modern Treasury"]);

  // Typing must never look like triage: no toast appeared for any keystroke.
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);

  // One Back steps over the ENTIRE typing session — two debounce flushes,
  // eleven keystrokes, one history entry. If the flushes had pushed instead of
  // replaced, this would land on q=mod (or worse, per keystroke).
  await page.goBack();
  await expect(page).not.toHaveURL(/q=/);
  await expect(page).not.toHaveURL(/set=/);
  await expect(page.getByTestId("grid-count")).toContainText(
    `${QUEUE.length} of ${TOTAL}`,
  );
});
