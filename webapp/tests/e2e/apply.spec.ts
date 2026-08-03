import { expect, test, type Page } from "@playwright/test";

/**
 * Prepare and Review, driven through the real UI.
 *
 * The claims that only exist once a browser has the page:
 *
 *   * **A gap is rendered as a question.** Every unanswered field says what is
 *     missing and why nothing guessed it, and the knockout ones open with NOTHING
 *     selected. "wrong knockout answers (must be zero, ever)" has a surface half,
 *     and this is it.
 *   * **`ready` says what it is not.** The green card names the opinion and the
 *     absence of permission in the same breath, because `batchApprovable` is the
 *     gesture the plan authorises and blind-batch is the one it forbids.
 *   * **The attachment truth is on screen.** Every real Greenhouse posting asks
 *     for a résumé and Prepare does not attach, so the one demo board that CAN
 *     reach `ready` is the one with no file question — and the blocked ones say
 *     why in as many words rather than excusing the file from the count.
 *   * **Answering a gap writes to the library**, and the field is then answered
 *     by the ENGINE on the next render rather than patched on screen. That is the
 *     growth loop, and the difference is visible only after the round trip.
 *   * **Four refusals, four screens.** Another ATS, a URL with no board, a
 *     posting that is gone, a row with nothing to go on.
 *
 * Fixture rows drive all of it: 1 Stripe (rich), 4 Ramp (blocked by the résumé
 * alone), 8 Modern Treasury (ready), 2 Plaid (Ashby), 6 Affirm (Greenhouse, no
 * demo payload — the "gone" case), 3 Anthropic (no key, no board link).
 */

const ORIGIN = "http://127.0.0.1:3210";

/** Own demo store per test, keyed by project — matrix row 91. */
async function isolate(page: Page, id: string, seed?: string) {
  const project = test.info().project.name;
  const cookies = [{ name: "hq_demo_id", value: `apply-${project}-${id}`, url: ORIGIN }];
  if (seed) cookies.push({ name: "hq_demo_seed", value: seed, url: ORIGIN });
  await page.context().addCookies(cookies);
}

/** Enter the surface and wait until it is INTERACTIVE, not merely painted (row 206). */
async function gotoApply(page: Page, id: number) {
  await page.goto(`/apply/${id}`);
  await expect(page.getByTestId("apply-surface")).toHaveAttribute("data-hydrated", "true");
}

async function writeCount(page: Page): Promise<number> {
  const raw = await page.getByTestId("apply-surface").getAttribute("data-writes");
  return Number(raw ?? 0);
}

async function wroteMore(page: Page, before: number, n = 1) {
  await expect
    .poll(() => writeCount(page), {
      message: `expected ${n} more finished write(s)`,
      timeout: 15_000 * n,
    })
    .toBeGreaterThanOrEqual(before + n);
}

test("a Greenhouse row stages every question, with its provenance", async ({ page }) => {
  await isolate(page, "stripe");
  await gotoApply(page, 1);

  const surface = page.getByTestId("apply-surface");
  await expect(surface).toHaveAttribute("data-readiness", "blocked");
  await expect(surface).toHaveAttribute("data-batch-approvable", "false");

  // A library answer the person wrote themselves, on this exact question — the
  // only route by which a stored row may answer a knockout field.
  await expect(page.getByTestId("field-question_1001-value")).toHaveText("Yes");
  await expect(page.getByTestId("field-question_1001-layer")).toHaveText("Saved answer");

  // A rule-derived answer, WITH the direction it was read in. Showing the topic
  // alone is what made the polarity bug invisible for a whole build.
  await expect(page.getByTestId("field-question_1002-value")).toHaveText("No");
  await expect(page.getByTestId("field-question_1002-source")).toContainText("Visa sponsorship");
  await expect(page.getByTestId("field-question_1002-source")).toContainText("read as asked");
  // The submitted token is named beside the label rather than shown instead of it.
  await expect(page.getByTestId("field-question_1002-source")).toContainText("submits as 0");
});

test("a knockout question with no rule is a question, with nothing selected", async ({ page }) => {
  await isolate(page, "knockout");
  await gotoApply(page, 1);

  // `age_eligibility` and `background_check_consent` have no rule in the fixture
  // library, on purpose: this is the state the whole design exists to produce.
  const gap = page.getByTestId("gap-question_1003");
  await expect(gap).toHaveAttribute("data-reason", "policy-unset");
  await expect(gap).toHaveAttribute("data-required", "true");
  await expect(gap).toContainText("No rule for this");
  // The control opens on nothing. A preselected option here is the failure
  // `lib/apply/index.ts` forbids in as many words.
  await expect(page.getByTestId("gap-input-question_1003")).toHaveValue("");
  // …and it names the one place that answers it on every board.
  await expect(gap.getByRole("link", { name: "Age" })).toHaveAttribute(
    "href",
    "/settings/answers#situation",
  );
});

test("self-identification is offered, including the decline option, and never picked", async ({
  page,
}) => {
  await isolate(page, "selfid");
  await gotoApply(page, 1);

  const gap = page.getByTestId("gap-demographic_5001");
  await expect(gap).toHaveAttribute("data-reason", "self-identification");
  const select = page.getByTestId("gap-input-demographic_5001");
  await expect(select).toHaveValue("");
  // The board's own options, the decline among them: it is offered because
  // declining is a choice, and nothing here makes it.
  await expect(select.locator("option")).toHaveText([
    "Choose an answer",
    "Man",
    "Woman",
    "I don't wish to answer",
  ]);
});

test("picking the decline is a choice that lands, and keeps landing", async ({ page }) => {
  await isolate(page, "decline");
  await gotoApply(page, 1);

  // The blocker: the label used to be stored as an ordinary answer, which no
  // engine layer may select — so the question came back as `option-mismatch`
  // forever, under copy that told the person to pick one of the board's options.
  // They had.
  const before = await writeCount(page);
  await page.getByTestId("gap-input-demographic_5001").selectOption({ label: "I don't wish to answer" });
  await page.getByTestId("gap-save-demographic_5001").click();
  await wroteMore(page, before);

  const row = page.getByTestId("field-demographic_5001");
  await expect(row).toHaveAttribute("data-declined", "true", { timeout: 15_000 });
  await expect(page.getByTestId("field-demographic_5001-value")).toHaveText(
    "I don't wish to answer",
  );
  // Named as a refusal rather than as an answer.
  await expect(page.getByTestId("field-demographic_5001-layer")).toHaveText(
    "You chose not to answer",
  );
  await expect(page.getByTestId("gap-demographic_5001")).toHaveCount(0);

  // And it KEEPS working: a reload re-runs the whole engine over the stored row.
  await page.reload();
  await expect(page.getByTestId("apply-surface")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByTestId("field-demographic_5001")).toHaveAttribute("data-declined", "true");
});

test("a seeded decline is already replayed, and a board's own option is what fills", async ({
  page,
}) => {
  await isolate(page, "decline-seeded");
  await gotoApply(page, 1);
  // Veteran status is seeded as a decline in the fixture library, so the replay
  // is exercised by every run rather than only by the one that clicks it.
  await expect(page.getByTestId("field-demographic_5002")).toHaveAttribute("data-declined", "true");
  await expect(page.getByTestId("field-demographic_5002-value")).toHaveText(
    "I don't wish to answer",
  );
});

test("an exception at this company beats the answer saved for every board", async ({ page }) => {
  await isolate(page, "scope");
  await gotoApply(page, 1);

  // The review's own scenario, seeded: a GLOBAL library answer of "No" to
  // "have you previously been employed by Stripe?", and a per-company rule
  // saying otherwise. The library used to win, on a card marked ready.
  await expect(page.getByTestId("field-question_1008-value")).toHaveText("Yes");
  await expect(page.getByTestId("field-question_1008-layer")).toHaveText("Rule");
  await expect(page.getByTestId("field-question_1008-source")).toContainText("only at stripe");
});

test("a company-scoped answer is shown as one, and says where it applies", async ({ page }) => {
  await isolate(page, "scoped-answer");
  await gotoApply(page, 1);
  // "How did you hear about this job?" is answered one way everywhere and
  // another way at Stripe. This is Stripe, so the scoped row is what fills it —
  // and the line under the value says which company it belongs to, for the same
  // reason the polarity is shown beside a rule.
  await expect(page.getByTestId("field-question_1005-value")).toHaveText(
    "A friend on the payments team",
  );
  await expect(page.getByTestId("field-question_1005-source")).toContainText("only at stripe");
});

test("scope opens narrow only where the truth varies by company", async ({ page }) => {
  await isolate(page, "scope-control", "no-answers");
  await gotoApply(page, 1);

  // Company-varying: "a friend on the payments team" is not true anywhere else.
  // Starting this one narrow is not answering it — the box says WHERE an answer
  // is filed, never what it is, and narrow is the scope that cannot be wrong
  // somewhere else.
  await expect(page.getByTestId("gap-scope-input-question_1005")).toBeChecked();
  // A fact about the person. Narrowing it would scatter one answer across
  // companies for nobody's benefit.
  await expect(page.getByTestId("gap-scope-input-question_1003")).not.toBeChecked();
  await expect(page.getByTestId("gap-scope-question_1003")).toContainText("Only at Stripe");
});

test("an answer saved 'only here' does not answer at the next company", async ({ page }) => {
  await isolate(page, "scope-save", "no-answers");
  await gotoApply(page, 1);

  const before = await writeCount(page);
  await page.getByTestId("gap-input-question_1001").selectOption({ label: "Yes" });
  await page.getByTestId("gap-scope-input-question_1001").check();
  await page.getByTestId("gap-save-question_1001").click();
  await wroteMore(page, before);

  await expect(page.getByTestId("field-question_1001-value")).toHaveText("Yes", { timeout: 15_000 });
  await expect(page.getByTestId("field-question_1001-source")).toContainText("only at stripe");

  // Modern Treasury asks the same question in the same words, and it is still a
  // question. A scoped answer leaking across companies is the M1 bug pointing
  // the other way, and it is the half a same-page assertion cannot see.
  await gotoApply(page, 8);
  await expect(page.getByTestId("gap-question_3001")).toHaveAttribute(
    "data-reason",
    "policy-unset",
  );
});

test("the attachment is why nothing reaches ready, said in words", async ({ page }) => {
  await isolate(page, "ramp");
  await gotoApply(page, 4);

  const surface = page.getByTestId("apply-surface");
  // Everything answerable IS answered here. What blocks it is the résumé, and
  // the count says so rather than the file being excused from it.
  await expect(surface).toHaveAttribute("data-readiness", "blocked");
  await expect(surface).toHaveAttribute("data-blocking-gaps", "2");
  await expect(page.getByTestId("attachment-note")).toContainText("no real Greenhouse posting");
  await expect(page.getByTestId("gap-resume")).toHaveAttribute("data-reason", "attachment");
  // A file gap offers no box: there is nothing a typed answer could do about it.
  await expect(page.getByTestId("gap-input-resume")).toHaveCount(0);
  // The computed start date, resolved against the PINNED demo clock: three weeks
  // past FIXTURE_NOW is 2026-08-11, and the next Monday is the 17th. The wall
  // clock happens to agree on the day this was written and stops agreeing
  // tomorrow, which is exactly what the pin is for — without it this assertion
  // rots overnight rather than failing for a reason.
  await expect(page.getByTestId("field-question_2003-value")).toHaveText("2026-08-17");
});

test("ready is an opinion, and says so beside itself", async ({ page }) => {
  await isolate(page, "ready");
  await gotoApply(page, 8);

  const surface = page.getByTestId("apply-surface");
  await expect(surface).toHaveAttribute("data-readiness", "ready");
  await expect(surface).toHaveAttribute("data-batch-approvable", "true");
  await expect(surface).toHaveAttribute("data-gaps", "0");
  const banner = page.getByTestId("readiness-banner");
  await expect(banner).toContainText("not permission to send it");
  await expect(banner).toContainText("the approve-and-go step is not built");
  // No affordance on this screen submits anything. Asserted as an absence,
  // because "there is no submit button" is the claim.
  await expect(page.getByRole("button", { name: /submit|apply now|send/i })).toHaveCount(0);
});

test("no gap can be saved before somebody chooses", async ({ page }) => {
  await isolate(page, "no-preselect", "no-answers");
  await gotoApply(page, 1);

  // The assertion this suite did not have, and the reason `Number("") === 0` got
  // past five green gates: every test of "nothing is preselected" looked at the
  // SELECT, which was always correct, and none looked at the Save beside it. With
  // the index as the option value, `chosen` was `options[0]` before any
  // interaction — so one click on a freshly loaded card wrote the board's first
  // option into the library, through the growth loop, on a knockout question.
  const saves = page.locator('[data-testid^="gap-save-"]');
  await expect(saves.first()).toBeVisible();
  const count = await saves.count();
  expect(count).toBeGreaterThan(3);
  for (let i = 0; i < count; i++) await expect(saves.nth(i)).toBeDisabled();

  // The knockout one by name, and the click a person makes by reflex.
  const knockout = page.getByTestId("gap-save-question_1003");
  await expect(knockout).toBeDisabled();
  await expect(page.getByTestId("gap-input-question_1003")).toHaveValue("");
  const before = await writeCount(page);
  await knockout.click({ force: true });
  // A disabled button cannot write, so `data-writes` must not move. A plain wait
  // rather than a poll: the claim is that a number STAYS PUT, and a poll for that
  // passes on its first read whether or not the write lands a tick later.
  await page.waitForTimeout(500);
  expect(await writeCount(page)).toBe(before);
  await expect(page.getByTestId("gap-question_1003")).toHaveAttribute(
    "data-reason",
    "policy-unset",
  );

  // …and it becomes live only once an option is chosen.
  await page.getByTestId("gap-input-question_1003").selectOption({ label: "No" });
  await expect(knockout).toBeEnabled();
});

test("answering a gap saves it to the library and the ENGINE fills the field", async ({ page }) => {
  await isolate(page, "growth");
  await gotoApply(page, 1);

  const before = await writeCount(page);
  // By LABEL, not by value: the option's value is its index since the
  // duplicate-label fix, so `selectOption("Yes")` would be selecting index "Yes"
  // and match nothing.
  await page.getByTestId("gap-input-question_1003").selectOption({ label: "Yes" });
  await page.getByTestId("gap-save-question_1003").click();
  await wroteMore(page, before);

  // The field is answered by a fresh SERVER render, not patched on screen: the
  // staged application is derived from the library, and a local patch would be
  // the surface inventing a resolution the engine never made.
  await expect(page.getByTestId("field-question_1003-value")).toHaveText("Yes", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("field-question_1003-layer")).toHaveText("Saved answer");
  await expect(page.getByTestId("gap-question_1003")).toHaveCount(0);

  // And it is in the library, worded as the board worded it — the growth loop's
  // whole point is that the NEXT board asking this gets it for nothing.
  await page.goto("/settings/answers");
  await expect(page.getByTestId("answers-surface")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByTestId("answer-are you at least 18 years of age")).toContainText(
    "Are you at least 18 years of age?",
  );
});

test("a non-Greenhouse row says what is not supported, not that something failed", async ({
  page,
}) => {
  await isolate(page, "ashby");
  await page.goto("/apply/2");
  await expect(page.getByTestId("apply-page")).toHaveAttribute("data-state", "unsupported-ats");
  await expect(page.getByTestId("empty-state")).toContainText("does not read ashby yet");
  // The coverage math, cited rather than asserted as a vibe.
  await expect(page.getByTestId("empty-state")).toContainText("43%");
});

test("a row whose link names no board says which half is missing", async ({ page }) => {
  await isolate(page, "no-board");
  // A careers page carrying `?gh_jid=`: knowably Greenhouse, and unfetchable
  // because the schema is keyed by the board token this URL does not carry. The
  // fourth refusal screen, and the one no fixture row could reach until now.
  await page.goto("/apply/7");
  await expect(page.getByTestId("apply-page")).toHaveAttribute("data-state", "no-board");
  await expect(page.getByTestId("empty-state")).toContainText(
    "does not say which board it belongs to",
  );
  // It names the job id it DID find, so the sentence is about this row rather
  // than about the shape in general.
  await expect(page.getByTestId("empty-state")).toContainText("job 7788991");
});

test("a row with a link Prepare cannot read still offers the link", async ({ page }) => {
  await isolate(page, "manual");
  await page.goto("/apply/3");
  await expect(page.getByTestId("apply-page")).toHaveAttribute("data-state", "unknown");
  // The old copy asserted "no posting key and no board link" for every row here,
  // including ones carrying a perfectly good URL — a fact it had not checked, on
  // the one refusal screen that then offered no way out.
  await expect(page.getByTestId("empty-state")).toContainText("not one Prepare can read");
  await expect(page.getByTestId("empty-state").getByRole("link", { name: "Open the posting" }))
    .toHaveAttribute("href", "https://example.com/jobs/manual-1");
});

test("a posting the board no longer has is a state, not an error page", async ({ page }) => {
  await isolate(page, "gone");
  await page.goto("/apply/6");
  await expect(page.getByTestId("apply-page")).toHaveAttribute("data-state", "fetch-not-found");
  await expect(page.getByTestId("empty-state")).toContainText("not on the board any more");
});

test("Prepare is reachable from the pipeline row it belongs to", async ({ page }) => {
  await isolate(page, "from-pipeline");
  await page.goto("/pipeline");
  await expect(page.getByTestId("pipeline")).toHaveAttribute("data-hydrated", "true");
  // Through the record pane, which is where Prepare lives after the Applications
  // cutover: the authored row carries three affordances and Prepare is not one
  // of them. The CLAIM is unchanged — Prepare is reachable from the row it
  // belongs to, and lands on that row's application rather than on a list.
  await page.getByTestId("open-8").click();
  await expect(page.getByTestId("application-pane")).toHaveAttribute("data-application", "8");
  await page.getByTestId("prepare-8").click();
  await expect(page.getByTestId("apply-surface")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByTestId("apply-surface")).toHaveAttribute("data-readiness", "ready");
});

test("with nothing stored, every field is a gap and none of them is filled in", async ({ page }) => {
  await isolate(page, "no-answers", "no-answers");
  await gotoApply(page, 8);

  const surface = page.getByTestId("apply-surface");
  await expect(surface).toHaveAttribute("data-answered", "0");
  await expect(surface).toHaveAttribute("data-readiness", "blocked");
  // Day one for every user, and the sentence has to be a question rather than a
  // wall of errors.
  await expect(page.getByTestId("gap-list").locator("li")).toHaveCount(6);
});
