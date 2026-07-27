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
const PAGES = [
  "/queue",
  "/pipeline",
  "/health",
  "/jobs",
  "/companies",
  "/companies/add",
  // The LANDING page, and only that. This list is static and every screen of the
  // wizard lives at `/import/<batchId>`, minted at upload time — so a path here
  // cannot reach the mapping list, the preview or the report. A comment that used
  // to claim this line retro-fitted six widths to "the 60-header mapping list"
  // was describing a screen no test in this file has ever loaded;
  // `import-wizard.spec.ts` uploads a fixture and sweeps them for real.
  "/import",
  // The pipeline's other GROUPING states — everything collapsed, and a subset
  // open. Group headers are the widest thing on the row once the rows are gone.
  //
  // `?demo=conflict:3` was here too and is deliberately gone: this file sets no
  // `hq_demo_id`, so all twelve runs shared one demo store and each visit MUTATED
  // it for whatever ran next. It also bought nothing — the conflict seam moves a
  // row's status and version token, and the rendered HTML is byte-identical to
  // plain /pipeline, so there was no new geometry to measure. The conflict
  // RENDERING is covered in pipeline.spec.ts, where every test owns its store.
  "/pipeline?open=",
  "/pipeline?open=Applied,Interview",
];
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

/**
 * The same sweep with the large type scale on — spec §D's Dad persona.
 *
 * Separate from the loop above rather than folded into it because it needs a
 * cookie set before the first paint, and because the failure it guards is
 * different: at `large` every type token grows by roughly a third, so a status
 * pill, a group header count or an inline date input that fitted at 13px can
 * clip or push its row past the edge. Matrix row 123.
 *
 * The 200%-zoom test in resilience.spec.ts is NOT the same check: that multiplies
 * the root font size (which the token scale is expressed in), so it exercises the
 * default scale at 2x rather than this scale at 1x — different token ratios, and
 * the pill fits one and not the other.
 */
test.describe("nothing paints past the edge at the large type scale", () => {
  for (const path of ["/pipeline", "/pipeline?open=", "/queue", "/jobs"]) {
    for (const width of WIDTHS) {
      test(`${path} @ ${width}px`, async ({ page, context }) => {
        await context.addCookies([
          { name: "hq_display", value: "large,comfortable", url: "http://127.0.0.1:3210" },
        ]);
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        await page.waitForLoadState("load");

        // The cookie has to have actually applied, or this whole describe block
        // is a duplicate of the sweep above wearing a different name.
        await expect(page.locator("html")).toHaveAttribute("data-type-scale", "large");

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
