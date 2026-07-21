import { expect, test } from "@playwright/test";

/**
 * The owner's stated fear, made mechanical:
 *
 *   "Don't be mad when I come back and yell at you that the table looks off or
 *    is hanging off the edge of the page."
 *
 * Horizontal page overflow is not a matter of taste, so it is not left to
 * review. Anything wider than the viewport must scroll INSIDE its own
 * container; if the document itself scrolls sideways, this fails.
 */
const PAGES = ["/queue", "/pipeline", "/health"];
const WIDTHS = [375, 414, 768, 1024, 1280, 1920];

test.describe("no page scrolls sideways", () => {
  for (const path of PAGES) {
    for (const width of WIDTHS) {
      test(`${path} @ ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        await page.waitForLoadState("load");

        const overflow = await page.evaluate(() => {
          const d = document.documentElement;
          return {
            scrollWidth: d.scrollWidth,
            clientWidth: d.clientWidth,
            // name the widest offender, so a failure is actionable rather
            // than just red
            culprit: (() => {
              let worst = { tag: "", cls: "", right: 0 };
              for (const el of Array.from(document.querySelectorAll("*"))) {
                const r = el.getBoundingClientRect();
                if (r.right > worst.right) {
                  worst = {
                    tag: el.tagName,
                    cls: (el.getAttribute("class") ?? "").slice(0, 80),
                    right: Math.round(r.right),
                  };
                }
              }
              return worst;
            })(),
          };
        });

        expect(
          overflow.scrollWidth,
          `${path} overflows by ${overflow.scrollWidth - overflow.clientWidth}px. ` +
            `Widest element: <${overflow.culprit.tag} class="${overflow.culprit.cls}"> ` +
            `ending at ${overflow.culprit.right}px.`,
        ).toBeLessThanOrEqual(overflow.clientWidth);
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
