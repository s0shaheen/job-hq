import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_JOBS } from "@/lib/data/fixtures";

/**
 * G3 — saved views, built-in tabs, and the landing default.
 *
 * The one discipline running through this file: every state assertion that
 * matters is repeated AFTER a reload. The three-copies-of-the-store bug and
 * the demo-isolation bug both hid behind tests that asserted client state
 * immediately after a gesture and never loaded the page again — a
 * server-confirmed toast over a write nothing else could read.
 *
 * Saved views are named-query tabs on every viewport. Display preferences are
 * independent controls in Display, never bundled into the view picker.
 */

const FIXTURE_NOW = new Date("2026-07-21T15:00:00.000Z");
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

const companyNames = (page: Page) =>
  page.locator('[role="gridcell"][data-col="company"] span[title]');
const viewTab = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });

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
  await viewTab(page, "Save view").click();
  await page.getByTestId("save-view-name").fill(name);
  if (opts.landing) await page.getByLabel("Open this view when I go to Jobs").check();
  await page.getByRole("button", { name: "Save view" }).click();
}

test("the built-in presets navigate to their working sets and show exactly their rows", async ({
  page,
}) => {
  await page.goto("/jobs");
  await ready(page);

  await expect(viewTab(page, "Needs decision")).toHaveAttribute("aria-current", "true");

  // Later — exactly the snoozed fixtures, derived not hardcoded.
  const snoozed = FIXTURE_JOBS.filter((j) => j.triage === "snoozed");
  expect(snoozed.length).toBeGreaterThan(0);
  await viewTab(page, "Later").click();
  await expect(page).toHaveURL(/set=snoozed/);
  await expect(companyNames(page)).toHaveText(
    snoozed.map((j) => j.company),
  );
  await expect(page.getByTestId("grid-count")).toHaveText(
    `${snoozed.length} ${snoozed.length === 1 ? "role" : "roles"}`,
  );

  // Needs review, reached by URL because it has no TAB. 03 §4 names five tabs
  // and this is a sixth working set that old links still carry, so the strip
  // renders with nothing current rather than growing an invented sixth tab
  // (ADD-009). The set still has to resolve, which is what this asserts — plus
  // that the Why column stayed retired; its sentence lives in the pane now.
  const needsInfo = FIXTURE_JOBS.filter((j) => j.disposition === "needs-info");
  expect(needsInfo.length).toBeGreaterThan(0);
  await page.goto("/jobs?set=needs-review");
  await ready(page);
  await expect(companyNames(page)).toHaveText(needsInfo.map((j) => j.company));
  await expect(page.locator('[role="columnheader"][data-col="why"]')).toHaveCount(0);
  await expect(page.locator('button[aria-current="true"]')).toHaveCount(0);

  await page.goto("/jobs?set=all");
  await ready(page);

  // Passed.
  const dismissed = FIXTURE_JOBS.filter((j) => j.triage === "dismissed");
  await viewTab(page, "Passed").click();
  await expect(companyNames(page)).toHaveText(dismissed.map((j) => j.company));

  // Built-ins are code, not rows: at rest there is no delete affordance.
  await expect(page.getByRole("button", { name: "Delete this view" })).toHaveCount(0);
});

test("built-in deep links render directly because the URL is the state", async ({
  page,
}) => {
  // Runs on both projects. A built-in query must work from a shared link, not
  // only after a tab gesture.
  const snoozed = FIXTURE_JOBS.filter((j) => j.triage === "snoozed");
  await page.goto("/jobs?set=snoozed");
  await ready(page);
  await expect(companyNames(page)).toHaveText(snoozed.map((j) => j.company));
});

test("Save view captures the edited state; the view survives a reload and lists as a tab", async ({
  page,
}) => {
  await page.goto("/jobs");
  await ready(page);

  await addRemoteFilter(page);
  expect(REMOTE_US.length).toBeGreaterThan(0);
  await expect(viewTab(page, "Save view")).toBeVisible();

  await saveAs(page, "Remote only");
  await expect(page).toHaveURL(/\/jobs\?view=/);
  await expect(viewTab(page, "Remote only")).toHaveAttribute("aria-current", "true");
  await expect(viewTab(page, "Save view")).toHaveCount(0);
  await expect(companyNames(page)).toHaveText(REMOTE_US.map((j) => j.company));
  // The chip renders from the VIEW's state now, not from URL params.
  await expect(page.getByTestId("filter-chip")).toContainText("Work model is Remote (US)");

  // THE reload. Without it, a view saved into a store nothing re-reads would
  // pass every assertion above and be gone on the next visit.
  await page.reload();
  await ready(page);
  await expect(viewTab(page, "Remote only")).toHaveAttribute("aria-current", "true");
  await expect(companyNames(page)).toHaveText(REMOTE_US.map((j) => j.company));

  // And the server already knows: the raw HTML of the view URL carries the
  // filtered count, so a shared link paints its state with no hydration pop.
  const html = await (await page.request.get(page.url())).text();
  expect(html).toContain(`${REMOTE_US.length} of ${QUEUE.length} match your filters`);
});

test("a name collision is rejected with the store's message, not a crash", async ({
  page,
}) => {
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
  await expect(page.getByTestId("save-view-name")).toBeVisible();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByTestId("grid-count")).toBeVisible();
});

test("Save updates the view in place — and Reset abandons an edit", async ({
  page,
}) => {
  await page.goto("/jobs");
  await ready(page);

  await addYoeFilter(page, 3);
  await saveAs(page, "Tweaks");
  await expect(page).toHaveURL(/\/jobs\?view=/);

  // Edit on top of the saved view, then Save in place.
  await addRemoteFilter(page);
  await viewTab(page, "Save view").click();
  await page.getByRole("button", { name: "Update Tweaks" }).click();
  await expect(viewTab(page, "Save view")).toHaveCount(0);

  await page.reload();
  await ready(page);
  await expect(page.getByTestId("filter-chip")).toHaveCount(2);

  // A further edit, abandoned: Reset returns to the saved state.
  await addRemoteFilter(page);
  await expect(page.getByTestId("filter-chip")).toHaveCount(3);
  await viewTab(page, "Tweaks").click();
  await expect(page.getByTestId("filter-chip")).toHaveCount(2);
  await expect(viewTab(page, "Save view")).toHaveCount(0);
});

test("'Open this view when I go to Jobs' sets the landing view and keeps Needs decision reachable", async ({
  page,
}) => {
  await page.goto("/jobs");
  await ready(page);

  await addRemoteFilter(page);
  await saveAs(page, "My landing", { landing: true });
  await expect(page).toHaveURL(/\/jobs\?view=/);

  // The landing contract: a bare /jobs — a fresh open, a bookmark — renders
  // the default view, asserted through a full navigation, not client state.
  await page.goto("/jobs");
  await ready(page);
  await expect(viewTab(page, "My landing")).toHaveAttribute("aria-current", "true");
  await expect(companyNames(page)).toHaveText(REMOTE_US.map((j) => j.company));

  // …and the plain Queue preset must still be reachable, or the default
  // hijacks /jobs forever (the explicit set param defeats it).
  await viewTab(page, "Needs decision").click();
  await expect(page).toHaveURL(/set=queue/);
  await expect(companyNames(page)).toHaveText(QUEUE.map((j) => j.company));
  await expect(viewTab(page, "Needs decision")).toHaveAttribute("aria-current", "true");
});

test("a second device's edit turns Save into a visible conflict, not a clobber", async ({
  page,
  context,
}) => {
  await page.goto("/jobs");
  await ready(page);
  await addYoeFilter(page, 4);
  await saveAs(page, "Shared");
  await expect(page).toHaveURL(/\/jobs\?view=/);
  const viewUrl = page.url();
  await addYoeFilter(page, 3);

  // "Another device": a second page over the same store, which saves first.
  const other = await context.newPage();
  await other.clock.setFixedTime(FIXTURE_NOW);
  await other.goto(viewUrl);
  await ready(other);
  await addRemoteFilter(other);
  await viewTab(other, "Save view").click();
  await other.getByRole("button", { name: "Update Shared" }).click();
  await expect(other.getByTestId("filter-chip")).toHaveCount(2);
  await other.close();

  // The first page still holds the pre-edit version token. Saving must surface
  // the conflict instead of clobbering the other device's change.
  await viewTab(page, "Save view").click();
  await page.getByRole("button", { name: "Update Shared" }).click();
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
}) => {
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
  await expect(companyNames(page)).toHaveText(QUEUE.map((j) => j.company));
});

test("Delete removes the view from its edit dialog", async ({ page }) => {
  await page.goto("/jobs");
  await ready(page);
  await addRemoteFilter(page);
  await saveAs(page, "Doomed");
  await expect(page).toHaveURL(/\/jobs\?view=/);

  await addYoeFilter(page, 3);
  await viewTab(page, "Save view").click();
  await page.getByRole("button", { name: "Delete this view" }).click();
  await expect(page).toHaveURL(/set=queue/);
  await expect(viewTab(page, "Doomed")).toHaveCount(0);
});

test("a density switch mid-scroll keeps the viewport anchored — no blank gap, no lost place", async ({
  page,
}) => {
  // 1000 perf rows guarantee real scroll depth; the fixture set fits a screen.
  await page.goto("/jobs?perf=1000");
  await ready(page);

  // Compact 32px is where the surface starts (ADD-010), so the switch under
  // test is the one INTO comfortable. The direction is immaterial to the
  // anchoring maths and material to whether the switch happens at all: driving
  // it toward the current value would make this a no-op that always passes.
  const scroll = page.getByTestId("grid-scroll");
  await scroll.evaluate((el) => (el.scrollTop = 400 * 32));

  await page.getByRole("button", { name: "Display" }).click();
  await page.getByRole("radio", { name: "Comfortable" }).click();
  await page.keyboard.press("Escape");

  // The first visible row index survives the row-height change (±2 rows), so
  // the user is still looking at the same slice of the list…
  const anchored = await scroll.evaluate((el) => el.scrollTop / 40);
  expect(Math.abs(anchored - 400)).toBeLessThanOrEqual(2);

  // …and the viewport centre is painted rows, not virtualizer void.
  const centreIsRow = await page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return !!el?.closest('[role="row"]');
  });
  expect(centreIsRow, "the viewport centre shows no row after the density switch").toBe(true);
});
