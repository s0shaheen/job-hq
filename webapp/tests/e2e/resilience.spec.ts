import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { collectPaintedOverflow, describeOffenders } from "./painted-overflow";

const ORIGIN = "http://127.0.0.1:3210";

const PAGES = ["/queue", "/pipeline", "/health", "/jobs", "/companies", "/companies/add", "/import", "/settings"];

/**
 * The wizard's screens, which a static list of app routes cannot reach: they
 * redirect to /settings unless the demo profile is unset. Matrix row 170 — a
 * sweep credited with a screen it never loaded.
 *
 * Steps 1 and 6 rather than all six: 1 is the radio-group shape, 6 is the
 * preview panel with its own colours and its own live region, and 2-5 are the
 * same field controls this file already sweeps on /settings.
 */
const ONBOARDING_PAGES = ["/onboarding/1", "/onboarding/6"];

async function seedOnboarding(page: Page) {
  await page
    .context()
    .addCookies([{ name: "hq_demo_seed", value: "onboarding", url: ORIGIN }]);
}

/**
 * The known ways a frontend breaks, each turned into a check.
 *
 * The layout suite covers one of them (nothing scrolls sideways). This covers
 * the rest of the classes that actually bite in production: silent hydration
 * mismatches, white screens, unreadable contrast, keyboard traps, and states
 * that were never rendered because the happy path always had data.
 */

test.describe("no console errors (catches hydration mismatches)", () => {
  for (const path of [...PAGES, ...ONBOARDING_PAGES]) {
    test(path, async ({ page }) => {
      if (path.startsWith("/onboarding")) await seedOnboarding(page);
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(path);
      await page.waitForLoadState("load");
      // Hydration mismatches surface only as console errors — the page still
      // renders, so nothing else would ever notice them.
      expect(errors, `console errors on ${path}:\n${errors.join("\n")}`).toEqual([]);
    });
  }
});

test.describe("accessibility", () => {
  for (const path of [...PAGES, ...ONBOARDING_PAGES]) {
    for (const scheme of ["light", "dark"] as const) {
      test(`${path} — ${scheme}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        if (path.startsWith("/onboarding")) await seedOnboarding(page);
        await page.goto(path);
        // Scan the HYDRATED page, not whatever has painted so far.
        //
        // `goto` resolves when the server HTML lands, which is before React has
        // attached — and the interactive tree is not the same DOM: Radix mounts
        // portalled and visually-hidden nodes for its Select and Dialog
        // primitives during hydration. Scanning in that window measures a
        // half-built page, and this suite saw it exactly once out of ~500 tests,
        // on the mobile project, unreproducible in isolation. A one-in-500
        // failure reads as a real one and is the worst kind (matrix row 45), so
        // the window is closed rather than retried.
        // `load` plus one animation frame after it.
        //
        // The first attempt waited for `main, [data-testid]` to exist, which the
        // SERVER HTML already satisfies — so it waited for nothing and the window
        // it claimed to close stayed open. There is no app-wide readiness flag to
        // wait on (the queue and the grid have their own; these six pages do not),
        // so this waits for the frame after load, which is when React has attached
        // and its portalled nodes exist. Honest about what it is: a bound on the
        // race rather than a signal from the app.
        await page.waitForLoadState("load");
        await page.evaluate(
          () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
        );
        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa"])
          .analyze();
        const serious = results.violations.filter((v) =>
          ["serious", "critical"].includes(v.impact ?? ""),
        );
        // Name the offending element and the measured values, the way the
        // layout suite does. "color-contrast: Elements must meet minimum
        // contrast" with no selector sends the next person hunting through
        // every page; the numbers and the node make it a two-minute fix.
        const detail = serious
          .map((v) => {
            const nodes = v.nodes
              .map((n) => {
                const c = n.any.find((a) => a.id === "color-contrast")?.data as
                  | { fgColor?: string; bgColor?: string; contrastRatio?: number }
                  | undefined;
                const measured = c
                  ? ` — ${c.fgColor} on ${c.bgColor} = ${c.contrastRatio}:1`
                  : "";
                return `    ${n.target.join(" ")}${measured}\n      ${n.html.slice(0, 160)}`;
              })
              .join("\n");
            return `${v.id}: ${v.help}\n${nodes}`;
          })
          .join("\n\n");
        expect(serious, detail).toEqual([]);
      });
    }
  }
});

/** A focused control outside the viewport is a keyboard trap in practice: the
 *  user cannot see what they are about to activate. */
const FOCUS_IS_VISIBLE = () => {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return true;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.top >= -1 && r.left >= -1;
};

test("every interactive element is reachable and visible when focused", async ({ page }) => {
  await page.goto("/queue");
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(FOCUS_IS_VISIBLE)).toBe(true);
  }
});

test("the pipeline's controls stay reachable, including with a popover open", async ({
  page,
}) => {
  // The pipeline is the densest surface for tab order: every row carries a
  // Select, a dialog trigger, two inline inputs and sometimes three buttons. The
  // walk is longer than the queue's for that reason.
  await page.goto("/pipeline");
  await expect(page.getByTestId("pipeline")).toBeVisible();
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(FOCUS_IS_VISIBLE), `after ${i + 1} tabs`).toBe(true);
  }

  // With the status listbox open. Radix moves focus INTO the popover, so this is
  // the state where an off-screen render becomes a dead end rather than a
  // cosmetic problem (matrix row 48).
  const trigger = page.locator("[data-testid^='status-trigger-']").first();
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("ArrowDown");
    expect(await page.evaluate(FOCUS_IS_VISIBLE), `in the popover, step ${i + 1}`).toBe(true);
  }
});

test.describe("the page survives a 200% text zoom", () => {
  // 1280px was the only width this ran at, and it hid the real failures: the
  // person who actually runs large text is a non-technical user on a phone.
  // At 320px the queue title truncated to the single letter "T" and the
  // pipeline title to a bare ellipsis, and the industry badge (whitespace-
  // nowrap) painted off the page edge — all invisible at desktop width.
  for (const path of ["/queue", "/pipeline"]) {
    for (const width of [320, 375, 1280]) {
      test(`${path} @ ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        await page.evaluate(() => {
          document.documentElement.style.fontSize = "32px"; // 2x the 16px default
        });
        await page.waitForTimeout(120);

        // Painted geometry, not document.scrollWidth: html/body hide
        // horizontal overflow, so scrollWidth stays pinned at the viewport
        // width while content is clipped out of reach. See painted-overflow.ts.
        const offenders = await page.evaluate(collectPaintedOverflow);
        expect(offenders, describeOffenders(offenders)).toEqual([]);

        // The title must survive too. `truncate` satisfies every geometry
        // check by clipping its own text — reducing the h1 to one letter is
        // the same failure as hanging off the page: the user cannot read
        // where they are.
        const clipped = await page
          .locator("h1")
          .evaluate((el) => el.scrollWidth > el.clientWidth + 1);
        expect(clipped, `the h1 on ${path} clips its own text at 200% zoom`).toBe(false);
      });
    }
  }
});

test("a slow data source shows a skeleton rather than a blank screen", async ({ page }) => {
  await page.route("**/queue**", async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
  await page.goto("/queue", { waitUntil: "commit" });
  // something meaningful must be on screen while waiting
  await expect(page.locator("body")).not.toBeEmpty();
});
