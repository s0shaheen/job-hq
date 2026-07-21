import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { collectPaintedOverflow, describeOffenders } from "./painted-overflow";

const PAGES = ["/queue", "/pipeline", "/health"];

/**
 * The known ways a frontend breaks, each turned into a check.
 *
 * The layout suite covers one of them (nothing scrolls sideways). This covers
 * the rest of the classes that actually bite in production: silent hydration
 * mismatches, white screens, unreadable contrast, keyboard traps, and states
 * that were never rendered because the happy path always had data.
 */

test.describe("no console errors (catches hydration mismatches)", () => {
  for (const path of PAGES) {
    test(path, async ({ page }) => {
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
  for (const path of PAGES) {
    for (const scheme of ["light", "dark"] as const) {
      test(`${path} — ${scheme}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(path);
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

test("every interactive element is reachable and visible when focused", async ({ page }) => {
  await page.goto("/queue");
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const ok = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return true;
      const r = el.getBoundingClientRect();
      // a focused control that sits outside the viewport is a keyboard trap
      // in practice: the user cannot see what they are about to activate
      return r.width > 0 && r.height > 0 && r.top >= -1 && r.left >= -1;
    });
    expect(ok).toBe(true);
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
