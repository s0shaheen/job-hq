import { expect, test } from "@playwright/test";

/**
 * The theme WIRING, as distinct from the theme tokens.
 *
 * The existing visual and axe passes cover the palette by adding `.dark`
 * themselves. That proves the colours are right and proves nothing about
 * whether the app ever applies them — and for a while it did not: a visitor on
 * a dark OS got the light theme, with no failing test anywhere. These cases
 * drive the preference the way a browser does and assert on what actually
 * renders.
 */

async function bg(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    getComputedStyle(document.body).backgroundColor,
  );
}

// Every route the user lands on, not just /queue. The wiring lives in the root
// layout so it applies everywhere, but "should apply everywhere" is a claim,
// and the grid is a whole new surface — a deep link straight to /jobs on a dark
// OS is a real entry point (a shared filtered view), and nothing asserted its
// background until this list did.
const ROUTES = ["/queue", "/jobs", "/pipeline", "/health"];

test.describe("dark OS preference", () => {
  test.use({ colorScheme: "dark" });

  for (const route of ROUTES) {
    test(`is honoured on first paint — ${route}`, async ({ page }) => {
      await page.goto(route);
      await expect(page.locator("html")).toHaveClass(/dark/);
      // rgb(17, 19, 17) is --bg in the dark palette. Asserting the rendered
      // pixel, not the class, is what catches a token that never got applied.
      expect(await bg(page)).toBe("rgb(17, 19, 17)");
    });
  }
});

test.describe("light OS preference", () => {
  test.use({ colorScheme: "light" });

  test("is honoured on first paint", async ({ page }) => {
    await page.goto("/queue");
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    expect(await bg(page)).toBe("rgb(251, 251, 250)");
  });

  test("a stored choice beats the OS", async ({ page, context }) => {
    // The whole reason the palette is class-driven rather than a media query.
    await context.addInitScript(() => localStorage.setItem("hq-theme", "dark"));
    await page.goto("/queue");
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(await bg(page)).toBe("rgb(17, 19, 17)");
  });
});
