import { expect, test } from "@playwright/test";

/**
 * Light mode only (DEC-014, issue #240 — owner design ruling).
 *
 * This file used to prove the dark WIRING — that a dark OS actually got the
 * dark palette. The ruling inverts the claim, and the claim still needs a
 * test for the same reason it always did: what a dark-OS visitor renders is
 * invisible to every suite that runs light. These cases drive the preference
 * the way a browser does and assert on what actually renders — the pixel,
 * not a class.
 *
 * Three ways dark could creep back without any `.dark` selector existing:
 * a `prefers-color-scheme` media query in some component's CSS, a browser
 * auto-darkening a page that never declared `color-scheme: light`, and a
 * revived reader of the retired `hq-theme` localStorage key. Each is asserted
 * against here.
 */

async function bg(page: import("@playwright/test").Page) {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

/** `--bg` in the one palette there is. */
const LIGHT_BG = "rgb(251, 251, 250)";

// Every route the user lands on, not just /queue. "Renders identically on
// every surface" is the acceptance criterion, and a deep link straight to
// /jobs on a dark OS is a real entry point (a shared filtered view).
const ROUTES = ["/queue", "/jobs", "/pipeline", "/health", "/companies"];

test.describe("a dark OS gets the light palette", () => {
  test.use({ colorScheme: "dark" });

  for (const route of ROUTES) {
    test(`on first paint — ${route}`, async ({ page }) => {
      await page.goto(route);
      await expect(page.locator("html")).not.toHaveClass(/dark/);
      // The rendered pixel, not the class: rgb(251, 251, 250) is `--bg`.
      expect(await bg(page)).toBe(LIGHT_BG);
      // And the document says so to the browser: `color-scheme: light` is the
      // declaration that stops form controls and auto-darkening from styling
      // a dark scheme this app no longer has.
      expect(
        await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
      ).toBe("light");
    });
  }

  test("a stored dark-era preference is ignored without erroring", async ({ page, context }) => {
    // The attack in issue #240: every device that ever used the old theme
    // control still carries `hq-theme` in localStorage, and any account that
    // chose a theme still carries `profiles.display_theme`. Neither may crash
    // the removed code path, and neither may darken anything.
    await context.addInitScript(() => localStorage.setItem("hq-theme", "dark"));
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("/queue");
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    expect(await bg(page)).toBe(LIGHT_BG);
    expect(errors, `page errors with a legacy hq-theme value:\n${errors.join("\n")}`).toEqual([]);
  });

  test("the server's own HTML carries no theme machinery", async ({ page }) => {
    // The bytes, not the hydrated DOM: a server that still rendered a dark
    // class or a `data-theme-pref` would be serving the removed feature to
    // any client old enough to read it.
    await page.goto("/queue");
    const res = await page.request.get("/queue");
    expect(res.ok(), `/queue answered ${res.status()}`).toBe(true);
    const html = await res.text();
    expect(html).not.toMatch(/<html[^>]*class="[^"]*\bdark\b/);
    expect(html).not.toContain("data-theme-pref");
  });
});
