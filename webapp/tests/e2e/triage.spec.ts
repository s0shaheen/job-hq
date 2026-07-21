import { expect, test } from "@playwright/test";

/** Pin the clock so relative dates — and therefore snapshots — never drift. */
const FIXTURE_NOW = new Date("2026-07-21T15:00:00.000Z");

test.beforeEach(async ({ page, context }) => {
  await page.clock.setFixedTime(FIXTURE_NOW);
  // Each test gets its own demo store, so draining the queue in one test
  // cannot empty it for another running in parallel.
  await context.addCookies([
    {
      name: "hq_demo_id",
      value: `t-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      url: "http://127.0.0.1:3210",
    },
  ]);
});

/**
 * Navigate and wait until the queue is genuinely interactive.
 *
 * `goto` resolves when the server HTML has painted, which is BEFORE the
 * keydown listener exists. Pressing a key in that window does nothing, and the
 * test fails intermittently on whichever machine is slowest that day — which
 * is exactly how this surfaced (green on a Mac, red on a CI runner). Waiting
 * on the app's own readiness flag removes the race instead of hiding it behind
 * a sleep.
 */
async function gotoQueue(page: import("@playwright/test").Page) {
  await page.goto("/queue");
  await expect(page.locator('[data-testid="triage"][data-ready="true"]')).toBeAttached();
}

test("the four decision facts are visible without any interaction", async ({ page }) => {
  // This is the whole point of the surface: half of the owner's shortlisted
  // roles were abandoned because comp/YoE/location were not read. If any of
  // these needs a click, the design has regressed.
  await gotoQueue(page);
  const card = page.locator("article").first();
  await expect(card).toBeVisible();
  for (const label of ["Comp", "Min YoE", "Work model", "Location"]) {
    await expect(card.getByText(label, { exact: true })).toBeVisible();
  }
});

test("an unstated value reads 'Not listed' rather than being hidden", async ({ page }) => {
  await gotoQueue(page);
  // walk the queue until the fixture with no compensation is in front of us
  for (let i = 0; i < 12; i++) {
    const card = page.locator("article").first();
    if (await card.getByText("Not listed").first().isVisible().catch(() => false)) {
      await expect(card.getByText("Not listed").first()).toBeVisible();
      return;
    }
    await page.keyboard.press("x");
    await page.waitForTimeout(120);
  }
  throw new Error("never encountered the no-compensation fixture");
});

test("keyboard triage advances the queue and can be undone", async ({ page }) => {
  await gotoQueue(page);
  const first = await page.locator("article h3").first().innerText();

  await page.keyboard.press("i");
  await expect(page.getByText(/^Saved /)).toBeVisible();
  await expect(page.locator("article h3").first()).not.toHaveText(first);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator("article h3").first()).toHaveText(first);
});

test("passing on a role removes it and the count moves", async ({ page }) => {
  await gotoQueue(page);
  const progress = page.getByTestId("progress");
  const before = await progress.innerText();
  await page.getByTestId("pass").click();
  await expect(progress).not.toHaveText(before);
});

test("the queue reaches a finished state rather than trailing off", async ({ page }) => {
  await gotoQueue(page);
  for (let i = 0; i < 25; i++) {
    if (await page.getByRole("heading", { name: /Triaged all|Nothing found yet/ }).isVisible().catch(() => false)) break;
    await page.keyboard.press("x");
    await page.waitForTimeout(90);
  }
  await expect(page.getByRole("heading", { name: /Triaged all|Nothing found yet/ })).toBeVisible();
});
