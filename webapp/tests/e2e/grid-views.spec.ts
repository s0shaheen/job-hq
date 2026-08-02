import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_JOBS } from "@/lib/data/fixtures";

/**
 * G3 — saved views, built-in presets, personas, and the landing default.
 *
 * The one discipline running through this file: every state assertion that
 * matters is repeated AFTER a reload. The three-copies-of-the-store bug and
 * the demo-isolation bug both hid behind tests that asserted client state
 * immediately after a gesture and never loaded the page again — a
 * server-confirmed toast over a write nothing else could read.
 *
 * The switcher itself is desktop chrome (like the Group select, the phone bar
 * has no room at rest and the loading skeleton pins the toolbar height); the
 * STATE stays reachable on every device through the URL, which one test here
 * exercises on the mobile project by deep link.
 */

const FIXTURE_NOW = new Date("2026-07-21T15:00:00.000Z");
const TOTAL = FIXTURE_JOBS.length;
const QUEUE = FIXTURE_JOBS.filter(
  (j) =>
    j.disposition === "qualified" &&
    j.triage === "" &&
    (j.status ?? "").trim().toLowerCase() !== "closed",
);
const REMOTE_US = QUEUE.filter((j) => (j.workModel ?? "").toLowerCase() === "remote (us)");

test.beforeEach(async ({ page, context }) => {
  await page.clock.setFixedTime(FIXTURE_NOW);
  // A fresh demo store per test: saved views live in the per-cookie fixture
  // store, so each test starts with zero views — which is what the create
  // flows here need.
  await context.addCookies([
    {
      name: "hq_demo_id",
      value: `gv-${Math.random().toString(36).slice(2)}-${Date.now()}`,
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
const switcher = (page: Page) => page.getByTestId("view-switcher");

async function openSwitcher(page: Page) {
  await switcher(page).click();
  await expect(page.getByRole("menu")).toBeVisible();
}

/** Add a "Work model is any of Remote (US)" chip via the clause builder. */
async function addRemoteFilter(page: Page) {
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByLabel("Filter field").selectOption("workModel");
  await page.getByRole("checkbox", { name: "Remote (US)" }).check();
  await page.getByRole("button", { name: "Add filter" }).click();
}

/** Add a "Min YoE at most N" chip. */
async function addYoeFilter(page: Page, max: number) {
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByLabel("Filter field").selectOption("minYoe");
  await page.getByLabel("Filter operator").selectOption("lte");
  await page.getByLabel("Filter value").fill(String(max));
  await page.getByRole("button", { name: "Add filter" }).click();
}

async function saveAs(page: Page, name: string, opts: { landing?: boolean } = {}) {
  await openSwitcher(page);
  await page.getByRole("menuitem", { name: /Save as/ }).click();
  await page.getByLabel("View name").fill(name);
  if (opts.landing) await page.getByLabel("Use as my landing view").check();
  await page.getByRole("button", { name: "Save view" }).click();
}

test("the built-in presets navigate to their working sets and show exactly their rows", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the switcher is desktop chrome");
  await page.goto("/jobs");
  await ready(page);

  await openSwitcher(page);
  await expect(page.getByRole("menuitemradio", { name: "Queue" })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // Later — exactly the snoozed fixtures, derived not hardcoded.
  const snoozed = FIXTURE_JOBS.filter((j) => j.triage === "snoozed");
  expect(snoozed.length).toBeGreaterThan(0);
  await page.getByRole("menuitemradio", { name: "Later" }).click();
  await expect(page).toHaveURL(/set=snoozed/);
  await expect(companyCells(page)).toHaveText(
    snoozed.map((j) => j.company),
  );
  await expect(page.getByTestId("grid-count")).toContainText(
    `${snoozed.length} of ${TOTAL}`,
  );

  // Needs review — and the Why column explains what the row is waiting on.
  const needsInfo = FIXTURE_JOBS.filter((j) => j.disposition === "needs-info");
  expect(needsInfo.length).toBeGreaterThan(0);
  await openSwitcher(page);
  await page.getByRole("menuitemradio", { name: "Needs review" }).click();
  await expect(page).toHaveURL(/set=needs-review/);
  await expect(companyCells(page)).toHaveText(needsInfo.map((j) => j.company));
  await expect(page.locator('[role="columnheader"][data-col="why"]')).toHaveCount(1);

  // Passed.
  const dismissed = FIXTURE_JOBS.filter((j) => j.triage === "dismissed");
  await openSwitcher(page);
  await page.getByRole("menuitemradio", { name: "Passed" }).click();
  await expect(companyCells(page)).toHaveText(dismissed.map((j) => j.company));

  // Presets are code, not rows — nothing offers to delete one.
  await openSwitcher(page);
  await expect(page.getByRole("menuitem", { name: /Delete view/ })).toHaveCount(0);
});

test("preset deep links render without the switcher — the URL is the state", async ({
  page,
}) => {
  // Runs on BOTH projects: on a phone the switcher is hidden, so this link IS
  // the preset. A preset that only works through the dropdown would strand
  // mobile users on Queue forever.
  const snoozed = FIXTURE_JOBS.filter((j) => j.triage === "snoozed");
  await page.goto("/jobs?set=snoozed");
  await ready(page);
  await expect(companyCells(page)).toHaveText(snoozed.map((j) => j.company));
});

test("Save as… captures the edited state; the view survives a reload and lists in the switcher", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the switcher is desktop chrome");
  await page.goto("/jobs");
  await ready(page);

  await addRemoteFilter(page);
  expect(REMOTE_US.length).toBeGreaterThan(0);
  await expect(switcher(page)).toHaveAttribute("data-edited", "true");

  await saveAs(page, "Remote only");
  await expect(page).toHaveURL(/\/jobs\?view=/);
  await expect(switcher(page)).toContainText("Remote only");
  await expect(switcher(page)).not.toHaveAttribute("data-edited", "true");
  await expect(companyCells(page)).toHaveText(REMOTE_US.map((j) => j.company));
  // The chip renders from the VIEW's state now, not from URL params.
  await expect(page.getByTestId("filter-chip")).toHaveText(/Work model: Remote \(US\)/);

  // THE reload. Without it, a view saved into a store nothing re-reads would
  // pass every assertion above and be gone on the next visit.
  await page.reload();
  await ready(page);
  await expect(switcher(page)).toContainText("Remote only");
  await expect(companyCells(page)).toHaveText(REMOTE_US.map((j) => j.company));

  // And the server already knows: the raw HTML of the view URL carries the
  // filtered count, so a shared link paints its state with no hydration pop.
  const html = await (await page.request.get(page.url())).text();
  expect(html).toContain(`${REMOTE_US.length} of ${QUEUE.length}`);

  await openSwitcher(page);
  await expect(page.getByRole("menuitemradio", { name: "Remote only" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("a name collision is rejected with the store's message, not a crash", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the switcher is desktop chrome");
  await page.goto("/jobs");
  await ready(page);

  await addRemoteFilter(page);
  await saveAs(page, "Mine");
  await expect(page).toHaveURL(/\/jobs\?view=/);

  // Same name, different casing — the store treats names case-insensitively.
  await addYoeFilter(page, 3);
  await saveAs(page, "mine");
  await expect(page.getByRole("alert")).toHaveText('a view named "mine" already exists');
  // The dialog stands (nothing navigated, nothing crashed) and can be left.
  await expect(page.getByLabel("View name")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("grid-count")).toBeVisible();
});

test("Save updates the view in place — and Reset abandons an edit", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the switcher is desktop chrome");
  await page.goto("/jobs");
  await ready(page);

  await addYoeFilter(page, 3);
  await saveAs(page, "Tweaks");
  await expect(page).toHaveURL(/\/jobs\?view=/);

  // Edit on top of the saved view, then Save in place.
  await addRemoteFilter(page);
  await expect(switcher(page)).toHaveAttribute("data-edited", "true");
  await openSwitcher(page);
  await page.getByRole("menuitem", { name: "Save", exact: true }).click();
  await expect(switcher(page)).not.toHaveAttribute("data-edited", "true");

  await page.reload();
  await ready(page);
  await expect(page.getByTestId("filter-chip")).toHaveCount(2);

  // A further edit, abandoned: Reset returns to the saved state.
  await addRemoteFilter(page);
  await expect(page.getByTestId("filter-chip")).toHaveCount(3);
  await openSwitcher(page);
  await page.getByRole("menuitem", { name: "Reset" }).click();
  await expect(page.getByTestId("filter-chip")).toHaveCount(2);
  await expect(switcher(page)).not.toHaveAttribute("data-edited", "true");
});

test("'Use as my landing view' makes bare /jobs open the view — and Queue stays reachable", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the switcher is desktop chrome");
  await page.goto("/jobs");
  await ready(page);

  await addRemoteFilter(page);
  await saveAs(page, "My landing", { landing: true });
  await expect(page).toHaveURL(/\/jobs\?view=/);

  // The landing contract: a bare /jobs — a fresh open, a bookmark — renders
  // the default view, asserted through a full navigation, not client state.
  await page.goto("/jobs");
  await ready(page);
  await expect(switcher(page)).toContainText("My landing");
  await expect(companyCells(page)).toHaveText(REMOTE_US.map((j) => j.company));

  // …and the plain Queue preset must still be reachable, or the default
  // hijacks /jobs forever (the explicit set param defeats it).
  await openSwitcher(page);
  await page.getByRole("menuitemradio", { name: "Queue" }).click();
  await expect(page).toHaveURL(/set=queue/);
  await expect(companyCells(page)).toHaveText(QUEUE.map((j) => j.company));
  await expect(switcher(page)).toContainText("Queue");
});

test("a second device's edit turns Save into a visible conflict, not a clobber", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the switcher is desktop chrome");
  await page.goto("/jobs");
  await ready(page);
  await addYoeFilter(page, 4);
  await saveAs(page, "Shared");
  await expect(page).toHaveURL(/\/jobs\?view=/);
  const viewUrl = page.url();

  // "Another device": a second page over the same store, which saves first.
  const other = await context.newPage();
  await other.clock.setFixedTime(FIXTURE_NOW);
  await other.goto(viewUrl);
  await ready(other);
  await addRemoteFilter(other);
  await openSwitcher(other);
  await other.getByRole("menuitem", { name: "Save", exact: true }).click();
  await expect(other.getByTestId("filter-chip")).toHaveCount(2);
  await other.close();

  // The first page still holds the pre-edit version token — PROVIDED it does
  // not navigate (any navigation refetches the view list and un-stales it,
  // which is the app working, not the race). A display edit navigates
  // nothing: flip density, then Save. That Save must surface the conflict —
  // silently winning would throw away the other device's edit with no one
  // the wiser.
  await openSwitcher(page);
  await page.getByRole("menuitemradio", { name: "Comfortable" }).click();
  await page.getByRole("menuitem", { name: "Save", exact: true }).click();
  await expect(
    page.getByText(/changed on another device/),
  ).toBeVisible();

  // The stored state is the other device's, asserted after a reload.
  await page.goto(viewUrl);
  await ready(page);
  await expect(page.getByTestId("filter-chip")).toHaveCount(2);
});

test("an expired session answers with the auth copy, not a crash", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the switcher is desktop chrome");
  await context.addCookies([
    { name: "hq_demo_session", value: "expired", url: "http://127.0.0.1:3210" },
  ]);
  await page.goto("/jobs");
  await ready(page);
  await addRemoteFilter(page);
  await saveAs(page, "Nope");
  await expect(page.getByRole("alert")).toContainText("session expired");
});

test("a stale view id falls back loudly — never a 404, never a blank grid", async ({
  page,
}) => {
  await page.goto("/jobs?view=deleted-on-another-device");
  await ready(page);
  await expect(page.getByText(/no longer exists/)).toBeVisible();
  await expect(companyCells(page)).toHaveText(QUEUE.map((j) => j.company));
});

test("Delete removes the view, after a confirm", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the switcher is desktop chrome");
  await page.goto("/jobs");
  await ready(page);
  await addRemoteFilter(page);
  await saveAs(page, "Doomed");
  await expect(page).toHaveURL(/\/jobs\?view=/);

  await openSwitcher(page);
  await page.getByRole("menuitem", { name: /Delete view/ }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(/set=queue/);
  await openSwitcher(page);
  await expect(page.getByRole("menuitemradio", { name: "Doomed" })).toHaveCount(0);
});

test("the persona seeds apply nav and display in one pick", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the switcher is desktop chrome");
  await page.goto("/jobs");
  await ready(page);

  // Dad: comfortable rows, large type, hints off — display only, still Queue.
  await openSwitcher(page);
  await page.getByRole("menuitem", { name: "Comfortable, large type" }).click();
  const row = page.locator('[role="row"][aria-rowindex="2"]');
  await expect
    .poll(async () => (await row.boundingBox())?.height ?? 0)
    .toBeGreaterThan(40);
  await expect(page.getByTestId("grid-hints")).toHaveCount(0);

  // Roommate: last 7 days grouped by company — nav only.
  await openSwitcher(page);
  await page.getByRole("menuitem", { name: "New this week, by company" }).click();
  await expect(page).toHaveURL(/f=firstSeen\.inlast\.7/);
  await expect(page).toHaveURL(/group=company/);
  await expect(page.getByTestId("group-header").first()).toBeVisible();
});

test("a density switch mid-scroll keeps the viewport anchored — no blank gap, no lost place", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the switcher is desktop chrome");
  // 1000 perf rows guarantee real scroll depth; the fixture set fits a screen.
  await page.goto("/jobs?perf=1000");
  await ready(page);

  const scroll = page.getByTestId("grid-scroll");
  await scroll.evaluate((el) => (el.scrollTop = 400 * 32));

  await openSwitcher(page);
  await page.getByRole("menuitemradio", { name: "Comfortable" }).click();
  await page.keyboard.press("Escape");

  // The first visible row index survives the row-height change (±2 rows), so
  // the user is still looking at the same slice of the list…
  const anchored = await scroll.evaluate((el) => el.scrollTop / 44);
  expect(Math.abs(anchored - 400)).toBeLessThanOrEqual(2);

  // …and the viewport centre is painted rows, not virtualizer void.
  const centreIsRow = await page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return !!el?.closest('[role="row"]');
  });
  expect(centreIsRow, "the viewport centre shows no row after the density switch").toBe(true);
});
