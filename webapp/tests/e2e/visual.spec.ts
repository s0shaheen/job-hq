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

  test(`the pipeline looks right — ${theme}`, async ({ page }) => {
    // Earned for the reason the /companies pair is: this surface carries three
    // geometry assertions in plain e2e (the status pill at large type, the
    // reserved toast strip, the render budget), and matrix row 101's rule is that
    // a pixel claim belongs in the container job where the fonts are pinned. A
    // baseline is the check those three cannot be.
    //
    // `?open=Applied` rather than the default: it pins one expanded group and
    // several collapsed ones in one image, which is the shape a regression in the
    // grouped layout would show up in. No `?demo=` param — the seams exist to
    // perturb state, and a baseline wants the resting one.
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/pipeline?open=Applied");
    await expect(page.getByTestId("pipeline")).toBeVisible();
    // Idle, not merely painted: "Saving…" appears and disappears, so a shot taken
    // mid-write would be a different image every run.
    await expect(page.locator('[data-testid="pipeline"][data-saving="false"]')).toBeAttached();
    await page.waitForLoadState("load");
    await expect(page).toHaveScreenshot(`pipeline-${theme}.png`, { fullPage: true });
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

  test(`the companies grid looks right — ${theme}`, async ({ page }) => {
    // The one surface whose whole point is a COLOUR-CODED distinction: verified /
    // inferred / unverified / unresolved provenance chips, and the coverage rail
    // built from the same four tokens. A drift in any of those hues is a drift in
    // what the page claims about its own evidence, and no assertion would catch a
    // token that quietly went the wrong shade in one theme.
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/companies?set=all");
    await expect(page.locator('[data-testid="companies-grid"][data-ready="true"]')).toBeAttached();
    await page.waitForLoadState("load");
    await expect(page).toHaveScreenshot(`companies-${theme}.png`, { fullPage: true });
  });

  test(`the coverage meter looks right — ${theme}`, async ({ page }) => {
    // Expanded, because the collapsed rail hides the confidence glossary and the
    // "Recall: not measured" slot — the two pieces of copy that keep this widget
    // honest, and the ones most likely to be quietly deleted by a later edit.
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/companies");
    await expect(page.locator('[data-testid="companies-grid"][data-ready="true"]')).toBeAttached();
    await page.getByTestId("coverage-toggle").click();
    await expect(page.getByTestId("coverage-detail")).toBeVisible();
    await page.waitForLoadState("load");
    await expect(page).toHaveScreenshot(`coverage-${theme}.png`, { fullPage: true });
  });

  test(`the /companies skeleton lands the grid where the loaded page does — ${theme}`, async ({
    page,
  }, testInfo) => {
    // A PIXEL claim, so it lives with the pixel claims.
    //
    // It used to sit in companies.spec.ts, ran on the bare `webapp` runner, and
    // failed there while passing on macOS AND in this container: skeleton rail 185,
    // loaded rail 221. Nothing was wrong with the skeleton. The loaded page is 36px
    // taller above the rail on that runner's fonts, because the header subtitle and
    // the coverage headline each wrap where they do not wrap here — and a skeleton
    // made of fixed-height blocks cannot track a line-box count.
    //
    // The rejected alternative was reserving the worst-case line boxes in BOTH the
    // real page and the skeleton, which makes the geometry font-independent and buys
    // it with ~36px of permanent dead space in the header on every render, to remove
    // a transient jump that only happens where the text genuinely needs the room.
    // Widening the tolerance to 40 was the other option and it is not one: at 40 the
    // assertion no longer distinguishes a correct skeleton from one missing its
    // coverage band, which is the exact bug it was written for (row 90).
    //
    // So it moves to where the fonts are pinned, which is this file's whole premise,
    // and companies.spec.ts keeps the band count + ordering — font-independent, and
    // the half that caught the real regression.
    test.skip(theme !== "light", "geometry is theme-independent; once is enough");
    test.skip(testInfo.project.name !== "desktop", "skeleton widths are tuned for desktop");

    await page.goto("/health");
    await page.route(/\/companies/, async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.getByRole("link", { name: "Companies" }).click();
    await page
      .locator('[data-testid="companies-skeleton"]')
      .waitFor({ state: "attached", timeout: 10_000 });

    const skeletonRail = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="companies-skeleton-colheads"]');
      return el ? Math.round(el.getBoundingClientRect().top) : -1;
    });
    expect(skeletonRail, "no skeleton column rail was rendered").toBeGreaterThan(0);

    // NOT unrouted first. `unroute` while the handler is still inside its own sleep
    // invalidates the route it is about to continue, so the RSC payload never
    // arrives and the grid never renders (matrix row 45).
    await expect(
      page.locator('[data-testid="companies-grid"][data-ready="true"]'),
    ).toBeAttached({ timeout: 20_000 });
    const loadedRail = await page.evaluate(() => {
      const el = document.querySelector('[role="row"][aria-rowindex="1"]');
      return el ? Math.round(el.getBoundingClientRect().top) : -1;
    });
    expect(loadedRail).toBeGreaterThan(0);

    // A few pixels for sub-pixel line-box rounding. A missing coverage band would be
    // tens of pixels, which is the jump this is here to catch.
    expect(
      Math.abs(loadedRail - skeletonRail),
      `skeleton rail at ${skeletonRail}, loaded rail at ${loadedRail}`,
    ).toBeLessThan(8);
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
