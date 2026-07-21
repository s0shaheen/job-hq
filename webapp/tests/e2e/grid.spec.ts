import { expect, test, type Page } from "@playwright/test";
import { collectPaintedOverflow, describeOffenders } from "./painted-overflow";
import { FIXTURE_JOBS } from "@/lib/data/fixtures";
import { rowsForSet } from "@/lib/grid/presets";

// Derived, never hardcoded. These numbers moved the moment a Closed posting
// was added to the fixture set, and a literal would have failed as though the
// grid had broken rather than as though the data had grown.
const TOTAL = FIXTURE_JOBS.length;
const QUEUED = rowsForSet(FIXTURE_JOBS, "queue").length;

/** Pin the clock so relative dates — and therefore snapshots — never drift. */
const FIXTURE_NOW = new Date("2026-07-21T15:00:00.000Z");

/**
 * The G1 grid: read-only, virtualized, honest about its working set.
 *
 * The honesty part is load-bearing. A grid that silently shows a subset is the
 * queue's "filtered-out reads as nothing-found" bug wearing a new surface, so
 * these tests assert the visible SET and its stated counts, not just that rows
 * render.
 */

/** The fixture rows the Queue set must show: qualified AND undecided. */
const QUEUE_COMPANIES = [
  "Ramp",
  "Plaid",
  "Chime",
  "Northwestern Mutual Investment Services",
  "Mercury",
  "Brex",
  "Modern Treasury",
  "Vanta",
];

/** One excluded fixture per category, so a predicate regression names itself. */
const EXCLUDED_FROM_QUEUE = [
  "Stripe", // triage = interested
  "Notion", // triage = dismissed
  "Figma", // triage = snoozed
  "Wise", // disposition = filtered (geo)
  "Retool", // disposition = filtered (comp)
  "Fifth Third Bank", // disposition = needs-info
];

test.beforeEach(async ({ page, context }) => {
  await page.clock.setFixedTime(FIXTURE_NOW);
  // Each test gets its own demo store; the grid is read-only, but tests in
  // OTHER files triage rows, and sharing the default store with them would
  // make these counts depend on scheduling order.
  await context.addCookies([
    {
      name: "hq_demo_id",
      value: `g-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      url: "http://127.0.0.1:3210",
    },
  ]);
});

async function gotoJobs(page: Page) {
  await page.goto("/jobs");
  await expect(
    page.locator('[data-testid="jobs-grid"][data-ready="true"]'),
  ).toBeAttached();
}

function companyCell(page: Page, company: string) {
  return page
    .locator('[role="gridcell"][data-col="company"]')
    .filter({ hasText: new RegExp(`^${company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
}

test("the Queue set shows qualified, undecided rows only — and states its counts", async ({
  page,
}) => {
  await gotoJobs(page);

  // The stated count is the honesty contract: which set, and how big it is
  // relative to everything: "N of TOTAL" cannot silently become "N of N".
  await expect(page.getByTestId("grid-count")).toContainText(`${QUEUED} of ${TOTAL}`);
  // +1: aria-rowcount counts the header row too, per the ARIA spec.
  await expect(page.locator('[role="grid"]')).toHaveAttribute("aria-rowcount", String(QUEUED + 1));

  for (const company of QUEUE_COMPANIES) {
    await expect(companyCell(page, company)).toHaveCount(1);
  }
  // Acceptance criterion 16 wants Closed postings excluded too. JobView carries
  // no posting status today, so the client-side predicate cannot see "Closed"
  // and no fixture models it — the exclusion happens only in the Supabase
  // queue() query. Asserting it here would be a test that cannot fail; the gap
  // is reported instead of papered over.
  for (const company of EXCLUDED_FROM_QUEUE) {
    await expect(companyCell(page, company)).toHaveCount(0);
  }
});

test("All postings shows every row, with the reason a row is not queued", async ({
  page,
}) => {
  await gotoJobs(page);

  // The Why column is an All-postings concern: in the Queue set every row
  // qualifies and a column of "—" would be decoration.
  await expect(page.locator('[role="columnheader"][data-col="why"]')).toHaveCount(0);

  await page.getByRole("button", { name: "All postings" }).click();

  await expect(page.getByTestId("grid-count")).toContainText(`all ${TOTAL}`);
  await expect(page.locator('[role="grid"]')).toHaveAttribute("aria-rowcount", String(TOTAL + 1));
  await expect(page.locator('[role="columnheader"][data-col="why"]')).toHaveCount(1);

  // A filtered row is present AND explains itself in plain English — the
  // machine token "geo:United Kingdom" teaches the reader nothing.
  const wiseRow = page
    .locator('[role="row"]')
    .filter({ has: companyCell(page, "Wise") });
  await expect(wiseRow.locator('[data-col="why"]')).toHaveText(
    "Located in United Kingdom, outside your countries",
  );
});

test("a value the posting never stated renders as a dash, never an invention", async ({
  page,
}) => {
  await gotoJobs(page);

  // Chime states no compensation; Mercury states no years. Zero, an empty
  // cell, or an invented midpoint would all misrepresent the posting.
  const chimeRow = page.locator('[role="row"]').filter({ has: companyCell(page, "Chime") });
  await expect(chimeRow.locator('[data-col="comp"]')).toHaveText("—");

  const mercuryRow = page
    .locator('[role="row"]')
    .filter({ has: companyCell(page, "Mercury") });
  await expect(mercuryRow.locator('[data-col="minYoe"]')).toHaveText("—");
});

test("the long fixture row stays one row tall and keeps its full text reachable", async ({
  page,
}) => {
  await gotoJobs(page);

  const longTitle =
    "Senior Product Manager, Enterprise Data Platform & Reporting Infrastructure";
  const row = page
    .locator('[role="row"]')
    .filter({ has: companyCell(page, "Northwestern Mutual Investment Services") });
  await expect(row).toHaveCount(1);

  // Fixed 32px rows are what make virtualization exact; a wrapped title would
  // silently break the scroll math for every row below it.
  const box = await row.boundingBox();
  expect(box, "row has no box").not.toBeNull();
  expect(box!.height).toBeLessThanOrEqual(33);

  // Truncation may hide pixels but never data: the full string rides on
  // title= (hover) and the link still opens the posting.
  const link = row.locator('[data-col="title"] a');
  await expect(link).toHaveAttribute("title", longTitle);
  await expect(link).toHaveAttribute("href", "https://example.com/jobs/greenhouse-9920117");
  await expect(link).toHaveAttribute("rel", /noopener/);
});

test.describe("the grid, not the page, absorbs the horizontal overflow", () => {
  // 280px is below the layout suite's narrowest width on purpose: a grid is
  // the widest thing this app will ever render, so it gets a harsher check.
  for (const width of [280, 375]) {
    test(`@ ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await gotoJobs(page);

      const offenders = await page.evaluate(collectPaintedOverflow);
      expect(offenders, describeOffenders(offenders)).toEqual([]);

      // The columns genuinely do not fit at this width, so the container must
      // be the one scrolling. If it is not scrollable here, the content was
      // clipped or the columns collapsed — both hide data.
      const scrolls = await page
        .locator('[data-testid="grid-scroll"]')
        .evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(scrolls, "the grid container has nothing to scroll — where did the columns go?").toBe(
        true,
      );
    });
  }
});

test("the scroll region is reachable by keyboard and scrolls", async ({ page }) => {
  // The fixture set fits a desktop viewport with no vertical overflow,
  // so "PageDown moved scrollTop" is unfalsifiable against it — there is
  // nothing to move. 200 perf rows guarantee real overflow to scroll.
  await page.goto("/jobs?perf=200");
  await expect(
    page.locator('[data-testid="jobs-grid"][data-ready="true"]'),
  ).toBeAttached();

  // A scrollable box nobody can focus is invisible to a keyboard user — the
  // pipeline table learned this from axe; the grid asserts it directly.
  let reached = false;
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.dataset?.testid ?? "",
    );
    if (id === "grid-scroll") {
      reached = true;
      break;
    }
  }
  expect(reached, "tabbing never reached the grid scroll region").toBe(true);

  await page.keyboard.press("PageDown");
  await expect
    .poll(
      () =>
        page
          .locator('[data-testid="grid-scroll"]')
          .evaluate((el) => el.scrollTop),
      { message: "PageDown did not scroll the focused grid region" },
    )
    .toBeGreaterThan(0);
});

test("the skeleton and the loaded grid put the header rail in the same place", async ({
  page,
}) => {
  // Matrix row 7's lesson, applied to this surface before it can repeat: the
  // queue's skeleton omitted the page header and everything jumped 69px when
  // data landed. The skeleton paints on CLIENT-side navigation, so this
  // navigates from another page with the /jobs payload held back.
  await page.goto("/pipeline");
  await expect(
    page.locator('[data-testid="export-open"][data-ready="true"]'),
  ).toBeAttached();

  await page.route(/\/jobs/, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });

  await page.getByRole("link", { name: "Jobs" }).click();
  await page
    .locator('[data-testid="jobs-skeleton"]')
    .waitFor({ state: "attached", timeout: 10_000 });

  const skeletonHasPageHeader = await page.evaluate(
    () => !!document.querySelector('[data-testid="jobs-skeleton"] header'),
  );
  expect(skeletonHasPageHeader, "the skeleton omits the page header").toBe(true);

  const skeletonRailTop = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="jobs-skeleton-colheads"]');
    return el ? Math.round(el.getBoundingClientRect().top) : -1;
  });
  expect(skeletonRailTop, "no column-header rail in the skeleton").toBeGreaterThan(0);

  await page.unroute(/\/jobs/);
  await expect(
    page.locator('[data-testid="jobs-grid"][data-ready="true"]'),
  ).toBeAttached();

  const loadedRailTop = await page.evaluate(() => {
    const el = document.querySelector('[role="row"][aria-rowindex="1"]');
    return el ? Math.round(el.getBoundingClientRect().top) : -1;
  });
  expect(loadedRailTop).toBeGreaterThan(0);

  expect(
    Math.abs(loadedRailTop - skeletonRailTop),
    `the column-header rail moved ${loadedRailTop - skeletonRailTop}px when data landed ` +
      `(skeleton ${skeletonRailTop}, loaded ${loadedRailTop})`,
  ).toBeLessThanOrEqual(8);
});

test("with nothing found at all, the grid says so instead of rendering a bare header", async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: "hq_demo_seed", value: "empty", url: "http://127.0.0.1:3210" },
  ]);
  await gotoJobs(page);
  await expect(page.getByTestId("empty-state")).toContainText("No postings yet");
});

test("when the profile filtered everything, the Queue set points at All postings", async ({
  page,
  context,
}) => {
  // The filtered seed: postings exist, every one gated out. "Nothing here"
  // with no route to the evidence is how a working system reads as dead.
  await context.addCookies([
    { name: "hq_demo_seed", value: "filtered", url: "http://127.0.0.1:3210" },
  ]);
  await gotoJobs(page);

  await expect(page.getByTestId("empty-state")).toContainText("filtered out or already decided");
  await page.getByRole("button", { name: "Show all postings" }).click();

  await expect(page.locator('[role="grid"]')).toHaveAttribute("aria-rowcount", "7");
  await expect(page.getByTestId("grid-count")).toContainText("all 6");
});
