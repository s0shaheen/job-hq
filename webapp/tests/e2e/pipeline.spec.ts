import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { collectPaintedOverflow, describeOffenders } from "./painted-overflow";

/**
 * The pipeline surface, driven through the real UI.
 *
 * What earns an E2E here rather than a unit test on the fake: everything that
 * only exists once a browser has laid the page out and a server action has
 * round-tripped. In particular the two claims the fake structurally cannot make —
 *
 *   * a decision SURVIVES A RELOAD. The whole suite once lacked this: every test
 *     asserted client state right after a gesture and not one reloaded, so a
 *     write into a store nothing else read passed everything (matrix row 31).
 *   * a conflict REFRESHES THE VALUE ON SCREEN, not merely toasts. That is the
 *     difference between matrix rows 45 and 46, and it is a rendering claim.
 */

const ORIGIN = "http://127.0.0.1:3210";
const FIXTURE_NOW = new Date("2026-07-21T15:00:00.000Z");

/**
 * Own store per test, with the project name in the id.
 *
 * Not decoration: the desktop and mobile projects run these same tests against
 * the SAME server process, so a bare id put both runs in one store and whichever
 * ran second found the first one's edits already applied (matrix row 91).
 */
async function isolate(page: Page, id: string) {
  const project = test.info().project.name;
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page
    .context()
    .addCookies([{ name: "hq_demo_id", value: `${project}-${id}`, url: ORIGIN }]);
}

async function gotoPipeline(page: Page, query = "") {
  await page.goto(`/pipeline${query}`);
  // Visible is not interactive: the server HTML renders the full surface long
  // before React attaches a single handler, and on a loaded CI runner that gap
  // swallowed BOTH blur-commits of the durability test — the trace showed zero
  // POSTs. data-hydrated flips in an effect, so it CANNOT be true before the
  // handlers exist. Gate here, once, for every test that enters the surface.
  await expect(page.getByTestId("pipeline")).toHaveAttribute("data-hydrated", "true");
}

/**
 * Wait until `n` more writes have finished than had when `before` was read.
 *
 * A reload cancels an in-flight server action, so reloading straight after a
 * blur-committed edit loses the write and reports it as a persistence bug. That
 * is a test racing itself, which reads as a real failure and is worse than a slow
 * test (matrix row 45's lesson).
 *
 * The obvious gate — "wait until nothing is pending" — is UNSOUND, and cost an
 * hour proving it: quiet is true both before a write starts and after it ends, so
 * a check landing in the window between a blur and its commit passes immediately
 * and reloads into the gap. The surface therefore publishes a monotonic count of
 * FINISHED writes, and this waits for it to pass a mark taken beforehand.
 */
async function writeCount(page: Page): Promise<number> {
  const raw = await page.getByTestId("pipeline").getAttribute("data-writes");
  return Number(raw ?? 0);
}

async function wroteMore(page: Page, before: number, n = 1) {
  // The poll must outlast the writes it waits for: each write is bounded by the
  // component's WRITE_TIMEOUT_MS (15s), and on a loaded CI runner two serialized
  // server-action round-trips genuinely exceed expect.poll's 5s default — CI saw
  // "Received: 1" with write B still in flight, both projects, while a 20x
  // CPU-throttled local run couldn't reproduce it because the page throttle
  // does not slow the server. 15s per awaited write, same bound the writes have.
  await expect
    .poll(() => writeCount(page), {
      message: `expected ${n} more finished write(s)`,
      timeout: 15_000 * n,
    })
    .toBeGreaterThanOrEqual(before + n);
}

/**
 * Wait until the surface is interactive again after a RELOAD.
 *
 * `gotoPipeline` gates on `data-hydrated` for a reason recorded there: the
 * server HTML renders the whole surface long before React attaches a handler.
 * A `page.reload()` re-opens that window and every test that reloads and then
 * MEASURES has to close it again.
 *
 * Skipping it does not fail loudly, which is what made this expensive. A
 * two-step locator (`row-N` then `status-trigger-N`) re-resolves both steps on
 * every use, so a handle taken during hydration can detach between resolving
 * and reading: `getComputedStyle` on a detached element returns an EMPTY
 * declaration, so `fontSize` is `""` and `parseFloat` is `NaN`, and
 * `boundingBox()` answers `null`. Both read as "the type scale is not wired"
 * and "the row has no box" — statements about the app, when the truth is the
 * test measured a corpse.
 *
 * `toBeVisible()` is NOT sufficient and was tried: it re-resolves and passes on
 * the pre-hydration DOM, which is present and visible and about to be replaced.
 * Deterministic in the container and invisible on a fast host, which is the
 * shape of every timing bug in this file.
 */
async function reloadedAndReady(page: Page) {
  await expect(page.getByTestId("pipeline")).toHaveAttribute("data-hydrated", "true");
}

/**
 * Open one row's record pane and wait for it.
 *
 * The pane is where five of the row's old affordances live after the cutover
 * (evidence, the suggestion, notes, Prepare, reopen), so most gestures in this
 * file now start here. Its subject is in the URL, so this is a navigation and
 * the attribute is a render, not an animation.
 */
async function openPane(page: Page, id: number) {
  await page.getByTestId(`open-${id}`).click();
  await expect(page.getByTestId("application-pane")).toHaveAttribute(
    "data-application",
    String(id),
  );
  // And the NAVIGATION has finished, not merely the render. Opening the pane is
  // a `router.push`, and Next clears `document.title` for the duration of a soft
  // navigation — so an axe scan fired the instant the pane appears reports a
  // `document-title` violation for a page that has one. Waiting for the title is
  // waiting for the transition to commit, which is what "the pane is open" means.
  await expect(page).toHaveTitle(/Applications/);
}

/**
 * The single highlighted option's text, or `""` when the highlight is not on
 * exactly one option — which is a real transient, not a defensive `??`: the
 * walk moves focus, and a blur that renders before its matching focus leaves
 * zero options carrying `data-highlighted`.
 *
 * Count and text are read in ONE `evaluateAll` so they cannot describe two
 * different moments. Two locator calls could, and that is the class of bug
 * this whole helper is being repaired for.
 */
function readHighlight(page: Page): Promise<string> {
  return page
    .locator('[role="option"][data-highlighted]')
    .evaluateAll((nodes) => (nodes.length === 1 ? (nodes[0].textContent ?? "").trim() : ""));
}

/**
 * Change one row's status entirely from the keyboard.
 *
 * The focus-floor tests (#232) have to be keyboard-driven to mean anything: a
 * pointer user re-acquires a control by aiming at it, a keyboard user is
 * WHEREVER focus is, so the floor only exists for the path this drives.
 *
 * ArrowDown-walks the listbox to the target instead of counting presses from
 * the vocabulary order, so a reordered status list cannot make this pick the
 * wrong status silently — the highlight assertion fails loudly instead. The
 * walk is bounded by the vocabulary's size (eleven statuses plus Custom).
 *
 * ── WHY EACH STEP WAITS FOR THE HIGHLIGHT TO *MOVE* (issue #316) ────────────
 *
 * The comment that stood here described a race and then did not defend against
 * it. It waited for "a highlighted option to exist" — and one always does, the
 * one the walk is standing on — so the wait was satisfied by the state BEFORE
 * the press. The loop then read that stale text, concluded the target had not
 * been reached, and pressed ArrowDown again for a step already taken. Nothing
 * in it tied the number of keys it sent to the number of steps the walk owed.
 *
 * The window is Radix's and it is not small: `SelectContentImpl`'s ArrowDown
 * handler defers the move with `setTimeout(() => focusFirst(candidateNodes))`
 * (`@radix-ui/react-select`), so `keyboard.press()` resolving proves the key
 * was DISPATCHED and never that the step was APPLIED. Push those zero-delay
 * timers out and the old loop sent FOUR TO FIFTEEN ArrowDowns for a three-step
 * walk at every setting measured (1, 2, 3, 4, 6, 9 and 60ms). At 60ms it ran
 * off the end of the list and failed the pick 10 times out of 10 — the `null`
 * `data-highlighted` this issue saw on `main`. At 9ms one trial reproduced the
 * other reported face exactly: five keys, this helper's own assertion green,
 * and `Final` written where `Interview` had just been asserted highlighted —
 * the extra key was still in flight when the loop read the target, so
 * `toHaveAttribute("data-highlighted", "")` passed against a highlight about
 * to be invalidated. `Interview` and `Final` are adjacent in `STATUS_ORDER`.
 * Which face comes up depends on whether the surplus presses coalesce, which
 * is why it was rare rather than constant.
 *
 * MEASURED FIRST, because the tier depended on it: the PRODUCT is not the
 * defect. Radix takes each step from `event.target`, the LIVE focused item, so
 * a commit is a function of the keys actually pressed and cannot run past
 * them. Driven with real key events at a human cadence (three ArrowDowns
 * 80-146ms apart, then Enter), at machine speed with no gap at all, and with
 * the deferred step forced 60ms late, the value written equalled the option
 * carrying `data-highlighted` at the instant Enter was dispatched in all 32
 * commits; under a 20x CPU throttle three ArrowDowns wrote `Interview` 10
 * times out of 10. Surplus presses at MACHINE speed coalesce instead —
 * `focusFirst` returns early when its first candidate is already focused — so
 * the control can drop a step and can never invent one. A person cannot land
 * one past what they see; only something choosing HOW MANY keys to send from a
 * stale read can, and that was this helper. Even in the reproduced `Final`
 * commit the control agreed with itself: highlight, focus and written value
 * were all `Final`. What had gone stale was the TEST's assertion.
 *
 * The product side of that measurement is now an assertion of its own: "a
 * keyboard commit writes the option that was highlighted under it".
 */
async function pickStatusByKeyboard(page: Page, id: number, status: string) {
  const trigger = page.getByTestId(`status-trigger-${id}`);
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  const option = page.getByRole("option", { name: status, exact: true });
  await expect(option).toBeVisible();

  let current = "";
  await expect
    .poll(async () => (current = await readHighlight(page)), {
      message: "the open listbox never settled on exactly one highlighted option",
    })
    .not.toBe("");

  for (let step = 0; current !== status; step++) {
    // Bounded by the vocabulary's size, and loud rather than silent: a walk
    // that runs off the end has picked nothing and must not fall through to a
    // commit.
    expect(step, `walked past ${step} options without reaching "${status}"`).toBeLessThan(15);
    const from = current;
    await page.keyboard.press("ArrowDown");
    // The step LANDING is the event to wait for. `not.toBe(from)` also fails
    // loudly at the bottom of the list, where the highlight cannot move and
    // the target was therefore never below us.
    await expect
      .poll(async () => (current = await readHighlight(page)), {
        message: `the ArrowDown off "${from}" never moved the highlight`,
      })
      .not.toBe(from);
  }
  // Nothing is in flight here — the loop only exits once the last press has
  // landed — so this reads the same state `Enter` is about to commit against.
  await expect(option).toHaveAttribute("data-highlighted", "");
  await page.keyboard.press("Enter");
}

/** The fixture ids, named so a test reads as its intent. */
const STRIPE = 1; // Interview
const PLAID = 2; // Applied + suggests Rejected
const ANTHROPIC = 3; // Applied
const DATADOG = 5; // Rejected — Reopen is reachable
const AFFIRM = 6; // Screen, posting Closed
const BREX = 7; // invented status, claimed by a human

// ------------------------------------------------------------ presentation

test("bands render live work first and the archive last", async ({ page }) => {
  await isolate(page, "groups");
  await gotoPipeline(page);

  const headings = await page.locator("[data-testid^='group-toggle-']").allInnerTexts();
  const names = headings.map((h) => h.split("\n")[0].trim().replace(/\s*\(\d+\)$/, ""));
  // Relative rather than an exact list, so adding a fixture row in a new status
  // does not break it for the wrong reason. The ORDER is the claim: an offer must
  // never sort below a rejection, and sorting the status strings would put
  // "Applied" above "Inbox" and bury the early stages entirely.
  expect(names).toContain("Active");
  expect(names).toContain("Closed");
  expect(names.indexOf("Active")).toBeLessThan(names.indexOf("Closed"));
  if (names.includes("Offers")) {
    expect(names.indexOf("Active")).toBeLessThan(names.indexOf("Offers"));
    expect(names.indexOf("Offers")).toBeLessThan(names.indexOf("Closed"));
  }
  // And each band states its own count, in its label.
  expect(headings.find((h) => h.includes("Active"))).toMatch(/Active \(\d+\)/);
});

test("a live application is not hidden behind the collapsed archive", async ({ page }) => {
  // The band split's whole risk in one assertion. `Closed` is collapsed by
  // default (the template's own initial state), so anything wrongly banded into
  // it disappears from a bare /pipeline — which is how a live application stops
  // existing without anybody deleting it.
  await isolate(page, "band-default");
  await gotoPipeline(page);
  await expect(page.getByTestId("group-toggle-Closed")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("group-toggle-Active")).toHaveAttribute("aria-expanded", "true");
  // The invented-status row and the Interview row are both live, so both are on
  // screen with no interaction at all.
  await expect(page.getByTestId(`row-${BREX}`)).toBeVisible();
  await expect(page.getByTestId(`row-${STRIPE}`)).toBeVisible();
  // And the rejected one is not.
  await expect(page.getByTestId(`row-${DATADOG}`)).toHaveCount(0);
});

test("an invented status gets the Other group and still renders its own text", async ({
  page,
}) => {
  // Matrix row 121. A typo must not mint a permanent group that looks like a
  // stage, and the row must not vanish either — collapsing to "Other" while the
  // row shows its real status is the compromise.
  await isolate(page, "invented");
  await gotoPipeline(page);
  // Active, not a band of its own and not the archive: a typo must not mint a
  // permanent band that looks like a stage, and it must not bury a live
  // application in a collapsed Closed either. The row must not vanish, and it
  // must still show its own status text rather than a canonical substitute.
  await expect(page.getByTestId("group-Active").getByTestId(`row-${BREX}`)).toBeVisible();
  await expect(page.getByTestId(`status-trigger-${BREX}`)).toContainText("waiting on referral");
});

test("a delisted posting is said in the pane, and the row stays in its live band", async ({
  page,
}) => {
  // §G2 is explicit that a delisted posting does not remove the application, so
  // this is information rather than a filter — and the assertion that matters is
  // the BAND, not the marker: a delisted posting must not quietly move an open
  // application into Closed.
  await isolate(page, "delisted");
  await gotoPipeline(page);
  await expect(page.getByTestId("group-Active").getByTestId(`row-${AFFIRM}`)).toBeVisible();

  // The row itself carries no badge for it. The authored row has four cells and
  // a three-affordance budget; a fact that needs a sentence gets one, in the pane.
  await expect(page.getByTestId(`delisted-mark-${AFFIRM}`)).toHaveCount(0);

  await openPane(page, AFFIRM);
  await expect(page.getByTestId(`delisted-${AFFIRM}`)).toContainText("Posting closed");
  await expect(page.getByTestId(`delisted-${AFFIRM}`)).toContainText(
    "The application is unaffected",
  );

  // The negative half: a row whose posting is still listed says nothing of the
  // kind. Without it the pane could render that sentence on every application.
  await openPane(page, STRIPE);
  await expect(page.getByTestId(`delisted-${STRIPE}`)).toHaveCount(0);
});

test("evidence opens the email, with the safe rel attributes", async ({ page }) => {
  // Acceptance criterion 12 in spirit: a status with no reachable evidence
  // behind it is a status nobody can check.
  await isolate(page, "evidence");
  await gotoPipeline(page);
  await openPane(page, STRIPE);
  const link = page.getByTestId(`evidence-${STRIPE}`);
  await expect(link).toHaveAttribute("href", /mail\.google\.com/);
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(link).toHaveAttribute("target", "_blank");
});

// ------------------------------------------------------------------ status

test("setting a status persists across a reload and clears the suggestion", async ({ page }) => {
  await isolate(page, "set-status");
  await gotoPipeline(page);

  // Acceptance criterion 13's render side, in the pane the suggestion moved to.
  await openPane(page, PLAID);
  await expect(page.getByTestId("application-pane")).toContainText("Suggests: Rejected");
  await expect(page.getByTestId(`confirm-${PLAID}`)).toBeVisible();

  const mark = await writeCount(page);
  const rowStatus = page.getByTestId(`row-${PLAID}`).getByTestId(`status-trigger-${PLAID}`);
  await rowStatus.click();
  await page.getByRole("option", { name: "Offer", exact: true }).click();

  await expect(rowStatus).toContainText("Offer");
  await expect(page.getByTestId("application-pane")).not.toContainText("Suggests: Rejected");

  // THE RELOAD. Without it this passes against a store nothing else reads — and
  // it has to wait for the write to LAND first, because a reload cancels one that
  // is still in flight.
  await wroteMore(page, mark);
  await page.reload();
  // And the row moved BANDS, which is the reskin's own claim: an offer is not a
  // step in the ladder any more, it is its own band.
  await expect(page.getByTestId("group-Offers").getByTestId(`row-${PLAID}`)).toContainText("Offer");
  await expect(page.getByTestId("application-pane")).not.toContainText("Suggests: Rejected");
});

test("a keyboard commit writes the option that was highlighted under it", async ({ page }) => {
  /**
   * #316's discriminating question, as an assertion — and the reason that issue
   * closed as a test defect rather than a product one.
   *
   * The observation was a helper committing `Final` having just asserted
   * `Interview` was highlighted; the two are adjacent in `STATUS_ORDER`. Either
   * the helper sent a key it had not accounted for, or this CONTROL commits
   * against a state the person has already been shown to have left. Only the
   * second is a product defect — and it would be a silent one, on a field
   * `CLAUDE.md` makes authoritative and nothing downstream corrects.
   *
   * Measured with real key events in the container — at a human cadence, at
   * machine speed, and with the deferred step forced 60ms late — the value
   * written equalled the option carrying `data-highlighted` at the instant
   * `Enter` was dispatched, in all 32 commits. This pins that. Radix takes each
   * step from the LIVE focused item (`event.target`), so the commit is a
   * function of the keys actually pressed and can never run past them.
   *
   * NOT "three presses move three options". They do at a human's cadence and
   * they demonstrably do not at a machine's — `focusFirst` returns early when
   * its first candidate already has focus, so presses arriving inside one
   * deferred step COALESCE. A step can be dropped; one can never be invented,
   * and it is the invented step that would corrupt a status.
   *
   * The listener is one-shot and CAPTURE, so it runs in the same dispatch as
   * Radix's own item handler and strictly before it. Nothing can interleave
   * between what it reads and what the control commits.
   *
   * The proving mutation, in `status-select.tsx`: commit one past what the
   * listbox highlighted, leaving the listbox itself untouched —
   * `onSelect(options[options.indexOf(next) + 1] ?? next)`. This then fails
   * with #316's exact pair: highlighted `Interview`, written `Final`.
   */
  await isolate(page, "keyboard-commit");
  await gotoPipeline(page, "?open=Active");

  const trigger = page.getByTestId(`status-trigger-${ANTHROPIC}`);
  // Stated, not assumed: the three options below are only the reachable set if
  // the row really starts where the fixture says. A dirty store would otherwise
  // fail the reachable-set check and read as a commit mismatch, which is the
  // opposite of what it would mean.
  await expect(trigger).toContainText("Applied");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("option", { name: "Interview", exact: true })).toBeVisible();

  const mark = await writeCount(page);
  // The first step is waited for, so the walk has provably left `Applied` and a
  // write must follow. The rest are pressed at a gap a person can type at —
  // that cadence IS the experimental condition here, not a wait for the app.
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(() => readHighlight(page), { message: "the first ArrowDown never moved the highlight" })
    .not.toBe("Applied");
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(120);
  }

  await page.evaluate(() => {
    const w = window as Window & { __committedAgainst?: string };
    w.__committedAgainst = "no Enter was seen";
    document.addEventListener(
      "keydown",
      () => {
        const on = document.querySelectorAll('[role="option"][data-highlighted]');
        w.__committedAgainst =
          on.length === 1 ? (on[0].textContent ?? "").trim() : `${on.length} options highlighted`;
      },
      { capture: true, once: true },
    );
  });
  await page.keyboard.press("Enter");
  const highlightedAtCommit = await page.evaluate(
    () => (window as Window & { __committedAgainst?: string }).__committedAgainst ?? "",
  );

  // Three ArrowDowns off `Applied` reach one of these three and no further.
  expect(["OA", "Screen", "Interview"]).toContain(highlightedAtCommit);
  await wroteMore(page, mark);
  await expect(trigger).toContainText(highlightedAtCommit);
  // And it SURVIVES, so this is a claim about the write and not about the
  // optimistic patch that painted it.
  await page.reload();
  await reloadedAndReady(page);
  await expect(page.getByTestId(`status-trigger-${ANTHROPIC}`)).toContainText(highlightedAtCommit);
});

test("a custom status is accepted and survives a reload", async ({ page }) => {
  // The sheet allows an invented status; refusing one would make this control
  // strictly less capable than the cell it replaces.
  await isolate(page, "custom-status");
  await gotoPipeline(page);

  await page.getByTestId(`row-${ANTHROPIC}`).getByTestId(`status-trigger-${ANTHROPIC}`).click();
  await page.getByRole("option", { name: "Custom" }).click();
  const mark = await writeCount(page);
  const input = page.getByTestId(`custom-status-input-${ANTHROPIC}`);
  await input.fill("waiting on panel");
  await input.press("Enter");

  await wroteMore(page, mark);
  await page.reload();
  await gotoPipeline(page);
  await expect(page.getByTestId(`status-trigger-${ANTHROPIC}`)).toContainText("waiting on panel");
});

test("confirming a suggestion applies it", async ({ page }) => {
  await isolate(page, "confirm");
  await gotoPipeline(page, "?open=Active,Closed");
  await openPane(page, PLAID);
  const mark = await writeCount(page);
  await page.getByTestId(`confirm-${PLAID}`).click();

  await wroteMore(page, mark);
  await page.reload();
  await gotoPipeline(page, "?open=Active,Closed");
  await expect(page.getByTestId("group-Closed").getByTestId(`row-${PLAID}`)).toBeVisible();
  // Reopened deliberately. A closed pane trivially "does not contain" anything,
  // so asserting absence against nothing is an assertion that cannot fail.
  await openPane(page, PLAID);
  await expect(page.getByTestId("application-pane")).not.toContainText("Suggests");
});

test("rejecting a suggestion leaves the status alone", async ({ page }) => {
  // Matrix row 107 — the failure is a "no thanks" that quietly applies the thing
  // it declined. Asserted after a reload, so a client-only clear cannot pass it.
  await isolate(page, "reject");
  await gotoPipeline(page, "?open=Active,Closed");
  await openPane(page, PLAID);
  const mark = await writeCount(page);
  await page.getByTestId(`reject-${PLAID}`).click();
  await expect(page.getByTestId("application-pane")).not.toContainText("Suggests");
  // The optimistic FRAME is not asserted here on purpose: the demo store answers
  // faster than a retrying `expect` can look, so any such assertion here passes
  // whatever the client paints. It lives in tests/unit/optimistic.test.ts, which
  // was written after a mutant proved this gap.

  await wroteMore(page, mark);
  await page.reload();
  await gotoPipeline(page, "?open=Active,Closed");
  await expect(page.getByTestId("group-Active").getByTestId(`row-${PLAID}`)).toBeVisible();
  await expect(
    page.getByTestId(`row-${PLAID}`).getByTestId(`status-trigger-${PLAID}`),
  ).toContainText("Applied");
  // Reopened for the reason above: absence measured against a closed pane is
  // absence measured against nothing.
  await openPane(page, PLAID);
  await expect(page.getByTestId("application-pane")).not.toContainText("Suggests");
});

// ------------------------------------------------------------------ notes

test("two notes both survive, newest first, and the first is verbatim", async ({ page }) => {
  // Matrix row 108: the flat column lost note #1 the moment note #2 arrived.
  await isolate(page, "notes");
  await gotoPipeline(page);

  await openPane(page, PLAID);

  await page.getByTestId(`note-input-${PLAID}`).fill("Panel is 3 rounds");
  await page.getByTestId(`note-save-${PLAID}`).click();
  await expect(page.getByTestId(`notes-list-${PLAID}`)).toContainText("Panel is 3 rounds");

  await page.getByTestId(`note-input-${PLAID}`).fill("Moved to Thursday");
  await page.getByTestId(`note-save-${PLAID}`).click();
  // Wait for the list to carry it before reading the ORDER out. Reading
  // straight after the click raced the dialog's re-fetch and reported a missing
  // note — the test disagreeing with itself, which reads as a real failure.
  await expect(page.getByTestId(`notes-list-${PLAID}`)).toContainText("Moved to Thursday");

  const bodies = await page
    .getByTestId(`notes-list-${PLAID}`)
    .getByTestId("note-body")
    .allInnerTexts();
  // Newest first, and note #1 VERBATIM behind it — the failure this replaces was
  // a silent overwrite, so the older row's identity is the assertion that counts.
  expect(bodies.map((b) => b.trim())).toEqual(["Moved to Thursday", "Panel is 3 rounds"]);

  // And after a reload, because the point is that they were written. The pane's
  // subject is in the URL, so the reload lands back on the same record — which
  // is the property being relied on, not a convenience.
  await wroteMore(page, 0, 2);
  await page.reload();
  await expect(page.getByTestId(`notes-list-${PLAID}`)).toContainText("Panel is 3 rounds");
});

test("the pane takes focus on open and Escape closes it", async ({ page }) => {
  // The pane replaces the notes DIALOG, so the claim changes shape with it. It
  // is deliberately not a modal — no trap, no scrim, the list stays clickable —
  // so what has to be true is narrower and still load-bearing: a keyboard user
  // lands INSIDE the thing that just appeared, and Escape gets them out.
  await isolate(page, "notes-focus");
  await gotoPipeline(page);

  await openPane(page, STRIPE);
  await expect(page.getByTestId("pane-close")).toBeFocused();

  // The list underneath is still live, which is the whole reason this is a pane.
  await expect(page.getByTestId(`row-${PLAID}`)).toBeVisible();
  await expect(page.getByTestId(`status-trigger-${PLAID}`)).toBeEnabled();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("application-pane")).toHaveCount(0);
  // And the URL let go of the subject, so a reload does not reopen it.
  await expect(page).not.toHaveURL(/[?&]app=/);
});

test("the pane's subject is in the URL, so a link restores it", async ({ page }) => {
  // Which record you are looking at is navigation. Without this a shared link
  // lands on the list and the reader has to find the row again.
  await isolate(page, "pane-url");
  await gotoPipeline(page, `?app=${STRIPE}`);
  await expect(page.getByTestId("application-pane")).toHaveAttribute(
    "data-application",
    String(STRIPE),
  );
  await expect(page.getByTestId("application-pane")).toContainText("Stripe");
});

test("an ?app= id that matches no row renders no pane and leaves the list alone", async ({
  page,
}) => {
  // The honest answer to "show me a record that is not here". A stale link, a
  // row someone withdrew from another device, or a hand-typed id must not blank
  // the surface or throw — the list underneath still says everything it said.
  await isolate(page, "pane-unknown");
  await gotoPipeline(page, "?app=999999");
  await expect(page.getByTestId("application-pane")).toHaveCount(0);
  await expect(page.getByTestId(`row-${PLAID}`)).toBeVisible();
});

test("Back closes the pane however many rows were read first", async ({ page }) => {
  // Opening the pane earns a history entry; moving it from row to row does not.
  // Pushing on every move buries the list behind one entry per row glanced at,
  // so Back walks backwards through a reading session instead of closing the
  // pane. Three rows, one Back.
  await isolate(page, "pane-history");
  await gotoPipeline(page);

  await openPane(page, PLAID);
  await openPane(page, ANTHROPIC);
  await openPane(page, STRIPE);

  await page.goBack();
  await expect(page.getByTestId("application-pane")).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]app=/);
  // And the list is still there rather than a step further back in history.
  await expect(page.getByTestId(`row-${PLAID}`)).toBeVisible();
});

test("the note history is populated for a row that arrived with one", async ({ page }) => {
  // 0010's backfill: the flat column becomes an `import`-authored note. Without
  // this the dialog's populated state would never be looked at.
  await isolate(page, "notes-backfill");
  await gotoPipeline(page);
  await openPane(page, STRIPE);
  await expect(page.getByTestId(`notes-list-${STRIPE}`)).toContainText("Panel is 3 rounds");
  await expect(page.getByTestId(`notes-list-${STRIPE}`)).toContainText("imported");
});

// -------------------------------------------------------- withdraw / reopen

test("withdraw moves the row, and reopen demands a reason", async ({ page }) => {
  await isolate(page, "withdraw-reopen");
  await gotoPipeline(page, "?open=Active,Closed");

  // Through the pane's Withdraw button, which now asks through the surface's one
  // confirmation rather than an inline panel of its own.
  await openPane(page, ANTHROPIC);
  await page.getByTestId(`withdraw-${ANTHROPIC}`).click();
  await expect(page.getByTestId("withdraw-consequence")).toContainText("reminders stop");
  await page.getByTestId("withdraw-confirm").click();
  await expect(page.getByTestId("group-Closed").getByTestId(`row-${ANTHROPIC}`)).toBeVisible();

  // Reopen appears only on a terminal row, and asks for a reason before it writes.
  const confirm = page.getByTestId(`reopen-confirm-${ANTHROPIC}`);
  // Matrix row 111: no reason, no reopen. The button is disabled rather than
  // failing after the click — the SQL refuses it either way.
  await expect(confirm).toBeDisabled();

  await page.getByTestId(`reopen-note-${ANTHROPIC}`).fill("Recruiter emailed back");
  const mark = await writeCount(page);
  await confirm.click();

  await wroteMore(page, mark);
  await page.reload();
  await gotoPipeline(page, `?open=Active&app=${ANTHROPIC}`);
  await expect(page.getByTestId("group-Active").getByTestId(`row-${ANTHROPIC}`)).toBeVisible();
  await expect(page.getByTestId(`notes-list-${ANTHROPIC}`)).toContainText(
    "Recruiter emailed back",
  );
});

test("Reopen is absent on a live row and present on a terminal one", async ({ page }) => {
  // The positive-and-negative pair. Without the absence half, Reopen could be
  // rendered on every row and the test above would still pass.
  await isolate(page, "reopen-visibility");
  await gotoPipeline(page, "?open=Active,Closed");
  await openPane(page, DATADOG);
  await expect(page.getByTestId(`reopen-${DATADOG}`)).toBeVisible();
  // And a live row offers Withdraw in that slot instead — the two are mutually
  // exclusive, so asserting only the absence would pass on a pane with neither.
  await openPane(page, STRIPE);
  await expect(page.getByTestId(`reopen-${STRIPE}`)).toHaveCount(0);
  await expect(page.getByTestId(`withdraw-${STRIPE}`)).toBeVisible();
});

// ------------------------------------------------------------ next action

test("a next action saves on blur and survives a reload", async ({ page }) => {
  // The claim is eventual durability, not latency: two serialized server-action
  // round-trips on a loaded 2-core CI runner (628 tests sharing one next-start,
  // 42 of them parsing workbooks) have starved past 25s twice. The poll below
  // budgets 15s per write; the DEFAULT 30s test timeout truncated it — so this
  // test gets the room its own arithmetic asks for. If a write takes >2m the
  // component's WRITE_TIMEOUT_MS has already surfaced an error toast and the
  // poll fails on that, loudly, not on a truncation artifact.
  test.setTimeout(120_000);
  await isolate(page, "next-action");
  await gotoPipeline(page);

  // Two blurs BACK TO BACK, with no wait between them, and that is the point.
  //
  // An intermediate `wroteMore(page, mark, 1)` used to sit here and it was masking
  // a real bug: `rowsRef` was updated from an effect (a macrotask) while the write
  // queue advances on microtasks, so write B read the version token from before
  // write A and conflicted — losing the date and raising a spurious "Changed on
  // another device" toast. The wait hid it by letting the render land first.
  // Deleting the line is now safe because `put()` writes the ref synchronously;
  // watched red with the effect restored.
  const mark = await writeCount(page);
  await page.getByTestId(`next-action-${PLAID}`).fill("Chase the recruiter");
  await page.getByTestId(`next-action-${PLAID}`).blur();
  await page.getByTestId(`next-action-date-${PLAID}`).fill("2026-08-03");
  await page.getByTestId(`next-action-date-${PLAID}`).blur();

  // AT LEAST one finished write, then a quiet queue — NOT exactly two. The
  // write COUNT is scheduling-dependent and both schedules are correct: on a
  // fast machine the text blur commits before the date fill (two writes); under
  // CI's async event dispatch the date fill's onChange lands in the pending
  // refs BEFORE the text blur's handler runs, so the first write already
  // carries both fields and the date blur correctly no-ops (one write, same
  // data). Asserting `2` here pinned the mechanism instead of the claim and
  // failed only on the scheduling that coalesces — the sixth and final shape
  // of this test's CI saga. The reload assertions below carry the actual
  // claim, and the quiet-queue gate keeps the reload from cancelling an
  // in-flight write (the reason a gate exists at all).
  await wroteMore(page, mark, 1);
  await expect(page.getByTestId("pipeline")).toHaveAttribute("data-saving", "false");

  await page.reload();
  await expect(page.getByTestId(`next-action-${PLAID}`)).toHaveValue("Chase the recruiter");
  await expect(page.getByTestId(`next-action-date-${PLAID}`)).toHaveValue("2026-08-03");
});

// ------------------------------------------------------------- ?open= state

test("collapsed-group state survives a reload", async ({ page }) => {
  // Matrix row 120, first half. The state has to live where a RELOAD can find it,
  // which is the URL and not a React ref.
  await isolate(page, "open-reload");
  await gotoPipeline(page);
  await expect(page.getByTestId(`row-${PLAID}`)).toBeVisible();

  await page.getByTestId("group-toggle-Active").click();
  await expect(page).toHaveURL(/[?&]open=/);
  await expect(page.getByTestId(`row-${PLAID}`)).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId(`row-${PLAID}`)).toHaveCount(0);
  await expect(page.getByTestId("group-toggle-Active")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("collapsed-group state survives back and forward", async ({ page }) => {
  // Matrix row 120, second half — and deliberately WITHOUT a reload in the chain.
  //
  // Both halves used to be one test, and the reload in the middle is what broke it
  // on a slow machine: after a full document load at the pushed entry,
  // `page.goBack()` was a NO-OP in the Playwright container (the URL never
  // changed at all, history length 3), while on macOS it traversed normally. That
  // is a browser/driver difference about history across a document boundary, not a
  // fact about this app — the app was measured doing the right thing there once the
  // reload was removed. Two independent claims, neither leaning on the other's
  // side effects.
  await isolate(page, "open-history");
  await gotoPipeline(page);
  await expect(page.getByTestId(`row-${PLAID}`)).toBeVisible();

  await page.getByTestId("group-toggle-Active").click();
  await expect(page).toHaveURL(/[?&]open=/);
  await expect(page.getByTestId(`row-${PLAID}`)).toHaveCount(0);

  await page.goBack();
  await expect(page).not.toHaveURL(/[?&]open=/);
  await expect(page.getByTestId(`row-${PLAID}`)).toBeVisible();
  await expect(page.getByTestId("group-toggle-Active")).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  await page.goForward();
  await expect(page).toHaveURL(/[?&]open=/);
  await expect(page.getByTestId(`row-${PLAID}`)).toHaveCount(0);
});

test("a deep link renders the collapsed state in the RAW server HTML", async ({ page }) => {
  // Otherwise the server renders everything open and the client snaps it shut
  // after hydration — the pop that `grid-url.spec.ts` pins for /jobs.
  await isolate(page, "open-ssr");
  const res = await page.goto("/pipeline?open=Closed");
  const html = (await res!.text()) ?? "";
  expect(html).toContain('data-testid="group-toggle-Active"');
  // Active is closed, so its rows must not be in the response at all.
  expect(html).not.toContain(`data-testid="row-${PLAID}"`);
  expect(html).toContain(`data-testid="row-${DATADOG}"`);
});

test("an empty open= collapses everything without breaking the page", async ({ page }) => {
  // A state a person can reach by closing the last group, so it has to be
  // representable rather than falling back to the default.
  await isolate(page, "open-empty");
  await gotoPipeline(page, "?open=");
  await expect(page.locator("[data-testid^='row-']")).toHaveCount(0);
  await expect(page.getByTestId("group-toggle-Active")).toBeVisible();
});

// ------------------------------------------------- Escape, and typed content

test("Escape in the note composer keeps the draft and keeps the pane open", async ({ page }) => {
  /**
   * The pane used to close on any Escape inside it, on the strength of a comment
   * claiming the composer handled its own. It did not — so one keypress closed
   * the pane and the draft died with the unmount. Against a repo rule of
   * "preserve only safe drafts", that is the rule inverted.
   *
   * The claim is about the TEXT, not about the pane: reading the textarea's
   * value after the keypress is the only assertion that fails on the defect,
   * because a pane that stayed open with an empty box would satisfy anything
   * weaker.
   */
  await isolate(page, "escape-draft");
  await gotoPipeline(page);
  await openPane(page, PLAID);

  const composer = page.getByTestId(`note-input-${PLAID}`);
  await composer.fill("unsaved words");
  await composer.press("Escape");

  await expect(page.getByTestId("application-pane")).toBeVisible();
  await expect(composer).toHaveValue("unsaved words");

  // And there IS a way out: the first Escape released the field, so the second
  // reaches the pane and closes it — with the draft still in the box until the
  // pane goes. Without the blur a keyboard user would be sealed in the composer,
  // because the pane deliberately ignores Escape from a text entry.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("application-pane")).toHaveCount(0);
});

test("the pane refuses Escape from a field that forgot to stop it", async ({ page }) => {
  /**
   * The SECOND mechanism, which had no test and survived its own mutation.
   *
   * The pane guards Escape twice on purpose: every text field stops the key at
   * itself, AND the pane refuses to act on an Escape whose target is a text
   * entry at all — so "a field added later cannot reintroduce the defect by
   * forgetting rule 1". Both of today's fields implement rule 1, so removing
   * the pane's own guard changed nothing any test could see: review replaced
   * the selector with one that matches nothing and all 26 Escape/pane/withdraw
   * cases stayed green. A claim about a field NOBODY HAS WRITTEN YET cannot be
   * proven by the fields that exist.
   *
   * So this test writes that field. A bare input, injected into the pane with
   * no handler of its own, is exactly the case the guard exists for — and the
   * only way to drive it without waiting for someone to ship the regression.
   */
  await isolate(page, "escape-future-field");
  await gotoPipeline(page);
  await openPane(page, PLAID);

  await page.getByTestId("application-pane").evaluate((pane) => {
    const naive = document.createElement("input");
    naive.type = "text";
    naive.setAttribute("data-testid", "naive-field");
    pane.appendChild(naive);
    naive.focus();
  });

  const naive = page.getByTestId("naive-field");
  await naive.fill("text a future field would lose");
  await naive.press("Escape");

  /**
   * Two frames before looking, and it is the difference between a guard and a
   * coin flip.
   *
   * Closing the pane is a `router.push`, so the unmount lands a tick AFTER the
   * keypress. Asserting straight away read the pane that had not gone yet:
   * under the mutation this test passed on desktop and failed on mobile, from
   * the same defect, purely on which machine got there first. A test whose
   * verdict depends on the project is not evidence about the guard.
   */
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );

  // The pane ignored it, because the event came from a text entry — nothing
  // else could have stopped it, since this field has no handler.
  await expect(page.getByTestId("application-pane")).toBeVisible();
  await expect(naive).toHaveValue("text a future field would lose");

  // And Escape from OUTSIDE any field still closes, so the guard is a filter
  // rather than a switch that turned the whole handler off.
  await page.getByTestId("pane-close").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("application-pane")).toHaveCount(0);
});

test("Escape in the custom-status field closes the field, not the pane", async ({ page }) => {
  // The same defect through the other typed field. `status-select.tsx` called
  // preventDefault but not stopPropagation, so dismissing this small input took
  // the whole pane with it — and the typed status with that.
  await isolate(page, "escape-custom");
  await gotoPipeline(page);
  await openPane(page, PLAID);

  const pane = page.getByTestId("application-pane");
  await pane.getByTestId(`status-trigger-${PLAID}`).click();
  await page.getByRole("option", { name: "Custom" }).click();
  const custom = pane.getByTestId(`custom-status-input-${PLAID}`);
  await custom.fill("waiting on panel");
  await custom.press("Escape");

  // The field is gone and the pane is not.
  await expect(custom).toHaveCount(0);
  await expect(pane).toBeVisible();
  // And nothing was written on the way out.
  await expect(pane.getByTestId(`status-trigger-${PLAID}`)).toContainText("Applied");

  /**
   * And the way out did not seal them in.
   *
   * The three assertions above all passed while `setCustomOpen(false)` left
   * focus on `document.body` — the field unmounts and the browser has nowhere
   * else to put it. That is outside the pane, whose Escape handler is bound to
   * its own subtree, so EVERY later Escape reached nothing and the pane could
   * not be closed by keyboard at all: measured in review, three Escapes, pane
   * still open, `document.activeElement` still `BODY`.
   *
   * The same defect the composer and the reopen reason fixed by focusing the
   * pane root, and the same one the Withdraw dialog fixed by remembering its
   * opener — in the one text field that got neither. This control renders on a
   * bare row too, so it restores its own trigger rather than the pane.
   */
  await expect(pane.getByTestId(`status-trigger-${PLAID}`)).toBeFocused();

  // The consequence, which is what a person actually notices: Escape still
  // closes the pane afterwards.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("application-pane")).toHaveCount(0);
});

// ------------------------------------------------------- withdraw, both ways

test("withdrawing from the ROW select asks first, exactly as the pane does", async ({ page }) => {
  /**
   * The confirmation used to live on the pane's button, and `selectableStatuses`
   * includes every terminal status — so picking "Withdrawn" straight off the row
   * produced the identical write with nothing asked. A confirmation covering one
   * of two routes to the same write is a speed bump on the polite route.
   *
   * The gate is on the write now, so this drives the route that used to bypass
   * it: no pane, no button, just the select.
   */
  await isolate(page, "withdraw-row");
  await gotoPipeline(page, "?open=Active,Closed");
  await expect(page.getByTestId("application-pane")).toHaveCount(0);

  await page.getByTestId(`row-${ANTHROPIC}`).getByTestId(`status-trigger-${ANTHROPIC}`).click();
  await page.getByRole("option", { name: "Withdrawn", exact: true }).click();

  // It ASKS, and it says the consequence rather than "are you sure".
  await expect(page.getByTestId("withdraw-consequence")).toContainText("reminders stop");
  // And nothing has been written yet: the row is where it was.
  await expect(page.getByTestId("group-Active").getByTestId(`row-${ANTHROPIC}`)).toBeVisible();

  // Keep really keeps.
  const mark = await writeCount(page);
  await page.getByTestId("withdraw-keep").click();
  await expect(page.getByTestId("withdraw-consequence")).toHaveCount(0);
  await expect(page.getByTestId("group-Active").getByTestId(`row-${ANTHROPIC}`)).toBeVisible();
  expect(await writeCount(page), "Keep wrote something").toBe(mark);

  // And confirming from the same route lands the write.
  await page.getByTestId(`row-${ANTHROPIC}`).getByTestId(`status-trigger-${ANTHROPIC}`).click();
  await page.getByRole("option", { name: "Withdrawn", exact: true }).click();
  await page.getByTestId("withdraw-confirm").click();
  await wroteMore(page, mark);
  await page.reload();
  await gotoPipeline(page, "?open=Active,Closed");
  await expect(page.getByTestId("group-Closed").getByTestId(`row-${ANTHROPIC}`)).toBeVisible();
});

// ------------------------------------------------------------ target size

test("every control this surface adds meets the 24px target floor", async ({ page }) => {
  /**
   * WCAG 2.2 SC 2.5.8. Measured rather than asserted in a comment, because the
   * review that found this measured it: `pane-close` was 16x16 and is the pane's
   * ONLY pointer dismiss, `open-{id}` was 27.5x20, the band toggle 70.9x16, and
   * both pane links 20 tall.
   *
   * The rule has real exemptions — an inline link inside a sentence is one — and
   * none of these qualify: every control below is a standalone affordance with
   * its own line or its own cell. So the floor applies to all of them, and the
   * list is the surface's own controls rather than the whole page, because a
   * shared component's geometry is that component's test to own.
   */
  await isolate(page, "target-size");
  await gotoPipeline(page);
  await openPane(page, PLAID);

  const controls = [
    "pane-close",
    `open-${PLAID}`,
    "group-toggle-Active",
    `evidence-${PLAID}`,
    `prepare-${PLAID}`,
    `withdraw-${PLAID}`,
  ];

  const tooSmall: string[] = [];
  for (const id of controls) {
    const box = await page.getByTestId(id).first().boundingBox();
    // A control that is not on screen is not a failure of this test — the
    // suggestion block and the posting link depend on the fixture row. It IS a
    // failure to list one that never resolves, so the absence is reported.
    if (!box) {
      tooSmall.push(`${id}: not rendered`);
      continue;
    }
    if (box.width < 24 || box.height < 24) {
      tooSmall.push(`${id}: ${box.width.toFixed(1)}x${box.height.toFixed(1)}`);
    }
  }
  expect(tooSmall, "controls below the 24x24 floor").toEqual([]);
});

// ------------------------------------------------------------------- focus

test("closing the pane returns focus to the row that opened it", async ({ page }) => {
  /**
   * The pane is not a dialog, so nothing restores focus for it. Without this,
   * closing dropped focus to `document.body`: open the pane from row 40, close
   * it, and a keyboard user is at the top of the document.
   *
   * `docs/WEBAPP-BUILD.md` row 119 has claimed this behaviour since the notes
   * dialog, whose test asserted it. Deleting that dialog without carrying the
   * behaviour over made the row a false green.
   */
  await isolate(page, "focus-restore");
  await gotoPipeline(page);

  const trigger = page.getByTestId(`open-${AFFIRM}`);
  await trigger.click();
  await expect(page.getByTestId("application-pane")).toBeVisible();

  await page.getByTestId("pane-close").click();
  await expect(page.getByTestId("application-pane")).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("the Withdraw button leaves focus inside the pane, not on the body", async ({ page }) => {
  /**
   * The stranding defect, in the control that had it. The button used to swap
   * itself for a confirmation panel under the same parent, which unmounts the
   * focused element — after which `document.activeElement` was outside the pane
   * and Escape did nothing, because the handler is bound to the subtree.
   *
   * The dialog is the fix: Radix moves focus into it and restores it on close.
   * Asserted through the CONSEQUENCE — Escape still works — rather than through
   * activeElement alone, because that is the thing a person notices.
   */
  await isolate(page, "withdraw-focus");
  await gotoPipeline(page);
  await openPane(page, STRIPE);

  await page.getByTestId(`withdraw-${STRIPE}`).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("withdraw-consequence")).toBeVisible();

  // Escape leaves the dialog, and focus is back inside the pane.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("withdraw-consequence")).toHaveCount(0);
  const inPane = await page.evaluate(
    () => !!document.activeElement?.closest("[data-testid='application-pane']"),
  );
  expect(inPane, "focus left the pane after the withdraw dialog closed").toBe(true);

  // And the pane's own Escape still works, which is what stranding broke.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("application-pane")).toHaveCount(0);
});

/**
 * The focus floor on the busy mechanism itself (#232, FP-DES-007).
 *
 * The four tests below are the assertion the offline test's probe comment used
 * to only DESCRIBE: every status trigger is `disabled={anyBusy}` while a write
 * is in flight, the browser drops focus from a disabled control, and until the
 * settle-restore in `pipeline-table.tsx` nothing put it back — so every status
 * write, success or failure, stranded a keyboard user on `<body>`.
 *
 * One per branch of the successor rule (the rule itself is documented on
 * `settleFocus` in the component): the trigger survives, the trigger survives a
 * failure's revert, the row remounts under an open band, and the row vanishes
 * into the collapsed archive. `toBeFocused` retries, so each test also waits
 * out the re-enable race the rule's second attack names — a restore that fired
 * against a still-disabled control would be silently lost and never pass these.
 */

test("a settled status write returns keyboard focus to its trigger", async ({ page }) => {
  await isolate(page, "focus-floor-ok");
  await gotoPipeline(page, "?open=Active");

  const mark = await writeCount(page);
  await pickStatusByKeyboard(page, ANTHROPIC, "Interview");
  await wroteMore(page, mark);

  // The write disabled this trigger while in flight, so focus WAS dropped —
  // this is the restoration working, not focus never having moved.
  const trigger = page.getByTestId(`status-trigger-${ANTHROPIC}`);
  await expect(trigger).toContainText("Interview");
  await expect(trigger).toBeEnabled();
  await expect(trigger).toBeFocused();
});

test("a FAILED status write puts focus back on the reverted trigger", async ({ page }) => {
  // The failure path drops focus the identical way — the disable does it, not
  // the outcome — and a stranded keyboard user beside a Retry toast cannot
  // reach either the toast or the gesture they came from.
  await isolate(page, "focus-floor-fail");
  await gotoPipeline(page, "?demo=failnext&open=Active");

  const mark = await writeCount(page);
  await pickStatusByKeyboard(page, ANTHROPIC, "Interview");
  await expect(page.getByText(/Couldn't save that/)).toBeVisible({ timeout: 20_000 });
  await wroteMore(page, mark);

  const trigger = page.getByTestId(`status-trigger-${ANTHROPIC}`);
  await expect(trigger).toContainText("Applied");
  await expect(trigger).toBeEnabled();
  await expect(trigger).toBeFocused();
});

test("a write that moves the row to an open band keeps focus on the record's control", async ({
  page,
}) => {
  // Attack list, first entry: the node that held focus does not survive the
  // write. Moving Applied → Offer re-parents the row from Active's list into
  // Offers', which REMOUNTS it — every node the gesture touched is detached by
  // settle. The successor rule's second step re-finds the record's control by
  // identity, so focus follows the record into its new band.
  await isolate(page, "focus-floor-follow");
  await gotoPipeline(page);

  const mark = await writeCount(page);
  await pickStatusByKeyboard(page, ANTHROPIC, "Offer");
  await wroteMore(page, mark);

  await expect(page.getByTestId("group-Offers").getByTestId(`row-${ANTHROPIC}`)).toBeVisible();
  const trigger = page.getByTestId(`status-trigger-${ANTHROPIC}`);
  await expect(trigger).toContainText("Offer");
  await expect(trigger).toBeFocused();
});

test("a write into the collapsed archive lands focus on that band's toggle", async ({ page }) => {
  // The same attack with nowhere to follow to: Closed starts collapsed, so the
  // record's control does not render at all after the write. The documented
  // successor is the toggle of the band that now holds the record — the one
  // control that can reveal the row again, one keypress from where focus lands.
  await isolate(page, "focus-floor-archive");
  await gotoPipeline(page);

  const mark = await writeCount(page);
  await pickStatusByKeyboard(page, ANTHROPIC, "Rejected");
  await wroteMore(page, mark);

  await expect(page.getByTestId(`row-${ANTHROPIC}`)).toHaveCount(0);
  const toggle = page.getByTestId("group-toggle-Closed");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
});

// ---------------------------------------------------------------- failures

test("a conflict toasts AND refreshes the value on screen", async ({ page }) => {
  // Matrix rows 112 and 113 together. The second is the one that bites: a toast
  // saying "showing the latest" beside the stale value is worse than silence.
  await isolate(page, "conflict");
  await gotoPipeline(page, `?demo=conflict:${ANTHROPIC}&open=Active,Offers`);

  await page.getByTestId(`status-trigger-${ANTHROPIC}`).click();
  await page.getByRole("option", { name: "Interview", exact: true }).click();

  // The copy is the design's template now, not the em-dashed sentence this
  // surface used to raise. The MECHANISM is unchanged and is what the two
  // assertions below measure.
  await expect(page.getByText(/This row changed since you loaded it/)).toBeVisible();
  // The server's value, not the one we tried to write.
  await expect(page.getByTestId(`status-trigger-${ANTHROPIC}`)).toContainText("Offer");
  await expect(page.getByTestId(`status-trigger-${ANTHROPIC}`)).not.toContainText("Interview");
  // And exactly one status pill on the row — a refresh that appended rather
  // than replaced would leave both on screen.
  await expect(
    page.getByTestId(`row-${ANTHROPIC}`).getByTestId(`status-trigger-${ANTHROPIC}`),
  ).toHaveCount(1);
});

test("a failed write reverts the row, and Retry succeeds", async ({ page }) => {
  // Matrix row 114, and the first thing that has ever exercised `failNextWrite`
  // on this surface. `?demo=failnext` arms exactly one write, so the retry —
  // which does not re-render the page — goes through.
  await isolate(page, "failnext");
  await gotoPipeline(page, "?demo=failnext&open=Active");

  await page.getByTestId(`status-trigger-${ANTHROPIC}`).click();
  await page.getByRole("option", { name: "Interview", exact: true }).click();

  await expect(page.getByText(/Couldn't save that/)).toBeVisible();
  // Reverted: the optimistic value must not outlive the write that failed.
  await expect(page.getByTestId(`status-trigger-${ANTHROPIC}`)).toContainText("Applied");

  const mark = await writeCount(page);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId(`status-trigger-${ANTHROPIC}`)).toContainText("Interview");

  await wroteMore(page, mark);
  await page.reload();
  await gotoPipeline(page, "?open=Active");
  await expect(page.getByTestId("group-Active").getByTestId(`row-${ANTHROPIC}`)).toBeVisible();
  await expect(
    page.getByTestId(`row-${ANTHROPIC}`).getByTestId(`status-trigger-${ANTHROPIC}`),
  ).toContainText("Interview");
});

test("a retry replays the same command rather than issuing a second one", async ({ page }) => {
  // Matrix row 10 ("double-tap applies twice — idempotency key, replayed result")
  // was NOT earned on this surface: every Retry minted a fresh `randomUUID`, so a
  // request whose RESPONSE was lost — the write timeout, a dropped connection, a
  // deploy mid-flight — applied a SECOND time against an append-only trail.
  //
  // Asserted through the note count, because that is the one gesture whose double
  // application is visible in the data: two notes instead of one. `?demo=failnext`
  // fails the first attempt, and the retry carries the key the first attempt used.
  await isolate(page, "retry-idem");
  await gotoPipeline(page, "?demo=failnext");

  await openPane(page, PLAID);
  await page.getByTestId(`note-input-${PLAID}`).fill("only once");
  await page.getByTestId(`note-save-${PLAID}`).click();
  await expect(page.getByText(/Couldn't save that/)).toBeVisible();

  // No dialog to dismiss any more — the pane is not modal and does not portal
  // over the toaster, which is one of the things that makes it a pane.
  const mark = await writeCount(page);
  await page.getByRole("button", { name: "Retry" }).click();
  await wroteMore(page, mark);

  // Exactly one note, in the store, after a reload.
  //
  // POLLED, not read once. The dialog fetches its history through a separate
  // server action, so `allInnerTexts()` — an instant read with no retry — was
  // racing that fetch: under a full-suite load it ran while the dialog still said
  // "Loading…" and reported zero notes for a note that had saved perfectly.
  // Deterministic in a full run, green whenever this file ran alone, and the test
  // was the thing that was wrong (matrix rows 45 and 206).
  //
  // A double application would put TWO notes in the list before it renders at
  // all — both come from the same Retry — so polling for exactly one still fails
  // on the bug this test exists for.
  await page.reload();
  const bodies = page.getByTestId(`notes-list-${PLAID}`).getByTestId("note-body");
  await expect
    .poll(
      async () => (await bodies.allInnerTexts()).filter((b) => b.trim() === "only once").length,
      { message: "the note history did not load", timeout: 15_000 },
    )
    .toBe(1);
});

// ------------------------------------- offline and expired-session refusals

test("an offline status change refuses, reverts, and queues nothing", async ({
  page,
  context,
}) => {
  // DEC-011 on this surface: refuse, revert, say so — and deliberately NO
  // queue. The write branch's own comment says why ("nothing here replays a
  // pipeline gesture"), and since #222 this is every write surface's rule:
  // nothing is held, nothing replays, and the store stays untouched until a
  // person makes the gesture again. Driven by taking the browser offline,
  // which makes the server action reject rather than answer — the same
  // thrown-action catch a timeout reaches, so this test covers that branch
  // for both causes.
  await isolate(page, "offline-refuse");
  await gotoPipeline(page, "?open=Active");

  const mark = await writeCount(page);
  await context.setOffline(true);

  await page.getByTestId(`status-trigger-${ANTHROPIC}`).click();
  await page.getByRole("option", { name: "Interview", exact: true }).click();

  // The thrown-action copy, the WHOLE sentence. The auth branch four lines
  // below it in the component says "Your session expired." — a refactor
  // collapsing the two branches would still satisfy /Couldn't save/ while
  // lying about the cause, so each refusal test pins its own exact string.
  await expect(
    page.getByText("Couldn't save that. The server did not answer."),
  ).toBeVisible({ timeout: 20_000 });
  // With its Retry action: the gesture is not queued anywhere, so the toast
  // is the only handle the person still has on it.
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

  // The ROW reverted — matrix row 113's shape. A toast beside a stale
  // optimistic "Interview" is the exact bug this branch exists to prevent,
  // so the rendered status is the assertion and the toast is the garnish.
  const trigger = page.getByTestId(`status-trigger-${ANTHROPIC}`);
  await expect(trigger).toContainText("Applied");
  await expect(trigger).not.toContainText("Interview");

  // Every control came back: `busyId` cleared re-enables the row the failure
  // was on, and `anyBusy` cleared re-enables everyone else's — a catch that
  // forgot `setBusyId(null)` freezes the whole surface, which is matrix row
  // 135's stuck-busy failure and what the settings profile form really shipped.
  await expect(trigger).toBeEnabled();
  await expect(page.getByTestId(`status-trigger-${STRIPE}`)).toBeEnabled();
  await expect(page.getByTestId(`row-${ANTHROPIC}`)).toHaveAttribute("data-busy", "false");
  await expect(page.getByTestId("pipeline")).toHaveAttribute("data-saving", "false");

  // And the floor #199's probe could only MEASURE failing (#232): settle put
  // focus back on the trigger rather than leaving it on `<body>`, where the
  // busy disable dropped it. The keyboard-driven proofs — success, failure,
  // both row-moved successors — live in the focus section; this line pins the
  // thrown-action branch in situ, where the probe that found the defect ran.
  await expect(trigger).toBeFocused();

  // The refused write still COUNTS as finished — the counter counts outcomes,
  // not successes — so this proves the queue drained before the reload reads.
  await wroteMore(page, mark);

  // Back online, the refusal queued NOTHING: the reload reads the store, and
  // the store never heard about the gesture. This is the assertion that fails
  // if somebody adds an offline queue to this surface.
  await context.setOffline(false);
  await page.reload();
  await reloadedAndReady(page);
  await expect(page.getByTestId(`status-trigger-${ANTHROPIC}`)).toContainText("Applied");

  // And a fresh gesture lands normally — having been offline once is not a
  // state the surface stays in.
  const mark2 = await writeCount(page);
  await page.getByTestId(`status-trigger-${ANTHROPIC}`).click();
  await page.getByRole("option", { name: "Interview", exact: true }).click();
  await expect(page.getByTestId(`status-trigger-${ANTHROPIC}`)).toContainText("Interview");

  await wroteMore(page, mark2);
  await page.reload();
  await reloadedAndReady(page);
  await expect(page.getByTestId(`status-trigger-${ANTHROPIC}`)).toContainText("Interview");
});

test("an offline refusal does not wedge the write chain", async ({ page, context }) => {
  // The attack the serialized queue invites. Every write on this surface
  // chains on one `tail` promise, so the branch most likely to break SILENTLY
  // is a failure that leaves the chain holding a rejection: every later
  // gesture then queues behind a promise that never runs it, nothing on
  // screen says so, and the surface just stops saving. So: fail one write
  // offline, then prove BOTH recovery paths run through that same chain — the
  // toast's Retry, and an independent gesture on another row — and prove them
  // against the store after a reload, not against client state.
  await isolate(page, "offline-chain");
  await gotoPipeline(page, "?open=Active");

  const mark = await writeCount(page);
  await context.setOffline(true);

  await page.getByTestId(`status-trigger-${ANTHROPIC}`).click();
  await page.getByRole("option", { name: "Interview", exact: true }).click();
  await expect(
    page.getByText("Couldn't save that. The server did not answer."),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId(`status-trigger-${ANTHROPIC}`)).toContainText("Applied");

  // Reconnect, then Retry: the SAME command replayed through the same chain —
  // the delivery half of the refusal's promise, asserted via the store below.
  await context.setOffline(false);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId(`status-trigger-${ANTHROPIC}`)).toContainText("Interview");

  // An independent gesture on ANOTHER row, queued through the same tail. If
  // the failure wedged the chain, this blur commits nothing and the reload
  // below finds an empty field.
  await page.getByTestId(`next-action-${PLAID}`).fill("Ask about the panel format");
  await page.getByTestId(`next-action-${PLAID}`).blur();

  // Three finished writes: the refusal, the retry, the next action.
  await wroteMore(page, mark, 3);
  await page.reload();
  await reloadedAndReady(page);
  await expect(page.getByTestId(`status-trigger-${ANTHROPIC}`)).toContainText("Interview");
  await expect(page.getByTestId(`next-action-${PLAID}`)).toHaveValue(
    "Ask about the panel format",
  );
});

test("an expired session refuses the write, and signing back in lands it", async ({
  page,
}) => {
  // The auth branch, which no pipeline spec had ever armed: `hq_demo_session`
  // is checked server-side in `actions.ts` before any store touch, and the
  // cookie lands MID-JOURNEY — after the surface loaded with a live session —
  // because that is the state this row of the matrix means. Starting signed
  // out is a different state with a different surface (`entry-path.spec.ts`).
  await isolate(page, "session-expired");
  await gotoPipeline(page, "?open=Active");
  await page
    .context()
    .addCookies([{ name: "hq_demo_session", value: "expired", url: ORIGIN }]);

  const mark = await writeCount(page);
  await page.getByTestId(`status-trigger-${ANTHROPIC}`).click();
  await page.getByRole("option", { name: "Interview", exact: true }).click();

  // The AUTH copy, exactly — with its instruction, and WITHOUT a Retry
  // action. Replaying into a dead session would refuse the same way, and
  // nothing parks the gesture anywhere (DEC-011), so offering Retry here
  // would be the "saved on this device" lie the write branch's comment names.
  await expect(page.getByText("Couldn't save that. Your session expired.")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Sign in and try again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);

  // Reverted — the rendered status, not just the toast — and usable, on this
  // row and every other.
  const trigger = page.getByTestId(`status-trigger-${ANTHROPIC}`);
  await expect(trigger).toContainText("Applied");
  await expect(trigger).not.toContainText("Interview");
  await expect(trigger).toBeEnabled();
  await expect(page.getByTestId(`status-trigger-${STRIPE}`)).toBeEnabled();
  await expect(page.getByTestId("pipeline")).toHaveAttribute("data-saving", "false");

  // Nothing queued: with the session STILL expired, a reload reads the store
  // — reads are not gated by the cookie — and the store never heard the
  // gesture.
  await wroteMore(page, mark);
  await page.reload();
  await reloadedAndReady(page);
  await expect(page.getByTestId(`status-trigger-${ANTHROPIC}`)).toContainText("Applied");

  // Signed back in (the cookie IS the session in demo mode), the repeated
  // gesture lands and persists — the existing persistence shape, which is
  // also the proof nothing replayed: one write arrives, from this gesture.
  await page.context().clearCookies({ name: "hq_demo_session" });
  const mark2 = await writeCount(page);
  await page.getByTestId(`status-trigger-${ANTHROPIC}`).click();
  await page.getByRole("option", { name: "Interview", exact: true }).click();
  await expect(page.getByTestId(`status-trigger-${ANTHROPIC}`)).toContainText("Interview");

  await wroteMore(page, mark2);
  await page.reload();
  await reloadedAndReady(page);
  await expect(page.getByTestId(`status-trigger-${ANTHROPIC}`)).toContainText("Interview");
});

// ------------------------------------------------------------------ a11y

test("the status popover is reachable by keyboard and stays on screen", async ({ page }) => {
  // Matrix row 118. Radix owns the mechanics; this asserts the wiring is real —
  // the trigger takes focus, the keyboard opens it, and the listbox is painted
  // inside the viewport rather than off the bottom edge.
  await isolate(page, "select-keyboard");
  await gotoPipeline(page);

  const trigger = page.getByTestId(`row-${PLAID}`).getByTestId(`status-trigger-${PLAID}`);
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");

  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  const box = (await listbox.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);

  // And the keyboard can actually choose from it.
  await page.keyboard.press("Escape");
  await expect(listbox).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("axe is clean with a band collapsed and with the record pane open", async ({ page }) => {
  // This scan covers the whole page, so it inherits the header's Export button —
  // including its dim-until-hydrated `⌘E` hint. That hint used `opacity-40`, which
  // is a 2:1 contrast failure axe reports on any machine slow enough to scan
  // before hydration (the container was), so it is `invisible` now. If a future
  // change dims a Kbd with opacity again, THIS test is one of the ones that goes
  // red — see components/ui/kbd.tsx, which has the rule and the reason.
  await isolate(page, "axe-states");
  await gotoPipeline(page, "?open=Active");

  let results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  let serious = results.violations.filter((v) =>
    ["serious", "critical"].includes(v.impact ?? ""),
  );
  expect(serious.map((v) => `${v.id}: ${v.nodes.length}`), "collapsed").toEqual([]);

  await openPane(page, PLAID);
  results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  serious = results.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""));
  expect(serious.map((v) => `${v.id}: ${v.nodes.length}`), "pane").toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("application-pane")).toHaveCount(0);
});

test("nothing paints past the edge with the record pane open", async ({ page }) => {
  // The at-rest sweep in layout.spec.ts never opens anything, and the pane is
  // the element most likely to escape it: it is a fixed 400px column beside a
  // list, which on a phone is wider than the viewport unless it takes the full
  // width instead. That is the failure this catches.
  await isolate(page, "overflow-dialog");
  await gotoPipeline(page);
  await openPane(page, PLAID);

  const offenders = await page.evaluate(collectPaintedOverflow);
  expect(offenders, describeOffenders(offenders)).toEqual([]);
});

test("the last row's controls are clickable clear of the toast strip", async ({
  page,
}, testInfo) => {
  // Matrix row 100, applied to a second bottom-anchored surface. On a phone a
  // sonner toast occupies a fixed band at the bottom of the viewport; a document
  // exactly viewport-height leaves the last row's controls under it with nowhere
  // to scroll clear. The safe area below the list is what lifts them out.
  test.skip(testInfo.project.name !== "mobile", "the strip only bites at phone heights");
  await isolate(page, "toast-strip");
  await gotoPipeline(page);

  // The strip is RESERVED, asserted structurally.
  //
  // This half exists because the outcome half below cannot fail on this fixture
  // set: seven rows already make the document taller than a phone, so the last
  // control scrolls clear whether or not the safe area is there. Removing the
  // spacer and watching the hit-test still pass is what said so. /companies was
  // bitten because that page is almost exactly one screen — this one is not, and
  // a guard that only holds for today's row count is not a guard.
  //
  // NOT claimed: that a bottom-anchored toast can never overlap anything.
  // Reserving the strip app-wide is a bigger change, and the /jobs selection bar
  // has the same shape (matrix row 100's own caveat).
  const safeArea = page.getByTestId("toast-safe-area");
  const safeBox = (await safeArea.boundingBox())!;
  expect(safeBox.height, "no reserved strip below the list").toBeGreaterThanOrEqual(100);

  // Produce a toast first, so the strip is genuinely occupied. The suggestion
  // moved into the pane, so this dismisses it there and then closes the pane —
  // the toast outlives it, which is the point.
  await openPane(page, PLAID);
  await page.getByTestId(`reject-${PLAID}`).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("application-pane")).toHaveCount(0);

  await page.keyboard.press("End");
  // The last row's next-action field, which is the last INTERACTIVE thing in the
  // list now that the row carries three affordances instead of seven.
  const last = page.locator("[data-testid^='next-action-']").last();
  await last.scrollIntoViewIfNeeded();
  const box = (await last.boundingBox())!;
  // Hit-test the element's own centre: whatever is on top there receives the
  // click, so this fails if the toast covers it.
  const top = await page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el?.closest("[data-testid^='next-action-']") ? "row" : (el?.tagName ?? "none");
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  expect(top, "something is covering the last row's next-action field").toBe("row");
});

test("at 280px the surface still scrolls the document and paints inside the edge", async ({
  page,
}, testInfo) => {
  /**
   * The narrowest width anybody actually browses at, with the pane open.
   *
   * NOT a second guard on the bounded frame, and the first version of this
   * comment claimed it was. A review applied `data-bounded-frame` to the surface
   * and this test still PASSED — the shell's frame bounds `main`, which keeps its
   * own scroll, so `window.scrollY` still moves and nothing paints past the edge.
   * The frame has exactly one guard and it is `layout.spec.ts`'s un-bounded
   * sweep, which reads the attribute and the clipping ancestor.
   *
   * What this test IS: the narrowest width anybody browses at, with the widest
   * thing this surface can render open. A 400px pane beside a list in a 280px
   * viewport is the overflow, and that is worth its own assertion.
   *
   * The pane is open because it is the widest thing this surface can render: a
   * 400px column beside a list, in a 280px viewport, is the overflow.
   */
  test.skip(testInfo.project.name !== "mobile", "a viewport claim, not a cost one");
  await isolate(page, "narrow-280");
  await page.setViewportSize({ width: 280, height: 640 });
  await gotoPipeline(page);
  await openPane(page, PLAID);

  const offenders = await page.evaluate(collectPaintedOverflow);
  expect(offenders, describeOffenders(offenders)).toEqual([]);

  // The document scrolls. `scrollHeight > innerHeight` alone would pass on a
  // clipped frame that simply has tall content, so this asserts the page can
  // actually BE scrolled and that scrolling moves it.
  const scrolled = await page.evaluate(() => {
    // Pinned to the top first. Opening the pane is a navigation and the browser
    // restores a scroll offset across it, so reading `scrollY` cold measures
    // wherever the page happened to be rather than whether it can move.
    window.scrollTo(0, 0);
    const before = window.scrollY;
    window.scrollTo(0, 400);
    return { before, after: window.scrollY, room: document.documentElement.scrollHeight };
  });
  expect(scrolled.room, "the document is not tall enough for this to prove anything")
    .toBeGreaterThan(640);
  expect(scrolled.after, "the document did not scroll — the frame is clipping it")
    .toBeGreaterThan(scrolled.before);
});

// ------------------------------------------------------------ render budget

test("a 200-row group stays LINEAR — the trigger to virtualize", async ({ page }, testInfo) => {
  // The pipeline is NOT virtualized on purpose (tens of rows, and react-virtual
  // inside collapsible groups is complexity bought for a load that does not
  // exist). This is the assertion that says when that stops being the right call.
  //
  // It measures a RATIO, not milliseconds, and that is the second correction this
  // test has taken. It shipped with a 1000ms ceiling against a measured ~34ms —
  // 30x headroom, a number that could never fire. Tightening it to 150ms made it
  // fire on the Playwright container instead, where qemu emulation is far more
  // than 4x slower than the host: a wall-clock budget is a statement about the
  // MACHINE, and the two runners disagree by more than any single number can
  // straddle (matrix row 101's rule, arriving as a CPU claim rather than a pixel
  // one).
  //
  // What is actually worth detecting is SUPER-LINEAR cost — a per-row layout
  // thrash, a selector that rescans the list per row, a shadow that forces a full
  // reflow. That is machine-independent: the per-row cost of the second batch is
  // compared against the first, on whatever hardware is running.
  test.skip(testInfo.project.name !== "desktop", "a cost claim, not a viewport one");
  await isolate(page, "budget");
  await gotoPipeline(page);

  const rows = await page.locator("[data-testid^='row-']").count();
  expect(rows, "the fixture set is smaller than this test assumes").toBeGreaterThan(3);

  const m = await page.evaluate(() => {
    const list = document.querySelector("ul.divide-y");
    if (!list) return null;
    const template = list.querySelector("li")!;
    const batch = (n: number) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) list.appendChild(template.cloneNode(true));
      // Force layout so the number covers reflow, not just DOM insertion.
      void (list as HTMLElement).offsetHeight;
      return performance.now() - t0;
    };
    // Warm up first: the very first clone pays for style resolution that has
    // nothing to do with row count, and charging it to batch A would flatter the
    // ratio.
    batch(10);
    const a = batch(50);
    const b = batch(150);
    return { a, b, perRowA: a / 50, perRowB: b / 150 };
  });

  expect(m, "the pipeline's row list was not found").not.toBeNull();
  const { perRowA, perRowB } = m!;
  expect(perRowA).toBeGreaterThan(0);
  // 3x slack absorbs GC and scheduling noise at these sizes while still catching
  // anything genuinely quadratic — at 200 rows a per-row rescan is already ~4x.
  expect(
    perRowB,
    `per-row layout cost grew from ${perRowA.toFixed(3)}ms to ${perRowB.toFixed(3)}ms — ` +
      "the list is no longer linear, so virtualize it",
  ).toBeLessThan(perRowA * 3);
});

// ------------------------------------------------------ display preferences

test("the large type scale really grows the tokens, and the pill still fits", async ({
  page,
  context,
}) => {
  // Two halves, because either alone is weak. The measurement proves the scale is
  // wired (a `data-type-scale` attribute nothing reads would satisfy an attribute
  // assertion); the clip check proves the status pill survives it, which is what
  // matrix row 123 is actually about.
  await isolate(page, "type-scale");
  await gotoPipeline(page);
  const pill = page.getByTestId(`row-${PLAID}`).getByTestId(`status-trigger-${PLAID}`);
  await expect(pill).toBeVisible();
  const small = (await pill.boundingBox())!;
  const smallFont = await pill.evaluate((el) => getComputedStyle(el).fontSize);

  await context.addCookies([{ name: "hq_demo_display", value: "large", url: ORIGIN }]);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-type-scale", "large");
  await reloadedAndReady(page);

  // Measured only once the surface is hydrated — see `reloadedAndReady`. The
  // first version of this gated on `toBeVisible()`, which re-resolves against
  // the pre-hydration DOM and passed while the element was still about to be
  // replaced. `NaN` came back from the container twice before that was believed.
  const largeFont = await pill.evaluate((el) => getComputedStyle(el).fontSize);
  expect(parseFloat(largeFont)).toBeGreaterThan(parseFloat(smallFont));
  const large = (await pill.boundingBox())!;
  expect(large.height).toBeGreaterThan(small.height);

  // The pill grows with its text rather than clipping it.
  //
  // The previous version measured `scrollWidth > clientWidth` on a span with
  // `break-words` and no overflow constraint, where those two are equal BY
  // CONSTRUCTION — it could not fail, which is the third instance of the disease
  // matrix row 128 names. What is actually worth asserting is structural: the pill
  // is wide enough for its own content, and it is inside the row's box.
  const geometry = await pill.evaluate((el) => {
    const inner = (el.querySelector("span") ?? el) as HTMLElement;
    const row = el.closest("li") as HTMLElement;
    const pillBox = el.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    return {
      // The text's intrinsic width, measured off a Range so no CSS can flatter it.
      textWidth: (() => {
        const r = document.createRange();
        r.selectNodeContents(inner);
        return r.getBoundingClientRect().width;
      })(),
      pillWidth: pillBox.width,
      overflowsRow: pillBox.right > rowBox.right + 1,
      hasEllipsis: getComputedStyle(inner).textOverflow === "ellipsis",
    };
  });
  // Room for the text plus the chevron and padding — never LESS than the glyphs.
  expect(geometry.pillWidth).toBeGreaterThanOrEqual(geometry.textWidth);
  expect(geometry.overflowsRow, "the status pill paints outside its row").toBe(false);
  // And it must not be silently truncating instead: an ellipsis here would satisfy
  // every width comparison above while hiding the status.
  expect(geometry.hasEllipsis).toBe(false);
});

test("comfortable density makes rows taller without pushing anything off-screen", async ({
  page,
  context,
}) => {
  await isolate(page, "density");
  await gotoPipeline(page);
  const row = page.getByTestId(`row-${PLAID}`);
  const dense = (await row.boundingBox())!;

  await context.addCookies([{ name: "hq_demo_display", value: "comfortable", url: ORIGIN }]);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-density", "comfortable");
  // `data-density` is on `<html>` and is set before paint, so it is true while
  // the rows are still the server's. Measuring here answered `null` for the
  // box; the row has to be the hydrated one.
  await reloadedAndReady(page);
  const comfy = (await row.boundingBox())!;
  expect(comfy.height).toBeGreaterThan(dense.height);

  const offenders = await page.evaluate(collectPaintedOverflow);
  expect(offenders, describeOffenders(offenders)).toEqual([]);
});

test("an unrecognised display preference is ignored, not applied", async ({ page, context }) => {
  // A stale or hand-edited value must not leave the app in a state no CSS
  // defines. Fail towards the default, which is the readable one for everybody.
  //
  // Driven through the demo seam because the PRODUCTION channel no longer has
  // a hole this shape: 0025 gives the columns CHECK constraints and the write
  // function refuses an unknown value by name. What survives is the read path —
  // `parseDisplayPrefs` resolving anything it does not recognise to the
  // default — and that is what this drives end to end.
  await isolate(page, "display-garbage");
  await context.addCookies([{ name: "hq_demo_display", value: "enormous,zzz", url: ORIGIN }]);
  await gotoPipeline(page);
  await expect(page.locator("html")).not.toHaveAttribute("data-type-scale", "large");
  await expect(page.locator("html")).not.toHaveAttribute("data-density", "comfortable");
});

// ------------------------------------------------------------- needs review

test("the ambiguous-email review item names both candidates and changes neither", async ({
  page,
}) => {
  // Acceptance criterion 15's surface. The engine already refuses to guess between
  // two candidate applications; until this existed that refusal had NO surface, so
  // "neither row changed" was indistinguishable from "no email arrived".
  //
  // Demo-fed on purpose: nothing writes ambiguous-email events to Postgres —
  // `tracker/join.py` parks them in a sheet tab the web app cannot read. See
  // DEMO_REVIEW_ITEMS in page.tsx. What is asserted is the surface, not a
  // production data path.
  await isolate(page, "needs-review");
  await gotoPipeline(page, "?demo=review&open=Active");

  const section = page.getByTestId("needs-review");
  await expect(section).toBeVisible();
  // Exactly one item for one ambiguous email — not one per candidate.
  await expect(page.locator("[data-testid^='review-']")).toHaveCount(1);
  await expect(section).toContainText("Plaid");
  await expect(section).toContainText("Anthropic");
  await expect(section).toContainText("Nothing was changed");

  // And the two candidates are untouched: same statuses, suggestion unresolved.
  await expect(page.getByTestId(`status-trigger-${PLAID}`)).toContainText("Applied");
  await expect(page.getByTestId(`status-trigger-${ANTHROPIC}`)).toContainText("Applied");
  await openPane(page, PLAID);
  await expect(page.getByTestId("application-pane")).toContainText("Suggests: Rejected");
});

test("the review section is absent without the demo param", async ({ page }) => {
  // The positive control for the test above, and the honest statement of scope: on
  // a real deployment this section never appears, because nothing feeds it.
  await isolate(page, "no-review");
  await gotoPipeline(page);
  await expect(page.getByTestId("needs-review")).toHaveCount(0);
});

test("the settings toggle is what actually sets the display cookie", async ({ page }) => {
  // The mechanism shipped with the pipeline and nothing in the UI wrote the
  // cookie, which was recorded as "deferred, no profiles read exists" — wrong
  // reasoning: a cookie toggle needs no store. This is the control, end to end,
  // and it is the difference between a shipped preference and a documented one.
  await isolate(page, "settings-display");
  // The control lives on the Preferences section of the rail now
  // (`Settings.dc.html`), not on the single-column `/settings` it shipped on.
  await page.goto("/settings/preferences");

  const typeScale = page.getByTestId("prefs-type-scale");
  await expect(typeScale).toBeVisible();
  await expect(typeScale).toHaveValue("default");

  await typeScale.selectOption("large");
  // It reloads to re-apply before paint, so wait for the applied attribute.
  await expect(page.locator("html")).toHaveAttribute("data-type-scale", "large");
  await expect(page.getByTestId("prefs-type-scale")).toHaveValue("large");

  // And it reaches the pipeline, which is the point of a per-USER preference.
  await gotoPipeline(page);
  await expect(page.locator("html")).toHaveAttribute("data-type-scale", "large");

  // Off again, from the pipeline's own nav — the control is not one-way.
  await page.goto("/settings/preferences");
  await page.getByTestId("prefs-type-scale").selectOption("default");
  await expect(page.locator("html")).not.toHaveAttribute("data-type-scale", "large");
});
