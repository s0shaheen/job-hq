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

/** Same origin every other spec here builds cookie URLs from. */
const ORIGIN = "http://127.0.0.1:3210";

/**
 * The route as the SERVER sent it, before any script ran.
 *
 * Through the page's own request context, so it carries the page's cookies —
 * the demo store id and therefore the account whose preference is being
 * asserted. `page.content()` would return the LIVE DOM, which the pre-paint
 * bootstrap has already corrected; that is precisely the difference between
 * "ends up right" and "arrived right", and only the second one is flash-free.
 */
async function serverHtml(page: import("@playwright/test").Page, route: string): Promise<string> {
  const res = await page.request.get(route);
  expect(res.ok(), `${route} answered ${res.status()}`).toBe(true);
  return res.text();
}

// Every route the user lands on, not just /queue. The wiring lives in the root
// layout so it applies everywhere, but "should apply everywhere" is a claim,
// and the grid is a whole new surface — a deep link straight to /jobs on a dark
// OS is a real entry point (a shared filtered view), and nothing asserted its
// background until this list did.
const ROUTES = ["/queue", "/jobs", "/pipeline", "/health", "/companies"];

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

/**
 * THE CONTROL, and the half of the claim a hydrated DOM cannot show.
 *
 * Until RM-34 there was no way for anyone to choose a theme. The layout resolved
 * the palette correctly and nothing in the application ever wrote `hq-theme` —
 * the only writer in the repository was line 52 of this file — and the profile
 * column migration 0025 added had no path to being set either. So every user got
 * whatever their operating system said, permanently, while the layout's own
 * comment described a Display popover writing both halves. That popover has no
 * theme control.
 *
 * These cases drive the real control at `/settings/preferences` and assert the
 * thing that actually matters: not that the page ends up light, but that the
 * SERVER already said light in the bytes it sent. A test that inspects the
 * hydrated DOM passes either way, including on the flash it exists to prevent.
 */
test.describe("choosing a theme, on a dark-OS browser", () => {
  test.use({ colorScheme: "dark" });

  /**
   * A demo store nothing else shares.
   *
   * Per PROJECT, because desktop and mobile run the same file against one
   * server, and per REPEAT, because two runs of the same test are two writers of
   * one theme — which is what `--repeat-each=2` surfaced here as four failures
   * that looked like flake and were an isolation bug in this file.
   */
  function storeId(name: string): string {
    const info = test.info();
    return `theme-${info.project.name}-${info.repeatEachIndex}-${name}`;
  }

  async function gotoPreferences(page: import("@playwright/test").Page) {
    await page.goto("/settings/preferences");
    await expect(page.getByTestId("preferences-form")).toHaveAttribute("data-hydrated", "true");
  }

  /**
   * Change the theme and wait until the page is interactive AGAIN.
   *
   * Theme is one of the three knobs the document is measured against, so the
   * control reloads once the server confirms — and that reload drops the page
   * back into the unhydrated gap. A second `selectOption` fired into it moves
   * the DOM value, fires a change event nothing is listening for, and sends no
   * write; the failure then surfaces 15 seconds later as a class that never
   * arrived. This test passed alone and failed in the full-file run on exactly
   * that, which is the same defect `profile.spec.ts` records for its own
   * two-gesture case.
   *
   * Both waits are needed and neither is redundant: the class is the SERVER's
   * answer landing, `data-hydrated` is the new document becoming operable.
   */
  async function chooseTheme(
    page: import("@playwright/test").Page,
    value: "light" | "dark" | "system",
    expectDark: boolean,
  ) {
    await page.getByTestId("prefs-theme").selectOption(value);
    const html = expect(page.locator("html"));
    if (expectDark) await html.toHaveClass(/dark/, { timeout: 15_000 });
    else await html.not.toHaveClass(/dark/, { timeout: 15_000 });
    await expect(page.getByTestId("preferences-form")).toHaveAttribute("data-hydrated", "true");
  }

  test("light survives a reload, and arrives light in the server's own HTML", async ({
    page,
    context,
  }) => {
    await context.addCookies([
      { name: "hq_demo_id", value: storeId("light"), url: ORIGIN },
    ]);
    await gotoPreferences(page);
    // The starting state is the OS's, which is what makes the change meaningful.
    await expect(page.locator("html")).toHaveClass(/dark/);

    await chooseTheme(page, "light", false);

    // THE ASSERTION THIS FILE EXISTED WITHOUT. Fetch the route as bytes and read
    // the markup the server produced, before a single script has run. If the
    // class were applied by the bootstrap instead, the document would arrive
    // dark and correct itself, which is the flash — invisible to `toHaveClass`
    // on a live page and plainly visible to a person.
    await page.reload();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    expect(await bg(page)).toBe("rgb(251, 251, 250)");

    const html = await serverHtml(page, "/queue");
    expect(html, "the server rendered a dark <html> for an account set to light").not.toMatch(
      /<html[^>]*class="[^"]*\bdark\b/,
    );
    expect(html, "the server did not state the stored preference").toMatch(
      /<html[^>]*data-theme-pref="light"/,
    );
  });

  /**
   * THE POSITIVE DIRECTION, and it exists because the negative one alone is
   * vacuous. Asserting only "the light account's HTML has no `dark` class"
   * passes just as happily when the server stops rendering the class AT ALL and
   * lets the bootstrap correct it after paint — which is the flash this whole
   * mechanism exists to prevent. Deleting `className` from the root layout was
   * run as a mutation and this file went green; that is what added this case.
   *
   * A LIGHT-OS browser choosing dark is the only arrangement where the class can
   * only have come from the stored preference: the OS would have produced the
   * opposite, and the bootstrap runs after the bytes being read here.
   */
  test("dark on a light-OS browser arrives dark in the server's own HTML", async ({
    browser,
  }) => {
    const context = await browser.newContext({ colorScheme: "light" });
    const page = await context.newPage();
    try {
      await context.addCookies([
        { name: "hq_demo_id", value: storeId("dark"), url: ORIGIN },
      ]);
      await gotoPreferences(page);
      await expect(page.locator("html")).not.toHaveClass(/dark/);

      await chooseTheme(page, "dark", true);

      const html = await serverHtml(page, "/queue");
      expect(
        html,
        "the server did not render the dark class, so the page arrives light and corrects itself after paint",
      ).toMatch(/<html[^>]*class="[^"]*\bdark\b/);
      expect(html).toMatch(/<html[^>]*data-theme-pref="dark"/);
    } finally {
      await context.close();
    }
  });

  /**
   * TWO DEVICES THAT DISAGREE, which is the case every other test here cannot
   * reach and the one the product actually breaks on.
   *
   * The sibling below asserts that both halves are written, in ONE browser
   * context — where the profile and `localStorage` are always the same value, so
   * their precedence never has to be decided and the bug is invisible.
   *
   * Alice sets Dark on her phone and Light on her laptop. The laptop's profile
   * now says light and its `localStorage` still says... whatever it last wrote.
   * Reproduced here as a second context carrying the SAME account
   * (`hq_demo_id`) and a DIFFERENT stored value, seeded before any script runs.
   *
   * With `stored || attribute` the stored value won: the server rendered the
   * account's palette, the bootstrap immediately stripped it, and the page
   * flashed on every single load with no setting able to move it. With
   * `attribute || stored` the account wins, which is what "a second device gets
   * the right palette from the server" has to mean.
   *
   * Asserted on the LIVE class rather than on server bytes, deliberately: the
   * server half is already pinned two tests up, and what is under test here is
   * what the bootstrap does AFTER it — the moment the two sources disagree.
   */
  test("the account's theme beats a stale value stored on another device", async ({
    browser,
  }) => {
    const account = storeId("cross-device");

    const laptop = await browser.newContext({ colorScheme: "light" });
    try {
      const page = await laptop.newPage();
      await laptop.addCookies([{ name: "hq_demo_id", value: account, url: ORIGIN }]);
      await gotoPreferences(page);
      await chooseTheme(page, "dark", true);

      // A second device on the same account, already carrying the opposite
      // answer from an earlier choice of its own.
      const phone = await browser.newContext({ colorScheme: "light" });
      try {
        await phone.addCookies([{ name: "hq_demo_id", value: account, url: ORIGIN }]);
        await phone.addInitScript(() => localStorage.setItem("hq-theme", "light"));
        const second = await phone.newPage();
        await second.goto("/queue");

        await expect(
          second.locator("html"),
          "a stale device value beat the account, so this device is pinned to the wrong palette and flashes on every load",
        ).toHaveClass(/dark/);
        expect(await bg(second)).toBe("rgb(17, 19, 17)");
      } finally {
        await phone.close();
      }
    } finally {
      await laptop.close();
    }
  });

  test("a conflict does not leave the losing value on the device", async ({ browser }) => {
    // `conflict` means the server did NOT store the value: another writer got
    // there first. It used to be written to `localStorage` alongside `ok`, which
    // put the LOSING answer into the device's own slot and then reloaded into it.
    //
    // A REAL CONFLICT, not an armed failure. The first version of this test used
    // `hq_demo_fail`, which produces `kind: "error"` — a different branch that
    // never wrote `localStorage` in the first place — so it passed against the
    // bug and proved nothing. A conflict needs a STALE VERSION TOKEN: one page
    // reads the token, a second page moves it, and the first page's write
    // arrives holding the old one. That is what the two contexts below are for.
    const account = storeId("conflict");
    const first = await browser.newContext({ colorScheme: "light" });
    try {
      const page = await first.newPage();
      await first.addCookies([
        { name: "hq_demo_id", value: account, url: ORIGIN },
        // The seam SEEDS a display row, so the page loads holding a real version
        // token. Without it the account has no row, `updatedAt` is null, and the
        // store skips the version check entirely — which is why the first draft
        // of this test passed against the bug: there was no conflict to have.
        { name: "hq_demo_display", value: "comfortable", url: ORIGIN },
      ]);
      await gotoPreferences(page);

      // A second writer moves the version token underneath the first page. Any
      // knob does it; density is the one this test is not about.
      const second = await browser.newContext({ colorScheme: "light" });
      try {
        await second.addCookies([{ name: "hq_demo_id", value: account, url: ORIGIN }]);
        const other = await second.newPage();
        await other.goto("/settings/preferences");
        await expect(other.getByTestId("preferences-form")).toHaveAttribute(
          "data-hydrated",
          "true",
        );
        await other.getByTestId("prefs-density").selectOption("dense");
        await expect(other.locator("html")).not.toHaveAttribute("data-density", "comfortable", {
          timeout: 15_000,
        });
      } finally {
        await second.close();
      }

      // Now the first page writes a theme against a token that has moved on.
      //
      // THE LOAD LISTENER IS ARMED FIRST, and this is not belt-and-braces. The
      // control reloads on a conflict too — the server is the authority and the
      // honest response is to show what it holds — but the theme does NOT change
      // on this path, because the write lost. So there is no class flip to wait
      // on, and `data-hydrated` is already "true" on the document still on
      // screen: waiting for it passes instantly against the OLD page, and the
      // `evaluate` below then runs into the reload with "Execution context was
      // destroyed". That is exactly how this failed on CI, on mobile, once.
      const reloaded = page.waitForEvent("load", { timeout: 20_000 });
      await page.getByTestId("prefs-theme").selectOption("dark");
      await reloaded;
      await expect(page.getByTestId("preferences-form")).toHaveAttribute(
        "data-hydrated",
        "true",
        { timeout: 20_000 },
      );

      // The server never stored dark, so the device must not be holding it. If
      // it were, this browser would render dark from `localStorage` forever
      // while the account says otherwise.
      expect(
        await page.evaluate(() => localStorage.getItem("hq-theme")),
        "the value the server REJECTED was cached on the device",
      ).toBeNull();
      await expect(page.locator("html")).not.toHaveClass(/dark/);
    } finally {
      await first.close();
    }
  });

  test("the choice is written to BOTH halves, so another device is not flashed", async ({
    page,
    context,
  }) => {
    await context.addCookies([
      { name: "hq_demo_id", value: storeId("both"), url: ORIGIN },
    ]);
    await gotoPreferences(page);
    await chooseTheme(page, "light", false);

    // The device half. `localStorage` OUTRANKS the profile, so a control that
    // wrote only the profile would be beaten on any device carrying an older
    // stored string — which is exactly the state a person reaches by using the
    // control twice.
    expect(await page.evaluate(() => localStorage.getItem("hq-theme"))).toBe("light");

    // And back to system, which is the ABSENCE of a choice and must CLEAR both
    // rather than store the word. A stored "system" would sit in the slot that
    // outranks the profile and pin this device away from a later explicit
    // choice made elsewhere.
    await chooseTheme(page, "system", true);
    expect(await page.evaluate(() => localStorage.getItem("hq-theme"))).toBeNull();

    const html = await serverHtml(page, "/queue");
    expect(html, "system is the absence of a choice; the server stated it as a value").not.toMatch(
      /data-theme-pref="system"/,
    );
  });
});
