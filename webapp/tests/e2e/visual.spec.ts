import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { LAST_STEP } from "@/lib/profile/draft";

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
/**
 * ════════════════════════════════════════════════════════════════════════════
 * RE-RECORDING: use `scripts/record-baselines.sh`, never a bare --update-snapshots
 *
 * The procedure and the container command live in `webapp/README.md` under
 * "Visual regression baselines". Read it before re-recording anything. The one
 * line worth repeating here, because this is the file you are in when you decide
 * to re-record:
 *
 *   A bare `--update-snapshots` rewrites ONLY the baselines that fail. Anything
 *   under `maxDiffPixelRatio` silently keeps its old image, and the run still
 *   exits 0 — so a re-record that did nothing is indistinguishable from one that
 *   worked. `=all` is the fix — and its own trap is the mirror image: it
 *   rewrites EVERY file, so afterwards `git status` lists every baseline whose
 *   bytes differ at all, including noise the check tolerates. On this branch
 *   that was 23 files, 22 of them on untouched surfaces, all green.
 *   `scripts/record-baselines.sh` runs the check FIRST and the record second so
 *   the two lists are separable: what the check failed is the real change,
 *   everything else is churn to discard.
 *
 * Three occurrences now, which is why it is a script and not just a paragraph:
 * `/jobs` and `/queue` survived a nav item being added to every page (README),
 * and the Applications cutover re-recorded the mobile pipeline pair while the
 * DESKTOP pair kept baselines depicting the retired surface — old title, old
 * status groups, controls that no longer exist — and passed. That was caught by
 * opening the PNG, which is the step no automation replaces.
 */
test.skip(
  !process.env.HQ_VISUAL,
  "Visual baselines are Linux-only; set HQ_VISUAL=1 inside the Playwright container",
);

/*
 * LIGHT ONLY (DEC-014, issue #240): the dark half of this suite and its 28
 * `*-dark-*` baselines are deleted, not skipped. The snapshot names keep
 * their `-light` suffix on purpose — the committed light baselines are the
 * same files they were before the ruling, so this suite keeps proving the
 * ruling changed nothing visible in light mode.
 */

// A small tolerance already lives in playwright.config.ts (maxDiffPixelRatio).
// It absorbs sub-pixel antialiasing without letting a real regression through.

test.beforeEach(async ({ page, context }) => {
  await page.clock.setFixedTime(new Date("2026-07-21T15:00:00.000Z"));
  await context.addCookies([
    { name: "hq_demo_id", value: "visual-baseline", url: "http://127.0.0.1:3210" },
  ]);
});

test("queue looks right", async ({ page }) => {
  await page.goto("/queue");
  // Shortcut hints render dim until the keyboard handler attaches, so a
  // snapshot taken mid-hydration would differ from one taken after it.
  await expect(page.locator('[data-testid="triage"][data-ready="true"]')).toBeAttached();
  await page.waitForLoadState("load");
  /**
   * A TIGHTER tolerance than the project default, on this surface only, and
   * it is here because the default was measured letting the whole cutover
   * through.
   *
   * `maxDiffPixelRatio: 0.02` on a 1280x900 desktop canvas is a budget of
   * 23,040 pixels. Today is a single 760px column on a mostly empty page, so
   * replacing the ENTIRE surface — the one-card stack became the owner's
   * list, and #121 had already replaced the nav beside it — moves 21,964
   * pixels. That is under budget, so the committed desktop baseline still
   * depicted the pre-#121 nine-link nav and the retired triage card, and the
   * check went green on a page that no longer existed. Measured, not
   * suspected: a probe with the ratio set to 0 printed the number.
   *
   * A ratio is the wrong unit for a sparse surface — it scales the budget
   * with the empty background rather than with the ink. An absolute budget
   * does not, and inside the pinned Playwright container font rasterisation
   * is deterministic, so 600 pixels is generous for antialiasing and far
   * below anything a person would call a change.
   *
   * Scoped to this one assertion deliberately. The other surfaces' baselines
   * are the previous packets' evidence, and re-tolerancing twelve of them is
   * its own change with its own re-recording; this is a finding to hand back,
   * not a licence to churn them.
   */
  await expect(page).toHaveScreenshot("queue-light.png", {
    fullPage: true,
    maxDiffPixels: 600,
    maxDiffPixelRatio: 1,
  });
});

test("the pipeline looks right", async ({ page }) => {
  // Earned for the reason the /companies pair is: this surface carries three
  // geometry assertions in plain e2e (the status pill at large type, the
  // reserved toast strip, the render budget), and matrix row 101's rule is that
  // a pixel claim belongs in the container job where the fonts are pinned. A
  // baseline is the check those three cannot be.
  //
  // `?open=Active` rather than the default: it pins one expanded band and the
  // others collapsed in one image, which is the shape a regression in the
  // banded layout would show up in. No `?demo=` param — the seams exist to
  // perturb state, and a baseline wants the resting one.
  await page.goto("/pipeline?open=Active");
  await expect(page.getByTestId("pipeline")).toBeVisible();
  // Idle, not merely painted: "Saving…" appears and disappears, so a shot taken
  // mid-write would be a different image every run.
  await expect(page.locator('[data-testid="pipeline"][data-saving="false"]')).toBeAttached();
  await page.waitForLoadState("load");
  await expect(page).toHaveScreenshot("pipeline-light.png", { fullPage: true });
});

test("the jobs grid looks right", async ({ page }) => {
  // The "looks like Airtable" surface, the one most worth pinning visually:
  // dense rows, sticky header, aligned numerics, the muted em dash.
  await page.goto("/jobs?set=all");
  await expect(page.locator('[data-testid="jobs-grid"][data-ready="true"]')).toBeAttached();
  await page.waitForLoadState("load");
  await expect(page).toHaveScreenshot("jobs-light.png", { fullPage: true });
});

test("the companies grid looks right", async ({ page }) => {
  // The one surface whose whole point is a COLOUR-CODED distinction: the
  // Confirmed / Likely / Added by you / Not found yet source-quality chips. A
  // drift in any of those hues is a drift in what the page claims about its
  // own evidence, and no assertion would catch a token that quietly went the
  // wrong shade.
  //
  // The coverage RAIL used to be the second half of that argument and is gone
  // with the meter — the design forbids a bar for coverage or confidence, so
  // the four tokens now appear on the chips alone.
  await page.goto("/companies?set=all");
  await expect(page.locator('[data-testid="companies-grid"][data-ready="true"]')).toBeAttached();
  await page.waitForLoadState("load");
  await expect(page).toHaveScreenshot("companies-light.png", { fullPage: true });
});

test("the /companies skeleton lands the grid where the loaded page does", async ({
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
  test.skip(testInfo.project.name !== "desktop", "skeleton widths are tuned for desktop");

  // Started from /coverage rather than /health, because the redesigned frame
  // is five destinations and Companies is not one of them: Coverage is the
  // destination and its primary action is the link here. Any client-side
  // transition into /companies does — the point is a SOFT navigation, so the
  // route's `loading.tsx` paints while the delayed data streams.
  await page.goto("/coverage");
  await page.route(/\/companies/, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.getByRole("link", { name: "Go to companies" }).click();
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

test("the import mapping screen looks right", async ({ page }) => {
  // ONE shot of the wizard, and the mapping step is the one worth having: a
  // card per target field carrying a Select, an explanation, live sample values
  // and — on this fixture — the amber "none of these read as a year-first date"
  // warning, which is a COLOUR claim no assertion checks. It is also the first
  // screen a new user sees, and until this branch no test had rendered
  // `wide-60.xlsx` in a browser at all. The preview and the report are lists of
  // text whose drift shows up in assertions; a warning that quietly stops being
  // amber does not.
  //
  // Uploaded rather than navigated to, because `/import/<batchId>` is minted at
  // upload time and cannot be written into a path list — the same reason the
  // sweeps in import-wizard.spec.ts do it. Nothing on this screen carries a
  // timestamp or an id, so the image is stable.
  await page.goto("/import");
  await page.getByTestId("import-file").setInputFiles({
    name: "wide-60.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "import", "wide-60.xlsx"),
    ),
  });
  await page.getByTestId("import-upload").click();
  await page.waitForURL(/\/import\/[^/]+$/, { timeout: 60_000 });
  await expect(page.getByTestId("import-step")).toHaveAttribute("data-step", "map");
  // Hydrated, so the controls are live rather than disabled-until-attached —
  // the two render differently and a shot taken in that window is a picture of
  // a page nobody uses.
  await expect(page.getByTestId("import-step")).toHaveAttribute("data-ready", "true");
  await page.waitForLoadState("load");
  await expect(page).toHaveScreenshot("import-map-light.png", { fullPage: true });
});

test("a selection looks right", async ({ page }) => {
  // Selection is a colour state, and colour drift is exactly what a pixel
  // baseline catches that an assertion does not — the too-subtle dark tint
  // that G5 fixed would have shown here.
  await page.goto("/jobs?set=all");
  await expect(page.locator('[data-testid="jobs-grid"][data-ready="true"]')).toBeAttached();
  // Two things moved at the redesign and both are here. Selection lives on
  // the CHECKBOX track now (01 §8) — a row click opens the detail pane — and
  // the Company cell is a composition, so it is matched on the name element
  // rather than on the cell's text.
  const row = (c: string) =>
    page.locator('[role="row"][data-key]').filter({
      has: page.locator(`[role="gridcell"][data-col="company"] span[title="${c}"]`),
    });
  const box = (c: string) => row(c).getByRole("checkbox", { name: /^Select / });
  await box("Fifth Third Bank").click();
  await box("Databricks").click({ modifiers: ["Shift"] });
  // The count moved into the selection BAR at the redesign; the standalone
  // `selection-count` element it used to live in is gone.
  await expect(page.getByTestId("selection-bar")).toContainText("3 selected");
  await expect(page).toHaveScreenshot("jobs-selected-light.png", { fullPage: true });
});

/**
 * The FP&A preset as a wizard draft — `users/dad/profile.yaml`'s title lists.
 *
 * Three of the 138 fixture postings carry an FP&A title (2.1%, under the 5%
 * floor), so this is the `engine-behind` coverage banner in its real form:
 * titles ARE set and the universe has almost none of them, which is Dad's
 * actual situation and the one worth a picture.
 */
const FPA_DRAFT =
  "eyJyb2xlX2ZhbWlseSI6ImZpbmFuY2lhbCBwbGFubmluZyAmIGFuYWx5c2lzIiwidGFnX2RvbWFpbiI6ImZpbmFuY2UiLCJib2FyZF9zZWFyY2hfdGVybSI6ImZpbmFuY2lhbCIsInRpdGxlc19pbmNsdWRlIjpbImZpbmFuY2lhbCBwbGFubmluZyIsImZwJmEiLCJmaW5hbmNpYWwgYW5hbHlzdCIsInNlbmlvciBmaW5hbmNpYWwgYW5hbHlzdCIsImZpbmFuY2UgbWFuYWdlciIsImZpbmFuY2lhbCByZXBvcnRpbmciLCJyZXBvcnRpbmcgbWFuYWdlciIsInRyZWFzdXJ5IiwidHJlYXN1cnkgYW5hbHlzdCIsInRyZWFzdXJ5IG1hbmFnZXIiLCJjb250cm9sbGVyIiwiYXNzaXN0YW50IGNvbnRyb2xsZXIiLCJhY2NvdW50aW5nIG1hbmFnZXIiLCJidWRnZXQgYW5hbHlzdCIsImNvcnBvcmF0ZSBmaW5hbmNlIiwiZmluYW5jZSBkaXJlY3RvciJdLCJ0aXRsZXNfZXhjbHVkZSI6WyJmaW5hbmNpYWwgYWR2aXNvciIsImZpbmFuY2lhbCByZXByZXNlbnRhdGl2ZSIsImluc3VyYW5jZSBhZ2VudCIsInNhbGVzIiwiaW50ZXJuIiwiaW50ZXJuc2hpcCIsIndlYWx0aCBtYW5hZ2VtZW50IiwicGVyc29uYWwgYmFua2VyIiwidGVsbGVyIl0sImNvdW50cmllcyI6WyJVbml0ZWQgU3RhdGVzIl0sIm1ldHJvcyI6W10sImdlb191bmtub3duIjoiZmlsdGVyIiwieW9lX21heCI6NCwieW9lX3Vua25vd24iOiJzZW5pb3JpdHktcHJveHkiLCJzZW5pb3JpdHlfZXhjbHVkZSI6W10sImNvbXBfbWluIjowLCJjb21wX3Vua25vd24iOiJrZWVwIiwid29ya19tb2RlbF9leGNsdWRlIjpbXX0";

test("the profile preview looks right", async ({ page, context }) => {
  // Earned for the /companies pair's reason: this panel's content is a set of
  // COLOUR claims no assertion checks. The warn-bordered title-coverage banner
  // says "the engine is not sweeping for this yet", and the selected radio card
  // says "this is your answer" — and that selected card already failed AA once
  // at 4.28:1 before axe first swept this page (matrix row 82's shape, on a new
  // surface). A token that drifts changes what the page CLAIMS, and only a
  // picture notices.
  //
  // Driven through the FP&A titles so the coverage banner is in the shot: the
  // fixture corpus carries three matching titles out of 138, under the 5%
  // floor, which is Dad's real situation.
  await context.addCookies([
    { name: "hq_demo_seed", value: "onboarding", url: "http://127.0.0.1:3210" },
  ]);
  // Navigated WITH the draft rather than by picking the preset and then
  // goto-ing step 6. The first version did the latter and the recorded shot
  // was of BASE_CRITERIA — a bare `goto` carries no `?d=`, so the wizard
  // opened on the committed baseline and the banner read "Only 0 of those 136
  // match your job titles", which is a different (and, as it turned out,
  // wrongly-worded) state. The picture was of a page the test did not mean to
  // take, which is the exact thing looking at a baseline is for.
  await page.goto(`/onboarding/${LAST_STEP}?d=${FPA_DRAFT}`);
  await expect(page.getByTestId("wizard")).toHaveAttribute("data-hydrated", "true");
  // The panel computes on arrival; a shot taken before it lands is a picture
  // of the running state, which is a different thing entirely.
  await expect(page.getByTestId("preview-panel")).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("load");
  await expect(page).toHaveScreenshot("onboarding-preview-light.png", { fullPage: true });
});

test("the search profile looks right", async ({ page }) => {
  // The settings form at rest: seven sections of chips, three radio groups and
  // two number fields, every one of which carries the selected/unselected
  // colour pair above. Also the one page whose section anchors other surfaces
  // link INTO, so a layout that silently loses a section is worth a picture.
  await page.goto("/settings");
  await expect(page.getByTestId("profile-form")).toHaveAttribute("data-hydrated", "true");
  await page.waitForLoadState("load");
  await expect(page).toHaveScreenshot("settings-light.png", { fullPage: true });
});

test("the preferences section looks right", async ({ page }) => {
  // The densest NEW composition in RM-34: four 200px selects and a switch,
  // each with a label above and help below, under a heading that carries the
  // autosave tick. Worth its own picture rather than being folded into the
  // profile's, because nothing else in this suite draws a switch — and the
  // switch is where the two hand-reasoned rules live (DEV-015's 6px control
  // radius against the mock's pill, DEV-016's 24px target around an 18px
  // track). Both are asserted numerically in `settings.spec.ts`; this is what
  // notices the track and the knob drifting apart, which no number would.
  await page.goto("/settings/preferences");
  await expect(page.getByTestId("preferences-form")).toHaveAttribute("data-hydrated", "true");
  await page.waitForLoadState("load");
  await expect(page).toHaveScreenshot("settings-preferences-light.png", { fullPage: true });
});

test("the entry column looks right", async ({ page }) => {
  // `/login` in `Auth.dc.html`'s 360px column. Under HQ_DEMO the build carries
  // no Supabase credentials, so this pictures the UNCONFIGURED deployment's
  // login page — the mark, the wordmark, the title, the setup line and the
  // legal links — and not the Google button, which renders only when
  // `NEXT_PUBLIC_SUPABASE_*` are inlined at build time. That is stated rather
  // than worked around: a baseline that mocked the button into existence would
  // be a picture of UI this configuration never serves.
  //
  // `/pending` still gets no baseline. It is unauthored design (ADD-020), and
  // pixel geometry recorded now would be a baseline for UI nobody approved.
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Log in", level: 1 })).toBeVisible();
  await page.waitForLoadState("load");
  await expect(page).toHaveScreenshot("login-light.png", { fullPage: true });
});

test("the connections list looks right", async ({ page }) => {
  // A new surface, and one whose whole first screen is prose: a headline
  // number, four instruction lines, and a list of people with two lines each.
  // Nothing here is asserted by geometry anywhere else, so this baseline is
  // the only thing that would notice the instruction block wrapping into the
  // upload button or the headline losing its emphasis.
  await page.goto("/connections");
  await expect(page.getByTestId("connections")).toHaveAttribute("data-hydrated", "true");
  await page.waitForLoadState("load");
  await expect(page).toHaveScreenshot("connections-light.png", { fullPage: true });
});

test("the warm-paths popover looks right", async ({ page }) => {
  // The one surface in this feature that no other baseline can contain: a
  // popover is absent from every at-rest shot by construction, and it carries
  // a link list, a name list and a colour-carrying chip. Matrix row 82's
  // lesson from the other direction — a state that is only reachable by
  // clicking is a state nothing has ever looked at.
  await page.goto("/jobs?set=all");
  await expect(page.locator('[data-testid="jobs-grid"][data-ready="true"]')).toBeAttached();
  // The NAME element, not the cell: the redesigned Company cell is avatar +
  // name + warm indicator, so an anchored regex over its text matches nothing.
  const company = page
    .locator('[role="gridcell"][data-col="company"] span[title]')
    .filter({ hasText: /^Ramp$/ });
  await page.locator('[role="row"]', { has: company }).getByTestId("warm-chip").click();
  await expect(page.getByTestId("warm-popover")).toBeVisible();
  await page.waitForLoadState("load");
  // The popover only, not the page: a full-page shot of a virtualized grid
  // with an open portal is mostly the grid, and the grid already has its own
  // baseline above.
  await expect(page.getByTestId("warm-popover")).toHaveScreenshot("warm-popover-light.png");
});

test("application answers look right", async ({ page }) => {
  // Sixteen rule cards, a disclosure, a library list and a set of company
  // exceptions, carrying three colour claims nothing else asserts: the warn
  // badge on every knockout rule, the "written by the app" tone that keeps a
  // machine row visibly apart from a person's, and the unreadable-fact line.
  // Matrix row 101's rule — a claim about colour belongs where the fonts and
  // the palette are pinned.
  await page.goto("/settings/answers");
  await expect(page.getByTestId("answers-surface")).toHaveAttribute("data-hydrated", "true");
  await page.waitForLoadState("load");
  await expect(page).toHaveScreenshot("answers-light.png", { fullPage: true });
});

test("a staged application looks right", async ({ page }) => {
  // The BLOCKED one, which is the shape a real board produces: a readiness
  // banner in its danger tone, a gap card per reason, and a provenance line
  // under every filled field. `/apply/8` (the green card) is deliberately not
  // shot as well — one baseline per shape, and the banner is the only thing
  // that differs between them.
  await page.goto("/apply/1");
  await expect(page.getByTestId("apply-surface")).toHaveAttribute("data-hydrated", "true");
  await page.waitForLoadState("load");
  await expect(page).toHaveScreenshot("apply-light.png", { fullPage: true });
});
