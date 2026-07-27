import { expect, test, type Page } from "@playwright/test";

/**
 * The answer library and its rules, driven through the real UI.
 *
 * What is worth a browser here rather than a unit test:
 *
 *   * A rule really LANDS, and survives a reload. The claim this whole suite
 *     once lacked (matrix row 31): every gesture asserted client state and
 *     nothing reloaded, so a write into a store nothing else reads passed.
 *   * An unset knockout rule is stated as an unanswered QUESTION, not as an
 *     error and not as a default. The metric this feature is judged on is "wrong
 *     knockout answers, zero, ever", and the surface's half of that is refusing
 *     to look answered.
 *   * A row the SERVER stamped `service` renders differently from one the user
 *     wrote, and says what it is not allowed to answer. That distinction only
 *     exists because `authored_by` is in the select — omit it and the row still
 *     renders, just wrongly (`lib/apply/index.ts`'s bold clause).
 *   * A rule stored in a shape this build cannot read says so, rather than
 *     rendering as an answer nobody can check. Reachable ONLY from a seed: no UI
 *     write can produce it, which is exactly why the seed carries one.
 *
 * Every wait is on a published state — `data-hydrated` to enter, `data-writes`
 * (monotonic, one per finished write including refusals) to pass a mark. Never
 * on quiet: `pending === 0` is true before a write starts too (matrix row 117).
 */

const ORIGIN = "http://127.0.0.1:3210";

/** Own demo store per test, keyed by project — matrix row 91. */
async function isolate(page: Page, id: string, seed?: string) {
  const project = test.info().project.name;
  const cookies = [{ name: "hq_demo_id", value: `answers-${project}-${id}`, url: ORIGIN }];
  if (seed) cookies.push({ name: "hq_demo_seed", value: seed, url: ORIGIN });
  await page.context().addCookies(cookies);
}

/** Enter the surface and wait until it is INTERACTIVE, not merely painted (row 206). */
async function gotoAnswers(page: Page) {
  await page.goto("/settings/answers");
  await expect(page.getByTestId("answers-surface")).toHaveAttribute("data-hydrated", "true");
}

async function writeCount(page: Page): Promise<number> {
  const raw = await page.getByTestId("answers-surface").getAttribute("data-writes");
  return Number(raw ?? 0);
}

/**
 * The nine non-knockout topics live behind a disclosure, so a test that clicks
 * one without opening it waits thirty seconds for an element that is in the DOM
 * and not visible — which is what the first version of two of these did.
 */
async function openMoreTopics(page: Page) {
  await page.getByTestId("more-topics").locator("summary").click();
}

async function wroteMore(page: Page, before: number, n = 1) {
  await expect
    .poll(() => writeCount(page), {
      message: `expected ${n} more finished write(s)`,
      // One write's own budget per awaited write.
      timeout: 15_000 * n,
    })
    .toBeGreaterThanOrEqual(before + n);
}

test("reaches the surface from /settings, and says what each half decides", async ({ page }) => {
  await isolate(page, "link");
  await page.goto("/settings");
  await expect(page.getByTestId("profile-form")).toHaveAttribute("data-hydrated", "true");
  await page.getByTestId("answers-link").click();
  await expect(page.getByRole("heading", { name: "Application answers" })).toBeVisible();
  await expect(page.getByTestId("answers-surface")).toHaveAttribute("data-hydrated", "true");
});

test("an unset knockout rule reads as a question, never as an answer", async ({ page }) => {
  await isolate(page, "unset");
  await gotoAnswers(page);

  // Seeded WITHOUT a background-check rule on purpose: this is the state the
  // whole design is about, and a demo where everything is answered would never
  // show it.
  const row = page.getByTestId("topic-background_check_consent");
  await expect(row).toHaveAttribute("data-set", "false");
  await expect(row).toContainText("Not set");
  await expect(row).toContainText("Ends an application if wrong");
  // No control is pre-selected. A preselected radio on a knockout question is
  // the failure `lib/apply/index.ts` forbids in as many words.
  await row.getByTestId("topic-background_check_consent-edit").click();
  await expect(row.locator('input[type="radio"]:checked')).toHaveCount(0);

  // The banner counts them, so the number is on screen rather than implied.
  await expect(page.getByTestId("answers-surface")).toHaveAttribute("data-unset-knockouts", "3");
});

test("answering a knockout rule lands, and survives a reload", async ({ page }) => {
  await isolate(page, "save-rule");
  await gotoAnswers(page);

  const before = await writeCount(page);
  await page.getByTestId("topic-background_check_consent-edit").click();
  await page
    .getByTestId("topic-background_check_consent-boolean")
    .getByRole("radio", { name: "Yes" })
    .check();
  await wroteMore(page, before);

  await expect(page.getByTestId("topic-background_check_consent-value")).toContainText("Yes");
  await expect(page.getByTestId("answers-surface")).toHaveAttribute("data-unset-knockouts", "2");

  // The half that matters: the server has it, not just this render.
  await page.reload();
  await expect(page.getByTestId("answers-surface")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByTestId("topic-background_check_consent")).toHaveAttribute(
    "data-set",
    "true",
  );
  await expect(page.getByTestId("topic-background_check_consent-value")).toContainText("Yes");
});

test("a typed rule commits on Save and not before", async ({ page }) => {
  await isolate(page, "typed");
  await gotoAnswers(page);
  await openMoreTopics(page);

  await page.getByTestId("topic-current_location-edit").click();
  const save = page.getByTestId("topic-current_location-save");
  // Nothing typed yet, so there is nothing to save. A control that writes on
  // every keystroke conflicts with itself against a version token.
  await expect(save).toBeDisabled();

  const before = await writeCount(page);
  await page.getByTestId("topic-current_location-text").fill("Chicago, IL");
  await expect(save).toBeEnabled();
  expect(await writeCount(page)).toBe(before);

  await save.click();
  await wroteMore(page, before);
  await expect(page.getByTestId("topic-current_location-value")).toContainText("Chicago, IL");
});

test("removing a rule leaves the question unanswered rather than answered No", async ({ page }) => {
  await isolate(page, "remove");
  await gotoAnswers(page);

  await expect(page.getByTestId("topic-visa_sponsorship")).toHaveAttribute("data-set", "true");
  const before = await writeCount(page);
  await page.getByTestId("topic-visa_sponsorship-edit").click();
  await page.getByTestId("topic-visa_sponsorship-remove").click();
  await wroteMore(page, before);

  await expect(page.getByTestId("topic-visa_sponsorship")).toHaveAttribute("data-set", "false");
  await expect(page.getByTestId("topic-visa_sponsorship-value")).toContainText("Not set");
  await page.reload();
  await expect(page.getByTestId("answers-surface")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByTestId("topic-visa_sponsorship")).toHaveAttribute("data-set", "false");
});

test("a machine-written answer is marked, and says what it may not answer", async ({ page }) => {
  await isolate(page, "provenance");
  await gotoAnswers(page);

  const key = "will you now or in the future require visa sponsorship";
  const row = page.getByTestId(`answer-${key}`);
  await expect(row.getByTestId(`answer-${key}-provenance`)).toHaveText("Written by the app");
  await expect(row).toContainText("Not used on work authorization");

  // …and one the person wrote is rendered as theirs. A test asserting only the
  // first would pass on a surface that labelled everything the same way.
  const mine = page.getByTestId("answer-are you legally authorized to work in the united states");
  await expect(
    mine.getByTestId("answer-are you legally authorized to work in the united states-provenance"),
  ).toHaveText("You wrote this");
});

test("editing an answer stores it as the person's own", async ({ page }) => {
  await isolate(page, "edit-answer");
  await gotoAnswers(page);

  const key = "how did you hear about this job";
  const before = await writeCount(page);
  await page.getByTestId(`answer-${key}-input`).fill("A friend who works there");
  await page.getByTestId(`answer-${key}-save`).click();
  await wroteMore(page, before);

  await page.reload();
  await expect(page.getByTestId("answers-surface")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByTestId(`answer-${key}-input`)).toHaveValue("A friend who works there");
});

test("a new answer can be added by hand and comes back keyed by its question", async ({ page }) => {
  await isolate(page, "add-answer");
  await gotoAnswers(page);

  const before = await writeCount(page);
  await page.getByTestId("add-answer-question").fill("What is your GitHub profile?");
  await page.getByTestId("add-answer-value").fill("https://github.com/example");
  await page.getByTestId("add-answer-save").click();
  await wroteMore(page, before);

  await page.reload();
  await expect(page.getByTestId("answers-surface")).toHaveAttribute("data-hydrated", "true");
  // Keyed by the NORMALIZED question, which is the identity the store enforces.
  await expect(page.getByTestId("answer-what is your github profile")).toContainText(
    "What is your GitHub profile?",
  );
});

test("adding by hand over a differently-punctuated answer says it is a replacement", async ({
  page,
}) => {
  await isolate(page, "add-collision");
  await gotoAnswers(page);

  // The surface used to look the previous row up by RAW question text while the
  // store keys it on the normalized form. So this typed what looked like a new
  // question, found nothing, sent `expectedUpdatedAt: null` — and 0014 skips the
  // version check when that is null — and replaced a stored KNOCKOUT answer with
  // no warning of any kind.
  const stored = "answer-are you legally authorized to work in the united states";
  await expect(page.getByTestId(`${stored}-input`)).toHaveValue("Yes");
  const rows = page.getByTestId("library-list").locator("li");
  const countBefore = await rows.count();

  await page
    .getByTestId("add-answer-question")
    .fill("ARE YOU LEGALLY AUTHORIZED TO WORK IN THE UNITED STATES");
  await page.getByTestId("add-answer-value").fill("No");
  // Said BEFORE the click, which is the half the identity fix alone does not buy:
  // a version check turns a clobber into a conflict, and it still would not have
  // told anybody which row they were about to change.
  await expect(page.getByTestId("add-answer-collision")).toContainText(
    "Are you legally authorized to work in the United States?",
  );
  await expect(page.getByTestId("add-answer-save")).toHaveText("Replace answer");

  const before = await writeCount(page);
  await page.getByTestId("add-answer-save").click();
  await wroteMore(page, before);

  // One row, not two, carrying the value they typed — and located by identity, so
  // the write went out with the row's real version token.
  await page.reload();
  await expect(page.getByTestId("answers-surface")).toHaveAttribute("data-hydrated", "true");
  await expect(rows).toHaveCount(countBefore);
  await expect(page.getByTestId(`${stored}-input`)).toHaveValue("No");
});

test("a one-company answer says so, and its scope survives an edit", async ({ page }) => {
  await isolate(page, "scoped-row");
  await gotoAnswers(page);

  const scoped = "answer-how did you hear about this job@stripe";
  await expect(page.getByTestId(`${scoped}-scope`)).toHaveText("Only at stripe");
  // The global answer to the same question is its own row, with its own value.
  await expect(page.getByTestId("answer-how did you hear about this job-input")).toHaveValue(
    "Company website",
  );

  const before = await writeCount(page);
  await page.getByTestId(`${scoped}-input`).fill("A friend on the ledger team");
  await page.getByTestId(`${scoped}-save`).click();
  await wroteMore(page, before);

  await page.reload();
  await expect(page.getByTestId("answers-surface")).toHaveAttribute("data-hydrated", "true");
  // Still Stripe's, and the global one is untouched. Editing a scoped answer into
  // a global one would be the same bug through a different door.
  await expect(page.getByTestId(`${scoped}-input`)).toHaveValue("A friend on the ledger team");
  await expect(page.getByTestId("answer-how did you hear about this job-input")).toHaveValue(
    "Company website",
  );
});

test("an answer can be removed, and the question goes back to unanswered", async ({ page }) => {
  await isolate(page, "remove-answer");
  await gotoAnswers(page);

  // 0014 had no delete and the page said so. It matters most for the answer
  // somebody regrets least reversibly: a recorded "I don't wish to answer",
  // whose only other exit was to overwrite it with an answer they had chosen
  // not to give.
  const declined = "answer-veteran status";
  await expect(page.getByTestId(`${declined}-provenance`)).toHaveText("You chose not to answer");

  const before = await writeCount(page);
  await page.getByTestId(`${declined}-remove`).click();
  await wroteMore(page, before);

  await expect(page.getByTestId(declined)).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("answers-surface")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByTestId(declined)).toHaveCount(0);
  // …and the board asks it again rather than staging a refusal nobody can undo.
  await page.goto("/apply/1");
  await expect(page.getByTestId("apply-surface")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByTestId("gap-demographic_5002")).toHaveAttribute(
    "data-reason",
    "self-identification",
  );
});

test("a company exception is listed against its company, and can be turned off", async ({
  page,
}) => {
  await isolate(page, "exceptions");
  await gotoAnswers(page);

  const stripe = page.getByTestId("exception-prior_employment-stripe");
  await expect(stripe).toContainText("stripe");
  await expect(stripe).toContainText("Yes");

  const before = await writeCount(page);
  await stripe.getByTestId("exception-prior_employment-stripe-enabled").uncheck();
  await wroteMore(page, before);
  await page.reload();
  await expect(page.getByTestId("answers-surface")).toHaveAttribute("data-hydrated", "true");
  await expect(
    page.getByTestId("exception-prior_employment-stripe-enabled"),
  ).not.toBeChecked();
});

test("a rule stored in an unreadable shape says so instead of showing an answer", async ({
  page,
}) => {
  await isolate(page, "unreadable");
  await gotoAnswers(page);

  // Only a writer that is not this UI can produce this row — the settings action
  // runs the same `parseSituationFact` the reader does — so the seed is what
  // makes the branch reachable at all (matrix row 15's rule).
  await openMoreTopics(page);
  await expect(page.getByTestId("topic-how_did_you_hear")).toHaveAttribute(
    "data-unreadable",
    "true",
  );
  await expect(page.getByTestId("topic-how_did_you_hear-value")).toContainText("cannot read");
  // …and it does not count as answered anywhere: "a rule exists" and "a question
  // gets answered" are different facts, and the count on screen follows the
  // second one.
  await expect(page.getByTestId("topic-how_did_you_hear")).toHaveAttribute("data-set", "false");
});

test("a failed write leaves nothing on screen that the server does not have", async ({ page }) => {
  await isolate(page, "failnext");
  await page
    .context()
    .addCookies([{ name: "hq_demo_fail", value: "Network unavailable", url: ORIGIN }]);
  await gotoAnswers(page);

  const before = await writeCount(page);
  await page.getByTestId("topic-age_eligibility-edit").click();
  await page.getByTestId("topic-age_eligibility-boolean").getByRole("radio", { name: "Yes" }).check();
  await wroteMore(page, before);

  await expect(page.getByText("Couldn't save that.")).toBeVisible();
  // The optimistic frame is never applied here — the row settles on the SERVER's
  // answer or on nothing — so the value must still read as unset after a reload.
  await page.context().clearCookies({ name: "hq_demo_fail" });
  await page.reload();
  await expect(page.getByTestId("answers-surface")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByTestId("topic-age_eligibility")).toHaveAttribute("data-set", "false");
});

test("with nothing saved, the surface says so instead of rendering blank cards", async ({
  page,
}) => {
  await isolate(page, "empty", "no-answers");
  await gotoAnswers(page);

  await expect(page.getByTestId("library-empty")).toBeVisible();
  await expect(page.getByTestId("exceptions-empty")).toBeVisible();
  // All seven knockout topics unanswered, and the count on screen rather than a
  // reader having to add them up.
  await expect(page.getByTestId("answers-surface")).toHaveAttribute("data-unset-knockouts", "7");
});
