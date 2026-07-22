import { expect, test } from "@playwright/test";

/**
 * Visual regression. A pixel diff beyond the tolerance fails the run — this is
 * what turns "the UI looks off" from an opinion into a build failure, which is
 * the owner's number-one fear answered as a backstop for the drift the other
 * matrix rows did not think to assert.
 *
 * Snapshots are PLATFORM-SPECIFIC: macOS and Linux rasterise fonts differently,
 * so a Mac baseline is guaranteed to fail on Linux. The answer is to record and
 * check in ONE environment — the official Playwright container
 * (mcr.microsoft.com/playwright:v1.61.1-noble). The `visual` CI job runs inside
 * that exact image, and the committed `-linux` baselines were recorded inside
 * it too (webapp/README documents the one command). So this is no longer
 * opt-in: it runs on every CI run, against baselines rendered by the same fonts.
 *
 * Gated on HQ_VISUAL, not on CI, and deliberately: the baselines are `-linux`
 * rendered by the container's fonts, so this must run ONLY where those fonts
 * are — the `visual` CI job (which sets HQ_VISUAL=1 and runs in the container),
 * or a developer inside the same image. The ordinary `webapp` CI job runs on a
 * bare runner whose fonts differ, so it leaves HQ_VISUAL unset and skips: a
 * check that fails for a font mismatch is the permanently-red check the whole
 * matrix is careful never to ship.
 */
test.skip(
  !process.env.HQ_VISUAL,
  "Visual baselines are Linux-only; set HQ_VISUAL=1 inside the Playwright container",
);

// A small tolerance already lives in playwright.config.ts (maxDiffPixelRatio).
// It absorbs sub-pixel antialiasing without letting a real regression through.

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

  test(`the jobs grid looks right — ${theme}`, async ({ page }) => {
    // The "looks like Airtable" surface, the one most worth pinning visually:
    // dense rows, sticky header, aligned numerics, the muted em dash.
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/jobs?set=all");
    await expect(page.locator('[data-testid="jobs-grid"][data-ready="true"]')).toBeAttached();
    await page.waitForLoadState("load");
    await expect(page).toHaveScreenshot(`jobs-${theme}.png`, { fullPage: true });
  });

  test(`a selection looks right — ${theme}`, async ({ page }) => {
    // Selection is a colour state, and colour drift is exactly what a pixel
    // baseline catches that an assertion does not — the too-subtle dark tint
    // that G5 fixed would have shown here.
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/jobs?set=all");
    await expect(page.locator('[data-testid="jobs-grid"][data-ready="true"]')).toBeAttached();
    const company = (c: string) =>
      page.locator('[role="gridcell"][data-col="company"]').filter({ hasText: new RegExp(`^${c}$`) });
    await company("Fifth Third Bank").click();
    await company("Databricks").click({ modifiers: ["Shift"] });
    await expect(page.getByTestId("selection-count")).toContainText("3 selected");
    await expect(page).toHaveScreenshot(`jobs-selected-${theme}.png`, { fullPage: true });
  });
}
