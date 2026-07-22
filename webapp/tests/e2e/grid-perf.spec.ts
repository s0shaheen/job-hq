import { expect, test, type Page } from "@playwright/test";

/**
 * Matrix row 18 — "perf collapse at 5k rows" — replaced with measured budgets
 * (plan rows 25–27). Every number here is stated and justified, because "feels
 * fast" is not a regression test and a threshold nobody can defend gets
 * loosened the first time it fires.
 *
 * The dataset comes from `/jobs?perf=5000`: a demo-gated page hook that
 * substitutes `makePerfJobs(5000)` (deterministic, seeded, no Math.random) for
 * the data source. It is a query parameter rather than a get-source.ts store
 * hook because the rows are read-only — no store is needed — and the gate then
 * lives entirely inside the page that consumes it.
 */

const PERF_URL = "/jobs?perf=5000";

/**
 * DOM row bound: ceil(900px viewport / 32px rows) ≈ 28 visible + 2×10 overscan
 * + the header row, with ~1.6× headroom for partial rows at both edges. 5000
 * rows in the DOM — virtualization silently off — is 60× over this line.
 */
const ROW_DOM_BOUND = 80;

/**
 * Long-task ceiling during scroll: 200ms is the point where a held scroll
 * visibly hitches even on a forgiving eye (RAIL's 100ms budget doubled for the
 * 4× CPU throttle). One task over it across a 30-viewport scripted scroll
 * fails the test.
 */
const LONG_TASK_MS = 200;

/**
 * Client time-to-interactive at 5k rows, under 4× CPU throttle, measured from
 * responseEnd (so a slow CI network or server render cannot fail it — this
 * budget is about CLIENT work: parsing the ~2MB RSC payload and hydrating a
 * BOUNDED number of rows). Measured green: ~750ms on the dev Mac at 4×;
 * without virtualization the same path hydrates 5000×9 cells and never became
 * interactive inside the wait timeout at all (verified red). 6s is the green
 * measurement with ~8× headroom for slow CI runners.
 */
const CLIENT_READY_BUDGET_MS = 6000;

async function gotoPerf(page: Page) {
  await page.goto(PERF_URL);
  await expect(
    page.locator('[data-testid="jobs-grid"][data-ready="true"]'),
  ).toBeAttached();
}

/** Put the working set on the full 5000, and prove it. Navigates by URL rather
 *  than driving the switcher menu — how the perf harness reaches the "all" set
 *  is incidental to what it measures (virtualization and sticky at 5k rows),
 *  and a menu interaction over 5000 rows is a needless source of flake. */
async function openAllPostings(page: Page) {
  await page.goto(`${PERF_URL}&set=all`);
  await expect(
    page.locator('[data-testid="jobs-grid"][data-ready="true"]'),
  ).toBeAttached();
  await expect(page.locator('[role="grid"]')).toHaveAttribute("aria-rowcount", "5001");
}

async function scrollToFraction(page: Page, fraction: number) {
  await page.evaluate(async (f) => {
    const el = document.querySelector('[data-testid="grid-scroll"]') as HTMLElement;
    el.scrollTop = (el.scrollHeight - el.clientHeight) * f;
    // Two frames: one for the scroll handler, one for React's commit.
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );
  }, fraction);
}

test("row 25: the DOM holds a bounded number of rows at any scroll position", async ({
  page,
}) => {
  await gotoPerf(page);
  await openAllPostings(page);

  for (const fraction of [0, 0.5, 1]) {
    await scrollToFraction(page, fraction);
    const count = await page.locator('[role="row"]').count();
    // The lower bound is the anti-"cannot fail" guard: a grid that renders
    // NOTHING also satisfies "≤ 80 rows", and an empty grid must not pass a
    // virtualization test.
    expect(count, `no rows rendered at scroll ${fraction}`).toBeGreaterThan(10);
    expect(
      count,
      `${count} row elements in the DOM at scroll position ${fraction} — virtualization is off or leaking`,
    ).toBeLessThanOrEqual(ROW_DOM_BOUND);
  }

  // The bottom of the dataset is genuinely reachable — bounded DOM must not
  // mean bounded data.
  await expect(page.locator('[role="row"][aria-rowindex="5001"]')).toBeAttached();
});

test("row 26: interactive under budget and long-task-free scroll at 5k rows, 4× CPU throttle", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "budgets are calibrated for the desktop viewport; the mobile project exists for responsive regressions",
  );
  test.setTimeout(90_000);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

  await gotoPerf(page);
  await expect(page.locator('[role="row"][aria-rowindex="2"]')).toBeVisible();

  const clientMs = await page.evaluate(() => {
    const nav = performance.getEntriesByType(
      "navigation",
    )[0] as PerformanceNavigationTiming;
    return performance.now() - nav.responseEnd;
  });
  expect(
    clientMs,
    `client work (parse + hydrate) took ${Math.round(clientMs)}ms at 4× throttle — ` +
      `budget ${CLIENT_READY_BUDGET_MS}ms`,
  ).toBeLessThan(CLIENT_READY_BUDGET_MS);

  await openAllPostings(page);

  // Observe long tasks during the scroll only. The RSC parse at load time is
  // covered by the budget above; folding it into this buffer would make the
  // assertion fail on network shape rather than on render work.
  await page.evaluate(() => {
    (window as unknown as { __longTasks: number[] }).__longTasks = [];
    new PerformanceObserver((list) => {
      (window as unknown as { __longTasks: number[] }).__longTasks.push(
        ...list.getEntries().map((e) => e.duration),
      );
    }).observe({ type: "longtask" });
  });

  await page.evaluate(async () => {
    const el = document.querySelector('[data-testid="grid-scroll"]') as HTMLElement;
    const frame = () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      );
    for (let i = 0; i < 30; i++) {
      el.scrollTop += el.clientHeight;
      await frame();
    }
  });

  const longTasks = await page.evaluate(
    () => (window as unknown as { __longTasks: number[] }).__longTasks,
  );
  const over = longTasks.filter((d) => d > LONG_TASK_MS);
  expect(
    over,
    `tasks over ${LONG_TASK_MS}ms during a 30-viewport scroll: ` +
      over.map((d) => `${Math.round(d)}ms`).join(", "),
  ).toEqual([]);

  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
});

test("row 27: sticky header and first column hold under diagonal scroll, columns aligned", async ({
  page,
}) => {
  await gotoPerf(page);
  await openAllPostings(page);

  await page.evaluate(async () => {
    const el = document.querySelector('[data-testid="grid-scroll"]') as HTMLElement;
    el.scrollLeft = 240;
    el.scrollTop = 4000;
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );
  });

  const geom = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="grid-scroll"]') as HTMLElement;
    const c = el.getBoundingClientRect();
    const header = document
      .querySelector('[role="row"][aria-rowindex="1"]')!
      .getBoundingClientRect();
    const headCompany = document
      .querySelector('[role="columnheader"][data-col="company"]')!
      .getBoundingClientRect();
    const bodyRows = Array.from(
      document.querySelectorAll('[role="row"]:not([aria-rowindex="1"])'),
    );
    const probe = bodyRows[Math.floor(bodyRows.length / 2)];
    const bodyCompany = probe
      .querySelector('[data-col="company"]')!
      .getBoundingClientRect();
    const headers = Array.from(
      document.querySelectorAll('[role="columnheader"]'),
    ).map((h) => ({
      col: (h as HTMLElement).dataset.col ?? "",
      x: h.getBoundingClientRect().x,
    }));
    const cells = Array.from(probe.querySelectorAll('[role="gridcell"]')).map(
      (cell) => ({
        col: (cell as HTMLElement).dataset.col ?? "",
        x: cell.getBoundingClientRect().x,
      }),
    );
    return {
      containerTop: c.top,
      containerLeft: c.left,
      headerTop: header.top,
      headCompanyX: headCompany.x,
      bodyCompanyX: bodyCompany.x,
      headers,
      cells,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    };
  });

  // The scroll genuinely happened — a container that ignored it would pass
  // every sticky assertion vacuously.
  expect(geom.scrollTop).toBe(4000);
  expect(geom.scrollLeft).toBeGreaterThanOrEqual(200);

  // Header pinned vertically; company column pinned horizontally, in both the
  // header and the body.
  expect(Math.abs(geom.headerTop - geom.containerTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(geom.headCompanyX - geom.containerLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(geom.bodyCompanyX - geom.containerLeft)).toBeLessThanOrEqual(1);

  // Every header edge lines up with its body-cell edge within 1px — a header
  // that drifts from its column is the same bug as one that scrolls away.
  for (const h of geom.headers) {
    const cell = geom.cells.find((cl) => cl.col === h.col);
    expect(cell, `no body cell for column ${h.col}`).toBeTruthy();
    expect(
      Math.abs(h.x - cell!.x),
      `column ${h.col}: header at x=${h.x}, cells at x=${cell!.x}`,
    ).toBeLessThanOrEqual(1);
  }
});
