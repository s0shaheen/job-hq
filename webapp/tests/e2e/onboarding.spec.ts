import { expect, test, type Page } from "@playwright/test";

/**
 * The two-step wizard, and the guard that sends a new user to it.
 *
 * Every gate here is on `data-step`, which the SERVER renders from the route
 * segment. Not a client counter: matrix row 164 is an import wizard whose
 * `data-writes` counter unmounted with the step that incremented it, so all
 * four journey tests failed identically with the write path gutted. A value
 * derived from the URL cannot advance before the navigation happened and cannot
 * be reset by a remount.
 *
 * The claims that need a browser rather than a unit test:
 *
 *   * The draft survives a REFRESH and a BACK (row 87). It lives in `?d=`, and
 *     the only way to know that works is to reload a real page.
 *   * FOCUS moves to the new step's heading (row 94). Without it a
 *     screen-reader user hears nothing at all when the step changes.
 *   * ONE typed field finishes setup. The six-step version demanded a role
 *     family, a board keyword and a title list before it would advance past
 *     step one.
 *   * Pay is typed in DOLLARS and comes back formatted. It used to be a number
 *     labelled "in thousands" with a maximum of 2000.
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

/** Answer the one question setup cannot be finished without. */
async function nameTheJob(page: Page, role: string) {
  await page.locator("#role_family").fill(role);
  await expect(page.getByTestId("next-button")).toBeEnabled();
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

test("setup is two steps, and the second one carries the preview", async ({ page }) => {
  // The step collapse, asserted on the server's own count rather than on the
  // label: six screens is what the owner ran and rejected, and a regression
  // that re-added one would otherwise only show up as a longer test.
  await asNewUser(page, "forward");
  await gotoStep(page, 1);
  await expect(page.locator("[data-last-step]")).toHaveAttribute("data-last-step", "2");
  await expect(page.getByTestId("step-label")).toHaveText("Step 1 of 2");

  await nameTheJob(page, "nurse practitioner");
  await next(page, 2);

  // The preview renders INLINE under the last questions and computes on arrival.
  // It was a sixth step of its own, which read as a checkpoint to get past.
  await expect(page.getByTestId("preview-panel")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#comp_min")).toBeVisible();
  await expect(page.getByTestId("finish-button")).toBeEnabled({ timeout: 15_000 });
});

test("step one is a blank box, not a choice between two professions", async ({ page }) => {
  // The owner's second complaint. Step one used to be three radio cards, two of
  // them job families he happens to be in, and everyone else had to pick
  // "Something else" before the app would talk to them.
  await asNewUser(page, "agnostic");
  await gotoStep(page, 1);

  await expect(page.locator("#role_family")).toHaveValue("");
  await expect(page.getByRole("radio")).toHaveCount(0);
  // The curated lists survive as templates, at the bottom and secondary.
  await expect(page.getByTestId("templates")).toBeVisible();
  await expect(page.getByTestId("template-fpa")).toBeVisible();
});

test("one typed field is a whole profile", async ({ page }) => {
  // `board_search_term` and `titles_include` are the engine's vocabulary, not
  // anyone's, and the old wizard refused to advance until both were answered by
  // hand. They now derive from the role, VISIBLY, into fields that stay
  // editable — which is the difference between a default and a guess.
  await asNewUser(page, "one-field");
  await gotoStep(page, 1);
  await expect(page.getByTestId("next-button")).toBeDisabled();
  await expect(page.getByTestId("step-blocker")).toContainText(/tell us the job/i);

  await nameTheJob(page, "clinical research coordinator");
  await expect(page.getByTestId("titles_include-chips")).toContainText(
    "clinical research coordinator",
  );
  await expect(page.getByTestId("step-blocker")).toHaveCount(0);

  await next(page, 2);
  await expect(page.getByTestId("preview-panel")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("finish-button").click();
  await expect(page).toHaveURL(/\/queue$/, { timeout: 15_000 });

  // …and what got stored is what was typed, not a product-management search
  // borrowed from the committed baseline.
  await page.goto("/settings");
  await expect(page.getByTestId("titles_include-chips")).toContainText(
    "clinical research coordinator",
  );
  await expect(page.locator("#board_search_term")).toHaveValue("clinical");
});

test("a template fills the tuned list instead of framing the question", async ({ page }) => {
  await asNewUser(page, "template");
  await gotoStep(page, 1);
  await page.getByTestId("template-fpa").click();

  await expect(page.locator("#role_family")).toHaveValue("financial planning & analysis");
  // The lists nobody should have to rediscover: `financial advisor` is excluded
  // because an FP&A search without it is 60% insurance sales.
  await expect(page.getByTestId("titles_include-chips")).toContainText("fp&a");
  await expect(page.getByTestId("titles_exclude-chips")).toContainText("financial advisor");

  // …and a template is a starting point, not a lock. Typing over the role does
  // not wipe the list it came with.
  await page.locator("#role_family").fill("treasury analyst");
  await expect(page.getByTestId("titles_include-chips")).toContainText("fp&a");
});

test("pay is typed in dollars and comes back formatted", async ({ page }) => {
  // "Minimum pay, in thousands", maximum 2000, is what the owner met on his
  // first run and read as a $2,000 ceiling. It was.
  await asNewUser(page, "money");
  await gotoStep(page, 1);
  await nameTheJob(page, "data analyst");
  await next(page, 2);

  const pay = page.locator("#comp_min");
  await expect(pay).toHaveValue("");
  await pay.fill("200k");
  await pay.blur();
  await expect(pay).toHaveValue("$200,000");

  // The other two spellings of the same salary land on the same number.
  await pay.fill("$200,000");
  await pay.blur();
  await expect(pay).toHaveValue("$200,000");
  await pay.fill("200000");
  await pay.blur();
  await expect(pay).toHaveValue("$200,000");

  // And it survives the save, in the unit the gate stores.
  await expect(page.getByTestId("preview-panel")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("finish-button").click();
  await expect(page).toHaveURL(/\/queue$/, { timeout: 15_000 });
  await page.goto("/settings");
  await expect(page.locator("#comp_min")).toHaveValue("$200,000");
});

test("answers survive a refresh and a Back", async ({ page }) => {
  await asNewUser(page, "draft");
  await gotoStep(page, 1);

  await page.getByTestId("template-fpa").click();
  await expect(page.getByTestId("titles_include-chips")).toContainText("fp&a");
  await next(page, 2);

  await page.locator("#metros-input").fill("Chicago");
  await page.locator("#metros-input").press("Enter");
  await expect(page.getByTestId("metros-chips")).toContainText("Chicago");

  // A refresh at step 2 (matrix row 87). The answers are in the URL, so there
  // is nowhere else for them to have gone.
  await page.reload();
  await expect(page.getByTestId("wizard")).toHaveAttribute("data-hydrated", "true");
  await atStep(page, 2);
  await expect(page.getByTestId("metros-chips")).toContainText("Chicago");

  // …and Back to step 1 still shows what was chosen there.
  await page.goBack();
  await atStep(page, 1);
  await expect(page.getByTestId("titles_include-chips")).toContainText("fp&a");
});

test("focus lands on each step's heading", async ({ page }) => {
  // Matrix row 94. The URL moved and the DOM swapped; without this, focus stays
  // on a Next button that no longer exists and a screen reader says nothing.
  await asNewUser(page, "focus");
  await gotoStep(page, 1);
  await expect(page.getByTestId("step-heading")).toBeFocused();
  await nameTheJob(page, "data analyst");
  await next(page, 2);
  await expect(page.getByTestId("step-heading")).toBeFocused();
});

test("a draft too long for a URL says so instead of losing the answers", async ({ page }) => {
  // The wizard keeps its answers in `?d=`, which has a ceiling — and crossing it
  // used to be silent AND unrecoverable: `encodeDraft` returned "", the caller
  // wrote a bare `?d=`, the sync effect rewrote the URL from the baseline, and
  // Back could not reach the answers because the entry holding them had already
  // been overwritten. Browser-verified by the reviewer at ~2.9 kB of chips.
  await asNewUser(page, "too-long");
  await gotoStep(page, 1);
  await nameTheJob(page, "data analyst");

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
  await expect(warning).toContainText(/nothing is lost/i);
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
  await expect(page).toHaveURL(/\/onboarding\/2/);
  await page.goto("/onboarding/banana");
  await expect(page).toHaveURL(/\/onboarding\/1/);
});

test("finishing lands in the app and the guard stops firing", async ({ page }) => {
  await asNewUser(page, "finish");
  await gotoStep(page, 1);
  await nameTheJob(page, "operations manager");
  await next(page, 2);
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
