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
  await expect(page.getByTestId("pipeline")).toBeVisible();
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

/** The fixture ids, named so a test reads as its intent. */
const STRIPE = 1; // Interview
const PLAID = 2; // Applied + suggests Rejected
const ANTHROPIC = 3; // Applied
const DATADOG = 5; // Rejected — Reopen is reachable
const AFFIRM = 6; // Screen, posting Closed
const BREX = 7; // invented status, claimed by a human

// ------------------------------------------------------------ presentation

test("groups render in ladder order, not alphabetically", async ({ page }) => {
  await isolate(page, "groups");
  await gotoPipeline(page);

  const headings = await page.locator("[data-testid^='group-toggle-']").allInnerTexts();
  const names = headings.map((h) => h.split("\n")[0].trim());
  // Postgres would sort "Applied" above "Inbox" and bury the early stages. The
  // assertion is relative rather than an exact list, so adding a fixture row in
  // a new status does not break it for the wrong reason.
  expect(names).toContain("Applied");
  expect(names).toContain("Interview");
  expect(names.indexOf("Applied")).toBeLessThan(names.indexOf("Interview"));
  expect(names.indexOf("Interview")).toBeLessThan(names.indexOf("Rejected"));
});

test("an invented status gets the Other group and still renders its own text", async ({
  page,
}) => {
  // Matrix row 121. A typo must not mint a permanent group that looks like a
  // stage, and the row must not vanish either — collapsing to "Other" while the
  // row shows its real status is the compromise.
  await isolate(page, "invented");
  await gotoPipeline(page, "?open=Other");
  await expect(page.getByTestId("group-toggle-Other")).toBeVisible();
  await expect(page.getByTestId(`row-${BREX}`)).toContainText("waiting on referral");
});

test("the delisted badge shows and the row stays in its own group", async ({ page }) => {
  // §G2 is explicit that a delisted posting does not remove the application, so
  // the badge is information rather than a filter.
  await isolate(page, "delisted");
  await gotoPipeline(page);
  await expect(page.getByTestId(`delisted-${AFFIRM}`)).toHaveText("Posting closed");
  await expect(page.getByTestId("group-Screen").getByTestId(`row-${AFFIRM}`)).toBeVisible();
});

test("evidence opens the email, with the safe rel attributes", async ({ page }) => {
  // Acceptance criterion 12 in spirit: a status with no reachable evidence
  // behind it is a status nobody can check.
  await isolate(page, "evidence");
  await gotoPipeline(page);
  const link = page.getByTestId(`evidence-${STRIPE}`);
  await expect(link).toHaveAttribute("href", /mail\.google\.com/);
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(link).toHaveAttribute("target", "_blank");
});

// ------------------------------------------------------------------ status

test("setting a status persists across a reload and clears the suggestion", async ({ page }) => {
  await isolate(page, "set-status");
  await gotoPipeline(page);

  // Acceptance criterion 13's render side: both badges, and the two buttons.
  await expect(page.getByTestId(`row-${PLAID}`)).toContainText("suggests Rejected");
  await expect(page.getByTestId(`confirm-${PLAID}`)).toBeVisible();

  const mark = await writeCount(page);
  await page.getByTestId(`status-trigger-${PLAID}`).click();
  await page.getByRole("option", { name: "Offer", exact: true }).click();

  await expect(page.getByTestId(`status-trigger-${PLAID}`)).toContainText("Offer");
  await expect(page.getByTestId(`row-${PLAID}`)).not.toContainText("suggests Rejected");

  // THE RELOAD. Without it this passes against a store nothing else reads — and
  // it has to wait for the write to LAND first, because a reload cancels one that
  // is still in flight.
  await wroteMore(page, mark);
  await page.reload();
  await expect(page.getByTestId("group-Offer").getByTestId(`row-${PLAID}`)).toContainText("Offer");
  await expect(page.getByTestId(`row-${PLAID}`)).not.toContainText("suggests Rejected");
});

test("a custom status is accepted and survives a reload", async ({ page }) => {
  // The sheet allows an invented status; refusing one would make this control
  // strictly less capable than the cell it replaces.
  await isolate(page, "custom-status");
  await gotoPipeline(page);

  await page.getByTestId(`status-trigger-${ANTHROPIC}`).click();
  await page.getByRole("option", { name: "Custom…" }).click();
  const mark = await writeCount(page);
  const input = page.getByTestId(`custom-status-input-${ANTHROPIC}`);
  await input.fill("waiting on panel");
  await input.press("Enter");

  await wroteMore(page, mark);
  await page.reload();
  await gotoPipeline(page, "?open=Other");
  await expect(page.getByTestId(`row-${ANTHROPIC}`)).toContainText("waiting on panel");
});

test("confirming a suggestion applies it", async ({ page }) => {
  await isolate(page, "confirm");
  await gotoPipeline(page, "?open=Applied,Rejected");
  const mark = await writeCount(page);
  await page.getByTestId(`confirm-${PLAID}`).click();

  await wroteMore(page, mark);
  await page.reload();
  await gotoPipeline(page, "?open=Applied,Rejected");
  await expect(page.getByTestId("group-Rejected").getByTestId(`row-${PLAID}`)).toBeVisible();
  await expect(page.getByTestId(`row-${PLAID}`)).not.toContainText("suggests");
});

test("rejecting a suggestion leaves the status alone", async ({ page }) => {
  // Matrix row 107 — the failure is a "no thanks" that quietly applies the thing
  // it declined. Asserted after a reload, so a client-only clear cannot pass it.
  await isolate(page, "reject");
  await gotoPipeline(page, "?open=Applied,Rejected");
  const mark = await writeCount(page);
  await page.getByTestId(`reject-${PLAID}`).click();
  await expect(page.getByTestId(`row-${PLAID}`)).not.toContainText("suggests");
  // The optimistic FRAME is not asserted here on purpose: the demo store answers
  // faster than a retrying `expect` can look, so any such assertion here passes
  // whatever the client paints. It lives in tests/unit/optimistic.test.ts, which
  // was written after a mutant proved this gap.

  await wroteMore(page, mark);
  await page.reload();
  await gotoPipeline(page, "?open=Applied,Rejected");
  await expect(page.getByTestId("group-Applied").getByTestId(`row-${PLAID}`)).toBeVisible();
  await expect(page.getByTestId(`status-trigger-${PLAID}`)).toContainText("Applied");
  await expect(page.getByTestId(`row-${PLAID}`)).not.toContainText("suggests");
});

// ------------------------------------------------------------------ notes

test("two notes both survive, newest first, and the first is verbatim", async ({ page }) => {
  // Matrix row 108: the flat column lost note #1 the moment note #2 arrived.
  await isolate(page, "notes");
  await gotoPipeline(page);

  await page.getByTestId(`notes-trigger-${PLAID}`).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

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

  // And after a reload, because the point is that they were written.
  await page.keyboard.press("Escape");
  await wroteMore(page, 0, 2);
  await page.reload();
  await page.getByTestId(`notes-trigger-${PLAID}`).click();
  await expect(page.getByTestId(`notes-list-${PLAID}`)).toContainText("Panel is 3 rounds");
});

test("the notes dialog returns focus to its trigger on Escape", async ({ page }) => {
  // Matrix row 119. Radix owns the focus trap; what this asserts is that the
  // RESTORE TARGET is right, which is the half a wrapper can still get wrong.
  await isolate(page, "notes-focus");
  await gotoPipeline(page);

  const trigger = page.getByTestId(`notes-trigger-${STRIPE}`);
  await trigger.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("the note history is populated for a row that arrived with one", async ({ page }) => {
  // 0010's backfill: the flat column becomes an `import`-authored note. Without
  // this the dialog's populated state would never be looked at.
  await isolate(page, "notes-backfill");
  await gotoPipeline(page);
  await page.getByTestId(`notes-trigger-${STRIPE}`).click();
  await expect(page.getByTestId(`notes-list-${STRIPE}`)).toContainText("Panel is 3 rounds");
  await expect(page.getByTestId(`notes-list-${STRIPE}`)).toContainText("imported");
});

// -------------------------------------------------------- withdraw / reopen

test("withdraw moves the row, and reopen demands a reason", async ({ page }) => {
  await isolate(page, "withdraw-reopen");
  await gotoPipeline(page, "?open=Applied,Withdrawn");

  await page.getByTestId(`status-trigger-${ANTHROPIC}`).click();
  await page.getByRole("option", { name: "Withdrawn", exact: true }).click();
  await expect(page.getByTestId("group-Withdrawn").getByTestId(`row-${ANTHROPIC}`)).toBeVisible();

  // Reopen appears only on a terminal row, and asks before it writes.
  await page.getByTestId(`reopen-${ANTHROPIC}`).click();
  const confirm = page.getByTestId(`reopen-confirm-${ANTHROPIC}`);
  // Matrix row 111: no reason, no reopen. The button is disabled rather than
  // failing after the click — the SQL refuses it either way.
  await expect(confirm).toBeDisabled();

  await page.getByTestId(`reopen-note-${ANTHROPIC}`).fill("Recruiter emailed back");
  const mark = await writeCount(page);
  await confirm.click();

  await wroteMore(page, mark);
  await page.reload();
  await gotoPipeline(page, "?open=Applied");
  await expect(page.getByTestId("group-Applied").getByTestId(`row-${ANTHROPIC}`)).toBeVisible();
  await page.getByTestId(`notes-trigger-${ANTHROPIC}`).click();
  await expect(page.getByTestId(`notes-list-${ANTHROPIC}`)).toContainText("Recruiter emailed back");
});

test("Reopen is absent on a live row and present on a terminal one", async ({ page }) => {
  // The positive-and-negative pair. Without the absence half, Reopen could be
  // rendered on every row and the test above would still pass.
  await isolate(page, "reopen-visibility");
  await gotoPipeline(page, "?open=Interview,Rejected");
  await expect(page.getByTestId(`reopen-${DATADOG}`)).toBeVisible();
  await expect(page.getByTestId(`reopen-${STRIPE}`)).toHaveCount(0);
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

  await page.getByTestId("group-toggle-Applied").click();
  await expect(page).toHaveURL(/[?&]open=/);
  await expect(page.getByTestId(`row-${PLAID}`)).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId(`row-${PLAID}`)).toHaveCount(0);
  await expect(page.getByTestId("group-toggle-Applied")).toHaveAttribute(
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

  await page.getByTestId("group-toggle-Applied").click();
  await expect(page).toHaveURL(/[?&]open=/);
  await expect(page.getByTestId(`row-${PLAID}`)).toHaveCount(0);

  await page.goBack();
  await expect(page).not.toHaveURL(/[?&]open=/);
  await expect(page.getByTestId(`row-${PLAID}`)).toBeVisible();
  await expect(page.getByTestId("group-toggle-Applied")).toHaveAttribute(
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
  const res = await page.goto("/pipeline?open=Rejected");
  const html = (await res!.text()) ?? "";
  expect(html).toContain('data-testid="group-toggle-Applied"');
  // Applied is closed, so its row must not be in the response at all.
  expect(html).not.toContain(`data-testid="row-${PLAID}"`);
  expect(html).toContain(`data-testid="row-${DATADOG}"`);
});

test("an empty open= collapses everything without breaking the page", async ({ page }) => {
  // A state a person can reach by closing the last group, so it has to be
  // representable rather than falling back to the default.
  await isolate(page, "open-empty");
  await gotoPipeline(page, "?open=");
  await expect(page.locator("[data-testid^='row-']")).toHaveCount(0);
  await expect(page.getByTestId("group-toggle-Applied")).toBeVisible();
});

// ---------------------------------------------------------------- failures

test("a conflict toasts AND refreshes the value on screen", async ({ page }) => {
  // Matrix rows 112 and 113 together. The second is the one that bites: a toast
  // saying "showing the latest" beside the stale value is worse than silence.
  await isolate(page, "conflict");
  await gotoPipeline(page, `?demo=conflict:${ANTHROPIC}&open=Applied,Offer,Interview`);

  await page.getByTestId(`status-trigger-${ANTHROPIC}`).click();
  await page.getByRole("option", { name: "Interview", exact: true }).click();

  await expect(page.getByText(/Changed on another device/)).toBeVisible();
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
  await gotoPipeline(page, "?demo=failnext&open=Applied,Interview");

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
  await gotoPipeline(page, "?open=Interview");
  await expect(page.getByTestId("group-Interview").getByTestId(`row-${ANTHROPIC}`)).toBeVisible();
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

  await page.getByTestId(`notes-trigger-${PLAID}`).click();
  await page.getByTestId(`note-input-${PLAID}`).fill("only once");
  await page.getByTestId(`note-save-${PLAID}`).click();
  await expect(page.getByText(/Couldn't save that/)).toBeVisible();

  // Close the dialog before reaching for the toast: the Radix overlay sits above
  // the toaster, so the Retry button is present and not clickable underneath it.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const mark = await writeCount(page);
  await page.getByRole("button", { name: "Retry" }).click();
  await wroteMore(page, mark);

  // Exactly one note, in the store, after a reload.
  await page.reload();
  await page.getByTestId(`notes-trigger-${PLAID}`).click();
  const bodies = await page
    .getByTestId(`notes-list-${PLAID}`)
    .getByTestId("note-body")
    .allInnerTexts();
  expect(bodies.filter((b) => b.trim() === "only once")).toHaveLength(1);
});

// ------------------------------------------------------------------ a11y

test("the status popover is reachable by keyboard and stays on screen", async ({ page }) => {
  // Matrix row 118. Radix owns the mechanics; this asserts the wiring is real —
  // the trigger takes focus, the keyboard opens it, and the listbox is painted
  // inside the viewport rather than off the bottom edge.
  await isolate(page, "select-keyboard");
  await gotoPipeline(page);

  const trigger = page.getByTestId(`status-trigger-${PLAID}`);
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

test("axe is clean with a group collapsed and with the notes dialog open", async ({ page }) => {
  // This scan covers the whole page, so it inherits the header's Export button —
  // including its dim-until-hydrated `⌘E` hint. That hint used `opacity-40`, which
  // is a 2:1 contrast failure axe reports on any machine slow enough to scan
  // before hydration (the container was), so it is `invisible` now. If a future
  // change dims a Kbd with opacity again, THIS test is one of the ones that goes
  // red — see components/ui/kbd.tsx, which has the rule and the reason.
  await isolate(page, "axe-states");
  await gotoPipeline(page, "?open=Applied");

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });

    let results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    let serious = results.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    );
    expect(serious.map((v) => `${v.id}: ${v.nodes.length}`), `collapsed, ${scheme}`).toEqual([]);

    await page.getByTestId(`notes-trigger-${PLAID}`).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    serious = results.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""));
    expect(serious.map((v) => `${v.id}: ${v.nodes.length}`), `dialog, ${scheme}`).toEqual([]);
    await page.keyboard.press("Escape");
  }
});

test("nothing paints past the edge with the notes dialog open", async ({ page }) => {
  // The at-rest sweep in layout.spec.ts never opens anything, and a dialog is
  // exactly the kind of portalled, viewport-positioned element that escapes it —
  // the same gap `grid-polish.spec.ts` found for a selected row.
  await isolate(page, "overflow-dialog");
  await gotoPipeline(page);
  await page.getByTestId(`notes-trigger-${PLAID}`).click();
  await expect(page.getByRole("dialog")).toBeVisible();

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

  // Produce a toast first, so the strip is genuinely occupied.
  await page.getByTestId(`reject-${PLAID}`).click();
  await expect(page.getByText(/suggests/)).toHaveCount(0);

  await page.keyboard.press("End");
  const last = page.locator("[data-testid^='notes-trigger-']").last();
  await last.scrollIntoViewIfNeeded();
  const box = (await last.boundingBox())!;
  // Hit-test the element's own centre: whatever is on top there receives the
  // click, so this fails if the toast covers it.
  const top = await page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el?.closest("[data-testid^='notes-trigger-']") ? "row" : (el?.tagName ?? "none");
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  expect(top, "something is covering the last row's notes button").toBe("row");
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
  const pill = page.getByTestId(`status-trigger-${PLAID}`);
  const small = (await pill.boundingBox())!;
  const smallFont = await pill.evaluate((el) => getComputedStyle(el).fontSize);

  await context.addCookies([{ name: "hq_display", value: "large", url: ORIGIN }]);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-type-scale", "large");

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

  await context.addCookies([{ name: "hq_display", value: "comfortable", url: ORIGIN }]);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-density", "comfortable");
  const comfy = (await row.boundingBox())!;
  expect(comfy.height).toBeGreaterThan(dense.height);

  const offenders = await page.evaluate(collectPaintedOverflow);
  expect(offenders, describeOffenders(offenders)).toEqual([]);
});

test("an unrecognised display cookie is ignored, not applied", async ({ page, context }) => {
  // A stale or hand-edited cookie must not leave the app in a state no CSS
  // defines. Fail towards the default, which is the readable one for everybody.
  await isolate(page, "display-garbage");
  await context.addCookies([{ name: "hq_display", value: "enormous,zzz", url: ORIGIN }]);
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
  await gotoPipeline(page, "?demo=review&open=Applied");

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
  await expect(page.getByTestId(`row-${PLAID}`)).toContainText("suggests Rejected");
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
  await page.goto("/settings");

  const large = page.getByTestId("display-large");
  await expect(large).toBeVisible();
  await expect(large).not.toBeChecked();

  await large.check();
  // It reloads to re-apply before paint, so wait for the applied attribute.
  await expect(page.locator("html")).toHaveAttribute("data-type-scale", "large");
  await expect(page.getByTestId("display-large")).toBeChecked();

  // And it reaches the pipeline, which is the point of a per-USER preference.
  await gotoPipeline(page);
  await expect(page.locator("html")).toHaveAttribute("data-type-scale", "large");

  // Off again, from the pipeline's own nav — the toggle is not one-way.
  await page.goto("/settings");
  await page.getByTestId("display-large").uncheck();
  await expect(page.locator("html")).not.toHaveAttribute("data-type-scale", "large");
});
