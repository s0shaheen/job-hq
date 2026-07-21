import { expect, test } from "@playwright/test";
import { collectPaintedOverflow, describeOffenders } from "./painted-overflow";

/**
 * The owner's stated fear, made mechanical:
 *
 *   "Don't be mad when I come back and yell at you that the table looks off or
 *    is hanging off the edge of the page."
 *
 * Horizontal page overflow is not a matter of taste, so it is not left to
 * review. Anything wider than the viewport must scroll INSIDE its own
 * container; content the page itself cannot contain fails here.
 *
 * The check measures painted element geometry, not document.scrollWidth —
 * globals.css hides horizontal overflow on html/body, which pins scrollWidth
 * to the viewport width even with an element ending 1000px past the edge. A
 * scrollWidth assertion here passed unconditionally while content was
 * genuinely unreachable; see painted-overflow.ts for the measurement.
 */
const PAGES = ["/queue", "/pipeline", "/health", "/jobs"];
const WIDTHS = [375, 414, 768, 1024, 1280, 1920];

test.describe("nothing paints past the page edge", () => {
  for (const path of PAGES) {
    for (const width of WIDTHS) {
      test(`${path} @ ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        await page.waitForLoadState("load");

        const offenders = await page.evaluate(collectPaintedOverflow);
        expect(offenders, describeOffenders(offenders)).toEqual([]);
      });
    }
  }
});

test("long titles and long company names do not break the triage card", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto("/queue");
  // the fixture set deliberately contains a very long title + company
  const card = page.locator("article").first();
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(375);
});

test("an unbroken token in the card headings stays inside the card", async ({ page }) => {
  // Company and title strings arrive from ATS boards unsanitised. A token with
  // no break opportunity — a product name, a slug, a pasted URL — is the case
  // the wrapping fixture strings above cannot exercise: their spaces give the
  // layout an easy out. Without overflow-wrap the company heading (a flex
  // item) widens to the token and the title (a block) paints straight past
  // the card edge, where html's overflow-x:hidden clips it unreachably.
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto("/queue");
  await expect(page.locator("article").first()).toBeVisible();

  await page.evaluate(() => {
    const h2 = document.querySelector("article h2");
    const h3 = document.querySelector("article h3");
    if (!h2 || !h3) throw new Error("triage card headings not found");
    h2.textContent = "Grundstücksverkehrsgenehmigungszuständigkeitsübertragungsverordnung";
    h3.textContent = "SeniorProductManagerEnterpriseDataPlatformReportingInfrastructure2026";
  });

  const offenders = await page.evaluate(collectPaintedOverflow);
  expect(offenders, describeOffenders(offenders)).toEqual([]);
});

test("on a phone, the first job is on the first screen", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "phone-viewport concern");

  // Chrome is not free. The nav used to render as six stacked rows, which
  // filled the entire first screen — the app opened on a menu, and the job it
  // exists to show you was below the fold. Asserting the card's position is
  // what keeps navigation from quietly reclaiming that space again.
  await page.goto("/queue");
  const card = page.locator("article").first();
  await expect(card).toBeVisible();

  const box = await card.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error("no layout box");

  expect(
    box.y,
    `the first card starts ${Math.round(box.y)}px down a ${viewport.height}px screen`,
  ).toBeLessThan(viewport.height * 0.5);
});
