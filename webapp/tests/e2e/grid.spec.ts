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
  "Affirm", // status = Closed (criterion 16 — qualified, undecided, delisted)
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
  // Affirm in this list is acceptance criterion 16: JobView.status carries the
  // board lifecycle since the Closed-posting fix, and the Affirm fixture is
  // qualified + undecided so ONLY the status clause can exclude it — the
  // assertion has something real to fail on.
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

  // Set is chosen via the view switcher (the standalone toggle was removed).
  await page.getByTestId("view-switcher").click();
  await page.getByRole("menuitemradio", { name: "All postings" }).click();

  await expect(page.getByTestId("grid-count")).toContainText(`All ${TOTAL}`);
  await expect(page.locator('[role="grid"]')).toHaveAttribute("aria-rowcount", String(TOTAL + 1));
  await expect(page.locator('[role="columnheader"][data-col="why"]')).toHaveCount(1);

  // A filtered row is present AND explains itself in plain English — the
  // machine token "geo:United Kingdom" teaches the reader nothing.
  const wiseRow = page
    .locator('[role="row"]')
    .filter({ has: companyCell(page, "Wise") });
  await expect(wiseRow.locator('[data-col="why"]')).toHaveText(
    "Location is United Kingdom, outside your area",
  );
});

test("a value the posting never stated reads Not listed, never an invention", async ({
  page,
}) => {
  await gotoJobs(page);

  // Chime states no compensation; Mercury states no years. Zero, an empty
  // cell, or an invented midpoint would all misrepresent the posting.
  const chimeRow = page.locator('[role="row"]').filter({ has: companyCell(page, "Chime") });
  await expect(chimeRow.locator('[data-col="comp"]')).toHaveText("Not listed");

  const mercuryRow = page
    .locator('[role="row"]')
    .filter({ has: companyCell(page, "Mercury") });
  await expect(mercuryRow.locator('[data-col="minYoe"]')).toHaveText("Not listed");
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
  await expect(link).toHaveAttribute("href", "https://boards.greenhouse.io/northwesternmutualinvestmentservices/jobs/9920117");
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

// ---------------------------------------------------------------------------
// G2: the filter bar, sort headers, and grouping. URL round-trip mechanics
// live in grid-url.spec.ts; these assert the SEMANTICS against the fixtures.
// ---------------------------------------------------------------------------

/** Queue rows, the client predicate's mirror — derived, not hardcoded. */
const QUEUE_ROWS = FIXTURE_JOBS.filter(
  (j) =>
    j.disposition === "qualified" &&
    j.triage === "" &&
    (j.status ?? "").trim().toLowerCase() !== "closed",
);

test("the clause builder writes a chip, the chip filters the rows, removing it restores them", async ({
  page,
}) => {
  await gotoJobs(page);

  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByLabel("Filter field").selectOption("workModel");
  await page.getByRole("checkbox", { name: "Remote (US)" }).check();
  await page.getByRole("button", { name: "Add filter" }).click();

  const expected = QUEUE_ROWS.filter(
    (j) => (j.workModel ?? "").toLowerCase() === "remote (us)",
  );
  await expect(page.getByTestId("filter-chip")).toHaveText(/Work model: Remote \(US\)/);
  await expect(page.locator('[role="gridcell"][data-col="company"]')).toHaveText(
    expected.map((j) => j.company),
  );
  await expect(page.getByTestId("grid-count")).toContainText(
    `${expected.length} of ${QUEUE_ROWS.length}`,
  );

  await page.getByRole("button", { name: /^Remove filter/ }).click();
  await expect(page.getByTestId("filter-chip")).toHaveCount(0);
  await expect(page.getByTestId("grid-count")).toContainText(`${QUEUED} of ${TOTAL}`);
});

test("a comp filter keeps unknown-comp rows and SAYS so; excluding them is an explicit clause (G16)", async ({
  page,
}) => {
  await page.goto("/jobs?set=all");
  await expect(
    page.locator('[data-testid="jobs-grid"][data-ready="true"]'),
  ).toBeAttached();

  const unknown = FIXTURE_JOBS.filter((j) => j.compMaxK === null);
  expect(unknown.length).toBeGreaterThan(1); // incl. Wise's unparseable £ band

  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByLabel("Filter field").selectOption("compMax");
  await page.getByLabel("Filter value").fill("150");
  await page.getByRole("button", { name: "Add filter" }).click();

  // The chip states the keep-rule instead of hiding it.
  await expect(page.getByTestId("filter-chip")).toContainText("Pay above $150k");
  await expect(page.getByTestId("filter-chip")).toContainText(
    `plus ${unknown.length} with pay not listed`,
  );

  // Unknowns present, honestly-below-floor rows gone.
  await expect(companyCell(page, "Chime")).toHaveCount(1); // nothing stated
  await expect(companyCell(page, "Wise")).toHaveCount(1); // "£85,000 - £110,000"
  await expect(companyCell(page, "Retool")).toHaveCount(0); // $115k top

  // Excluding unknowns = a second, visible clause — and it only drops rows
  // that stated NOTHING. Wise stated a band (in pounds); it stays. That is
  // G16's sentence verbatim: a comp filter never silently drops "£90k".
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByLabel("Filter field").selectOption("compMax");
  await page.getByLabel("Filter operator").selectOption("stated");
  await page.getByRole("button", { name: "Add filter" }).click();

  await expect(page.getByTestId("filter-chip").nth(1)).toHaveText(/Pay listed/);
  await expect(companyCell(page, "Chime")).toHaveCount(0);
  await expect(companyCell(page, "Microsoft")).toHaveCount(0);
  await expect(companyCell(page, "Wise")).toHaveCount(1);
});

test("sort headers cycle asc → desc → off, and unknowns never crown the list", async ({
  page,
}) => {
  await gotoJobs(page);
  const cells = page.locator('[role="gridcell"][data-col="company"]');
  const stated = QUEUE_ROWS.filter((j) => j.compMaxK !== null);
  const unknown = QUEUE_ROWS.filter((j) => j.compMaxK === null);
  expect(unknown.length).toBeGreaterThan(0); // Chime — or this test proves nothing

  const compHeader = page.locator('[role="columnheader"][data-col="comp"]');
  const sortComp = page.getByRole("button", { name: "Pay", exact: true });

  await sortComp.click();
  await expect(compHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(cells).toHaveText([
    ...[...stated].sort((a, b) => a.compMaxK! - b.compMaxK!).map((j) => j.company),
    ...unknown.map((j) => j.company),
  ]);

  await sortComp.click();
  await expect(compHeader).toHaveAttribute("aria-sort", "descending");
  await expect(cells).toHaveText([
    ...[...stated].sort((a, b) => b.compMaxK! - a.compMaxK!).map((j) => j.company),
    ...unknown.map((j) => j.company), // STILL last — "no comp" is not "$0"
  ]);

  await sortComp.click();
  await expect(page).not.toHaveURL(/sort=/);
  await expect(cells).toHaveText(QUEUE_ROWS.map((j) => j.company)); // source order
});

test("grouping by company pulls rows together under labelled, counted headers", async ({
  page,
}, testInfo) => {
  // The Group select is desktop chrome (the phone bar has no room for a
  // fourth control at rest), but the STATE must work everywhere — so the
  // mobile project arrives by deep link, which is the contract anyway.
  if (testInfo.project.name === "mobile") {
    await page.goto("/jobs?group=company");
    await expect(
      page.locator('[data-testid="jobs-grid"][data-ready="true"]'),
    ).toBeAttached();
  } else {
    await gotoJobs(page);
    await page.getByLabel("Group rows").selectOption("company");
    await expect(page).toHaveURL(/group=company/);
  }

  // The queue set on purpose: group headers + rows all fit one viewport, so
  // every header is genuinely in the DOM. The all set has more display rows
  // than the virtualizer renders, and a count assertion against it fails
  // about the virtualization working, not about grouping being broken.
  const companies = [...new Set(rowsForSet(FIXTURE_JOBS, "queue").map((j) => j.company))];
  await expect(page.getByTestId("group-header")).toHaveCount(companies.length);
  await expect(page.getByTestId("group-header").first()).toContainText(companies[0]);
  // header row + one group row per company + every job row
  await expect(page.locator('[role="grid"]')).toHaveAttribute(
    "aria-rowcount",
    String(1 + companies.length + QUEUED),
  );
  await expect(page.locator('[role="gridcell"][data-col="company"]')).toHaveCount(QUEUED);
});

test("a filter that matches nothing says so and offers one-click clear — distinct from profile gating", async ({
  page,
}) => {
  await gotoJobs(page);

  const search = page.getByLabel("Quick search");
  await search.click();
  await search.pressSequentially("zzz-no-such-posting");

  const empty = page.getByTestId("empty-state");
  await expect(empty).toContainText("Nothing matches these filters");
  // NOT the profile-gated copy — those are different situations with
  // different fixes, and showing the wrong one sends the user to settings
  // to undo their own quick search.
  await expect(empty).not.toContainText("filtered out or already decided");

  await empty.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).not.toHaveURL(/q=/);
  await expect(page.getByTestId("grid-count")).toContainText(`${QUEUED} of ${TOTAL}`);
  await expect(page.locator('[role="gridcell"][data-col="company"]')).toHaveCount(QUEUED);
});

// ---------------------------------------------------------------------------
// G3: the why-filtered popover and the display controls. Saved-view flows live
// in grid-views.spec.ts; these assert the popover's deep link (plan §6) and
// that density/type/hints are real display state, persisted via a view.
// ---------------------------------------------------------------------------

/** The all-set's display order — byFreshness, the same order jobs() serves.
 *  Derived inline (never by importing the source under test). */
const ALL_SORTED = [...FIXTURE_JOBS].sort(
  (a, b) =>
    (b.firstSeen ?? "").localeCompare(a.firstSeen ?? "") ||
    (a.key < b.key ? 1 : a.key > b.key ? -1 : 0),
);

test("the Why chip opens a popover that names the binding setting and deep-links it", async ({
  page,
}) => {
  await page.goto("/jobs?set=all");
  await expect(
    page.locator('[data-testid="jobs-grid"][data-ready="true"]'),
  ).toBeAttached();

  // The spec's own example: Microsoft, filtered geo:India → countries.
  const msRow = page.locator('[role="row"]').filter({ has: companyCell(page, "Microsoft") });
  await msRow.locator('[data-col="why"] button').click();

  const popover = page.getByTestId("why-popover");
  await expect(popover).toContainText("Location is India, outside your area");
  const change = popover.getByRole("link", { name: /Change your countries/ });
  await expect(change).toHaveAttribute("href", "/settings#countries");

  // The affordance must never 404: the link lands on a real anchored section.
  await change.click();
  await page.waitForURL(/\/settings#countries/);
  await expect(page.locator("#countries")).toBeVisible();
  await expect(page.locator("#countries h2")).toHaveText("Countries");
});

test("? opens the why popover on the active row — and typing in an input never does", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "keyboard-only affordance");
  await page.goto("/jobs?set=all");
  await expect(
    page.locator('[data-testid="jobs-grid"][data-ready="true"]'),
  ).toBeAttached();

  // With no cursor yet, ? answers for the first row. The fixture's freshest
  // row is the needs-info one — its "why" has no setting to link.
  await page.keyboard.press("?");
  const popover = page.getByTestId("why-popover");
  await expect(popover).toContainText(
    ALL_SORTED[0].disposition === "needs-info"
      ? "Checking details. This one is classified shortly"
      : /./,
  );
  await expect(popover.getByRole("link")).toHaveCount(
    ALL_SORTED[0].disposition === "needs-info" ? 0 : 1,
  );
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);

  // Walk the cursor to the geo:India row and ask again. The ? above already
  // parked the cursor on row 0, so index N is exactly N presses away.
  const msIdx = ALL_SORTED.findIndex((j) => j.company === "Microsoft");
  expect(msIdx).toBeGreaterThan(0);
  for (let i = 0; i < msIdx; i++) await page.keyboard.press("j");
  await expect(page.locator('[role="row"][data-active="true"]')).toHaveCount(1);
  await page.keyboard.press("?");
  await expect(popover).toContainText("Location is India, outside your area");
  await expect(popover.getByRole("link", { name: /Change your countries/ })).toHaveAttribute(
    "href",
    "/settings#countries",
  );
  await page.keyboard.press("Escape");

  // The guard: grid shortcuts must never fire from a text input. "j" and "?"
  // typed into quick search are text, not commands.
  const search = page.getByLabel("Quick search");
  await search.click();
  await search.pressSequentially("j?");
  await expect(popover).toHaveCount(0);
  await expect(search).toHaveValue("j?");
});

test("density, type scale and hints are per-view display state that survives Save + reload", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the switcher is desktop chrome");
  await page.goto("/jobs");
  await expect(
    page.locator('[data-testid="jobs-grid"][data-ready="true"]'),
  ).toBeAttached();

  const firstRow = page.locator('[role="row"][aria-rowindex="2"]');
  const rowHeight = async () => (await firstRow.boundingBox())?.height ?? 0;
  const cellFont = () =>
    page
      .locator('[role="gridcell"][data-col="company"]')
      .first()
      .evaluate((el) => getComputedStyle(el).fontSize);

  // The owner's defaults: dense 32px rows, 13px type, hints on.
  expect(await rowHeight()).toBeLessThanOrEqual(33);
  await expect(page.getByTestId("grid-hints")).toBeVisible();

  const switcherBtn = page.getByTestId("view-switcher");
  await switcherBtn.click();
  await page.getByRole("menuitemradio", { name: "Comfortable" }).click();
  await page.getByRole("menuitemradio", { name: "Large type" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Keyboard hints" }).click();
  await page.keyboard.press("Escape");

  await expect.poll(rowHeight).toBeGreaterThan(40);
  expect(await cellFont()).toBe("16px");
  await expect(page.getByTestId("grid-hints")).toHaveCount(0);
  await expect(switcherBtn).toHaveAttribute("data-edited", "true");

  // Display prefs are not URL state — they persist through the SAVED VIEW.
  await switcherBtn.click();
  await page.getByRole("menuitem", { name: /Save as/ }).click();
  await page.getByLabel("View name").fill("Comfy");
  await page.getByRole("button", { name: "Save view" }).click();
  await expect(page).toHaveURL(/\/jobs\?view=/);

  await page.reload();
  await expect(
    page.locator('[data-testid="jobs-grid"][data-ready="true"]'),
  ).toBeAttached();
  await expect.poll(rowHeight).toBeGreaterThan(40);
  expect(await cellFont()).toBe("16px");
  await expect(page.getByTestId("grid-hints")).toHaveCount(0);

  // …and they are per-view: back on the plain Queue preset, the defaults hold.
  await switcherBtn.click();
  await page.getByRole("menuitemradio", { name: "Queue" }).click();
  await expect.poll(rowHeight).toBeLessThanOrEqual(33);
  await expect(page.getByTestId("grid-hints")).toBeVisible();
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
  await expect(page.getByTestId("grid-count")).toContainText("All 6");
});
