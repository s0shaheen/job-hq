import { expect, test } from "@playwright/test";

/**
 * Visual regression. A pixel diff beyond the tolerance fails the run — this is
 * what turns "the UI looks off" from an opinion into a build failure.
 *
 * Snapshots are PLATFORM-SPECIFIC: macOS and Linux rasterise fonts
 * differently, so a baseline captured on a laptop is guaranteed to fail on a
 * CI runner. Until Linux baselines are committed (one `--update-snapshots` run
 * ON a runner), these are opt-in via PLAYWRIGHT_VISUAL=1 rather than shipped
 * as a permanently red check — a check that always fails teaches everyone to
 * ignore checks.
 */
test.skip(
  !!process.env.CI && !process.env.PLAYWRIGHT_VISUAL,
  "Linux baselines not committed yet — run with PLAYWRIGHT_VISUAL=1 to record",
);
test.beforeEach(async ({ page, context }) => {
  await page.clock.setFixedTime(new Date("2026-07-21T15:00:00.000Z"));
  await context.addCookies([
    { name: "hq_demo_id", value: "visual-baseline", url: "http://127.0.0.1:3210" },
  ]);
});

for (const theme of ["light", "dark"] as const) {
  test(`queue looks right — ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/queue");
    // Shortcut hints render dim until the keyboard handler attaches, so a
    // snapshot taken mid-hydration would differ from one taken after it.
    await expect(page.locator('[data-testid="triage"][data-ready="true"]')).toBeAttached();
    await page.waitForLoadState("load");
    await expect(page).toHaveScreenshot(`queue-${theme}.png`, { fullPage: true });
  });
}
