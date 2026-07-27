import { expect, test, type Page } from "@playwright/test";

/**
 * The six-step wizard, and the guard that sends a new user to it.
 *
 * Every gate here is on `data-step`, which the SERVER renders from the route
 * segment. Not a client counter: matrix row 164 is an import wizard whose
 * `data-writes` counter unmounted with the step that incremented it, so all
 * four journey tests failed identically with the write path gutted. A value
 * derived from the URL cannot advance before the navigation happened and cannot
 * be reset by a remount.
 *
 * The two claims that need a browser rather than a unit test:
 *
 *   * The draft survives a REFRESH and a BACK (row 87). It lives in `?d=`, and
 *     the only way to know that works is to reload a real page.
 *   * FOCUS moves to the new step's heading (row 94). Without it a
 *     screen-reader user hears nothing at all when the step changes.
 */

const ORIGIN = "http://127.0.0.1:3210";

/** A demo store whose profile has never been set up: `criteria = '{}'`. */
async function asNewUser(page: Page, id: string) {
  const project = test.info().project.name;
  await page.context().addCookies([
    { name: "hq_demo_id", value: `${project}-onb-${id}`, url: ORIGIN },
    { name: "hq_demo_seed", value: "onboarding", url: ORIGIN },
  ]);
}

async function step(page: Page): Promise<string> {
  return (await page.locator("[data-step]").getAttribute("data-step")) ?? "";
}

/** Wait for a step rather than sampling it — an instant read races the render. */
async function atStep(page: Page, n: number) {
  await expect.poll(async () => step(page), { timeout: 15_000 }).toBe(String(n));
}

/**
 * Enter the wizard and wait until it is INTERACTIVE.
 *
 * `data-step` is a SERVER fact and lands with the HTML, so it says nothing about
 * whether a click will reach a handler. `data-hydrated` flips in an effect and
 * cannot be true before the handlers exist. Both are needed: one for which step,
 * one for whether it can be driven (the pipeline's lesson, matrix row 21's
 * family).
 */
async function gotoStep(page: Page, n: number, query = "") {
  await page.goto(`/onboarding/${n}${query}`);
  await expect(page.getByTestId("wizard")).toHaveAttribute("data-hydrated", "true");
  await atStep(page, n);
}

async function next(page: Page, to: number) {
  await page.getByTestId("next-button").click();
  await atStep(page, to);
  // The step advanced on the server; the new step's handlers are a separate
  // fact, and the next gesture in the test is about to need them.
  await expect(page.getByTestId("wizard")).toHaveAttribute("data-hydrated", "true");
}

test("a user who never finished setup is sent to the wizard", async ({ page }) => {
  // Matrix row 93. Every surface in the app renders correctly and EMPTY for
  // this person, which on day one reads as "the product does not work".
  await asNewUser(page, "guard");
  await page.goto("/queue");
  // `(\?|$)`: the wizard writes the draft into its own entry as soon as it
  // hydrates, so the settled URL carries `?d=…`. Anchoring on the end of the
  // path would be asserting that the draft-in-the-URL feature is absent.
  await expect(page).toHaveURL(/\/onboarding\/1(\?|$)/);
  await expect(page.getByTestId("step-heading")).toBeVisible();
});

test("the guard covers every app surface, not just the queue", async ({ page }) => {
  // A guard on one route is a guard somebody routes around with a bookmark.
  await asNewUser(page, "guard-all");
  for (const path of ["/jobs", "/pipeline", "/settings", "/companies", "/import"]) {
    await page.goto(path);
    await expect(page, `${path} did not redirect`).toHaveURL(/\/onboarding\/1(\?|$)/);
  }
});

test("six steps forward, and the last one is the preview", async ({ page }) => {
  await asNewUser(page, "forward");
  await gotoStep(page, 1);

  await next(page, 2);
  await next(page, 3);
  await next(page, 4);
  await next(page, 5);
  await next(page, 6);

  // Step 6 runs the check on arrival — a step whose whole purpose is a number
  // and which asks you to press a button to see it looks broken.
  await expect(page.getByTestId("preview-panel")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("finish-button")).toBeEnabled({ timeout: 15_000 });
  // "Back to change something" is as prominent as finishing, by design.
  await expect(page.getByTestId("back-button")).toContainText("Back to change something");
});

test("answers survive a refresh and a Back", async ({ page }) => {
  await asNewUser(page, "draft");
  await gotoStep(page, 1);

  // Pick the FP&A preset, then go on and change something two steps later.
  await page.getByRole("radio", { name: "Financial planning & analysis" }).check();
  await next(page, 2);
  await expect(page.getByTestId("titles_include-chips")).toContainText("fp&a");

  await next(page, 3);
  await page.locator("#metros-input").fill("Chicago");
  await page.locator("#metros-input").press("Enter");
  await next(page, 4);

  // A refresh at step 4 (matrix row 87). The answers are in the URL, so there
  // is nowhere else for them to have gone.
  await page.reload();
  await expect(page.getByTestId("wizard")).toHaveAttribute("data-hydrated", "true");
  await atStep(page, 4);

  // …and Back to step 2 still shows what was chosen there.
  await page.goBack();
  await atStep(page, 3);
  await expect(page.getByTestId("metros-chips")).toContainText("Chicago");
  await page.goBack();
  await atStep(page, 2);
  await expect(page.getByTestId("titles_include-chips")).toContainText("fp&a");
});

test("'Something else' cannot be stored as a product-management search", async ({ page }) => {
  // The lie this gate replaced: the preset sets the three free-text fields to
  // "" on purpose, `parseCriteria` filled them in from the committed baseline,
  // and somebody who said "something else" got `role_family: "product manager"`
  // stored under their name with nothing on screen saying so. The fallback is
  // gone, which turns the silent lie into an unanswerable profile — so the
  // wizard asks.
  await asNewUser(page, "other-preset");
  await gotoStep(page, 1);
  await page.getByRole("radio", { name: "Something else" }).check();

  await expect(page.getByTestId("next-button")).toBeDisabled();
  await expect(page.getByTestId("step-blocker")).toContainText(/name the kind of role/i);

  await page.locator("#role_family").fill("clinical research coordination");
  // Still blocked: the corpus-wide boards have no company list to walk and are
  // searched by keyword, so a blank one silently drops a whole source.
  await expect(page.getByTestId("next-button")).toBeDisabled();
  await expect(page.getByTestId("step-blocker")).toContainText(/search word/i);

  await page.locator("#board_search_term").fill("clinical");
  await expect(page.getByTestId("next-button")).toBeEnabled();

  // Step 2 gates on the same principle for the same reason: an empty include
  // list matches nothing, so the queue would be empty by construction.
  await next(page, 2);
  await expect(page.getByTestId("next-button")).toBeDisabled();
  await expect(page.getByTestId("step-blocker")).toContainText(/at least one job title/i);
  await page.locator("#titles_include-input").fill("clinical research coordinator");
  await page.locator("#titles_include-input").press("Enter");
  await expect(page.getByTestId("next-button")).toBeEnabled();
});

test("focus lands on each step's heading", async ({ page }) => {
  // Matrix row 94. The URL moved and the DOM swapped; without this, focus stays
  // on a Next button that no longer exists and a screen reader says nothing.
  await asNewUser(page, "focus");
  await gotoStep(page, 1);
  await next(page, 2);
  await expect(page.getByTestId("step-heading")).toBeFocused();
  await next(page, 3);
  await expect(page.getByTestId("step-heading")).toBeFocused();
});

test("a draft too long for a URL says so instead of losing the answers", async ({ page }) => {
  // The wizard keeps its answers in `?d=`, which has a ceiling — and crossing it
  // used to be silent AND unrecoverable: `encodeDraft` returned "", the caller
  // wrote a bare `?d=`, the sync effect rewrote the URL from the baseline, and
  // Back could not reach the answers because the entry holding them had already
  // been overwritten. Browser-verified by the reviewer at ~2.9 kB of chips.
  await asNewUser(page, "too-long");
  await gotoStep(page, 2);

  // One very long title at a time until the ceiling is crossed. Each is capped at
  // 120 characters by `parseCriteria`, so this takes a few dozen.
  const long = "x".repeat(115);
  const warning = page.getByTestId("draft-too-long");
  for (let i = 0; i < 45; i += 1) {
    await page.locator("#titles_include-input").fill(`${long}${i}`);
    await page.locator("#titles_include-input").press("Enter");
    if (await warning.isVisible()) break;
  }

  await expect(warning).toBeVisible();
  await expect(warning).toContainText(/nothing has been lost/i);
  // Refusing to navigate is what keeps the answers on screen to be shortened.
  await expect(page.getByTestId("next-button")).toBeDisabled();

  // And it recovers: remove enough and the wizard carries on.
  for (let i = 0; i < 45; i += 1) {
    if (!(await warning.isVisible())) break;
    await page.getByTestId("titles_include-remove").first().click();
  }
  await expect(warning).toHaveCount(0);
  await expect(page.getByTestId("next-button")).toBeEnabled();
});

test("an out-of-range step is a real page, not a 404", async ({ page }) => {
  await asNewUser(page, "clamp");
  await page.goto("/onboarding/99");
  await expect(page).toHaveURL(/\/onboarding\/6/);
  await page.goto("/onboarding/banana");
  await expect(page).toHaveURL(/\/onboarding\/1/);
});

test("finishing lands in the app and the guard stops firing", async ({ page }) => {
  await asNewUser(page, "finish");
  await gotoStep(page, 6);
  await expect(page.getByTestId("preview-panel")).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("finish-button").click();
  await expect(page).toHaveURL(/\/queue$/, { timeout: 15_000 });

  // The half that matters: the profile really landed, so returning to an app
  // surface no longer bounces. A wizard that "finishes" into a redirect loop is
  // the worst version of this feature.
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings$/);
  expect(await page.locator("[data-onboarded]").getAttribute("data-onboarded")).toBe("yes");
});

test("somebody who has already set up is not shown the wizard again", async ({ page }) => {
  // No `onboarding` seed here: the default demo store has a complete profile.
  const project = test.info().project.name;
  await page
    .context()
    .addCookies([{ name: "hq_demo_id", value: `${project}-onb-done`, url: ORIGIN }]);
  // Plain goto, not `gotoStep`: this address is expected to REDIRECT, so
  // waiting for the wizard to hydrate would be waiting for a page that never
  // renders.
  await page.goto("/onboarding/1");
  await expect(page).toHaveURL(/\/settings$/);
});
