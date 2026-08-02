import { expect, test } from "@playwright/test";

/**
 * Matrix row 7 — "loading.tsx skeleton with the same dimensions as the real
 * card (no layout shift)".
 *
 * That row was ticked with the component itself named as its enforcement, and
 * no test anywhere referenced `loading.tsx`. It was the third ticked row found
 * that could not fail, and its claim was measurably false: the skeleton drew
 * only the card while the page draws a header above it, so everything jumped
 * down ~69px when data landed.
 *
 * This measures the skeleton against the loaded page and fails on a difference.
 */

const FIXTURE_NOW = new Date("2026-07-21T15:00:00.000Z");

/** Where the first card's top edge sits — the thing that visibly jumps. */
async function firstCardTop(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector("article, .rounded-lg.border");
    return el ? Math.round(el.getBoundingClientRect().top) : -1;
  });
}

test("the skeleton and the loaded page put content in the same place", async ({
  page,
  context,
}) => {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await context.addCookies([
    { name: "hq_demo_id", value: `load-${Date.now()}`, url: "http://127.0.0.1:3210" },
  ]);

  // `loading.tsx` is a Suspense fallback, so it paints on a CLIENT-SIDE
  // navigation — which is how a user reaches the queue from anywhere else in
  // the app. Delaying the document request instead just delays everything and
  // shows no skeleton at all.
  await page.goto("/pipeline");
  await expect(page.locator('[data-testid="export-open"][data-ready="true"]')).toBeAttached();

  // Hold the RSC payload long enough to photograph the skeleton.
  await page.route(/\/queue/, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });

  await page.getByRole("link", { name: "Today" }).click();
  await page.locator('[aria-busy="true"]').first().waitFor({ state: "attached", timeout: 10_000 });

  const skeletonTop = await page.evaluate(() => {
    const el = document.querySelector('[aria-busy="true"] .rounded-lg.border');
    return el ? Math.round(el.getBoundingClientRect().top) : -1;
  });
  expect(skeletonTop, "no skeleton card was rendered").toBeGreaterThan(0);

  // Header presence is the half that was missing entirely.
  const skeletonHasHeader = await page.evaluate(
    () => !!document.querySelector('[aria-busy="true"] header'),
  );
  expect(skeletonHasHeader, "the skeleton omits the page header").toBe(true);

  await page.unroute(/\/queue/);
  await expect(page.locator('[data-testid="triage"][data-ready="true"]')).toBeAttached();

  const loadedTop = await firstCardTop(page);
  expect(loadedTop).toBeGreaterThan(0);

  // A few pixels of tolerance for sub-pixel line-box rounding; 69 is a jump.
  expect(
    Math.abs(loadedTop - skeletonTop),
    `content moved ${loadedTop - skeletonTop}px when data landed ` +
      `(skeleton ${skeletonTop}, loaded ${loadedTop})`,
  ).toBeLessThanOrEqual(8);
});
