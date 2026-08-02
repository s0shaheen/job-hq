import { expect, test, type Page } from "@playwright/test";
import { collectPaintedOverflow, describeOffenders } from "./painted-overflow";

const ORIGIN = "http://127.0.0.1:3210";

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
  // The profile is the widest FORM in the app: chip lists whose contents are
  // free text, seeded from the longest real title anybody has tuned. A chip that
  // cannot wrap pushes the page sideways, which is the owner's stated fear
  // arriving through a text field (matrix row 88).
  "/settings",
  // Sixteen rule cards, a country chip list, a company name somebody pastes, and
  // a stored answer up to 8,000 characters long — the widest free text in the app
  // after the profile, on a surface whose whole job is holding what a person
  // typed. Named here rather than assumed covered by `/settings`: they are two
  // routes, and matrix row 170 is what happens when a sweep is credited with a
  // screen it never loaded.
  "/settings/answers",
  // A staged application. Every gap card carries a question label the board
  // wrote — arbitrary length, no wrapping guarantees — beside two badges, which
  // is the row-88 shape on a new surface.
  "/apply/1",
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

/**
 * `/onboarding/*` needs a demo store with NO profile, or every visit redirects
 * to /settings and the sweep measures that page six more times.
 *
 * This is matrix row 170's lesson taken seriously: a static path list that
 * cannot reach the screen it names is a sweep credited with work it never did.
 * The wizard writes nothing until Save, which no test in this file clicks, so
 * sharing one seeded store across the sweep is safe.
 *
 * The long-draft entry is row 88's case, and it is a REAL one rather than a
 * lorem string: a 92-character FP&A title of the kind a bank actually posts,
 * six metros, and the chip lists that come with them. A chip that cannot wrap
 * pushes the page sideways — the owner's stated fear, arriving through a text
 * field.
 */
const LONG_DRAFT =
  "eyJyb2xlX2ZhbWlseSI6ImZpbmFuY2lhbCBwbGFubmluZyAmIGFuYWx5c2lzIiwidGFnX2RvbWFpbiI6ImZpbmFuY2UiLCJib2FyZF9zZWFyY2hfdGVybSI6ImZpbmFuY2lhbCIsInRpdGxlc19pbmNsdWRlIjpbInNlbmlvciBtYW5hZ2VyLCBmaW5hbmNpYWwgcGxhbm5pbmcgYW5kIGFuYWx5c2lzIOKAlCBjb3Jwb3JhdGUgZmluYW5jZSBhbmQgdHJlYXN1cnkgb3BlcmF0aW9ucyIsImZwJmEiLCJjb250cm9sbGVyIl0sInRpdGxlc19leGNsdWRlIjpbImZpbmFuY2lhbCBhZHZpc29yIl0sImNvdW50cmllcyI6WyJVbml0ZWQgU3RhdGVzIl0sIm1ldHJvcyI6WyJDaGljYWdvIiwiTmV3IFlvcmsiLCJTYW4gRnJhbmNpc2NvIEJheSBBcmVhIiwiV2FzaGluZ3RvbiBEQyIsIk1pbm5lYXBvbGlzIiwiUGhpbGFkZWxwaGlhIl0sImdlb191bmtub3duIjoiZmlsdGVyIiwieW9lX21heCI6MzAsInlvZV91bmtub3duIjoia2VlcCIsInNlbmlvcml0eV9leGNsdWRlIjpbXSwiY29tcF9taW4iOjAsImNvbXBfdW5rbm93biI6ImtlZXAiLCJ3b3JrX21vZGVsX2V4Y2x1ZGUiOlsib25zaXRlIl19";

const ONBOARDING_PAGES = [
  "/onboarding/1",
  // The long draft goes to step ONE, which is where the title chips live now.
  // Pointed at step two it would measure a screen the long strings never reach.
  `/onboarding/1?d=${LONG_DRAFT}`,
  "/onboarding/2",
  `/onboarding/2?d=${LONG_DRAFT}`,
];

async function seedOnboarding(page: Page) {
  await page
    .context()
    .addCookies([{ name: "hq_demo_seed", value: "onboarding", url: ORIGIN }]);
}

const WIDTHS = [375, 414, 768, 1024, 1280, 1920];

test.describe("nothing paints past the page edge", () => {
  for (const path of [...PAGES, ...ONBOARDING_PAGES]) {
    for (const width of WIDTHS) {
      test(`${path} @ ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        if (path.startsWith("/onboarding")) await seedOnboarding(page);
        await page.goto(path);
        await page.waitForLoadState("load");
        // The wizard writes the draft into its own history entry on hydration,
        // which re-renders it. Measuring before that lands would measure a page
        // that is about to change.
        if (path.startsWith("/onboarding")) {
          await expect(page.getByTestId("wizard")).toHaveAttribute("data-hydrated", "true");
        }

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
          { name: "hq_demo_display", value: "large,comfortable", url: "http://127.0.0.1:3210" },
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
