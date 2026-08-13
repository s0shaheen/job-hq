import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { collectPaintedOverflow, describeOffenders } from "./painted-overflow";

/**
 * The /companies universe grid, driven through the real UI.
 *
 * The claims worth an E2E rather than a unit test are the ones that only exist once
 * a browser has laid the page out and a server action has round-tripped:
 *
 *   * The source-quality column distinguishes confirmed companies from ones added
 *     manually, even when their scan coverage is otherwise similar.
 *   * A bulk review really writes, and the row really leaves the review set — a
 *     unit test on the fixture cannot see that the grid re-derives its set.
 *   * The reviewed row SURVIVES A RELOAD. This is the assertion the whole webapp
 *     suite once lacked: every E2E asserted client state right after a gesture and
 *     not one reloaded, so a write into a store nothing else read passed everything.
 *   * The coverage meter separates verified from expected, on screen, in pixels.
 *   * The paste path lands rows that are visible in the review set afterwards.
 */

const ORIGIN = "http://127.0.0.1:3210";

/**
 * Own store per test — parallel tests must not drain each other's review pile.
 *
 * The project name is part of the id, and that is not decoration: the desktop and
 * mobile projects run these same tests against the SAME server process, so a bare
 * `"paste-flow"` put both runs in one demo store. Whichever ran second found the
 * companies already added and asserted against the first run's leftovers — three
 * mobile failures that said nothing about the mobile viewport.
 */
async function isolate(page: Page, id: string) {
  const project = test.info().project.name;
  await page
    .context()
    .addCookies([{ name: "hq_demo_id", value: `${project}-${id}`, url: ORIGIN }]);
}

async function ready(page: Page, timeout?: number) {
  await expect(page.locator('[data-testid="companies-grid"][data-ready="true"]')).toBeAttached(
    timeout ? { timeout } : undefined,
  );
}

/**
 * The company name, addressed as the NAME rather than as everything painted in
 * the name cell.
 *
 * The cell now carries a `LogoAvatar` beside the text, and that avatar's monogram
 * fallback is real characters: `innerText` on the cell reads "RA Ramp", so an
 * anchored `^Ramp$` match found nothing and every row lookup in this file went
 * silently empty. The name has its own element and the assertions read that.
 */
const NAME_TEXT = '[data-testid="company-name"]';

const nameCell = (page: Page, name: string) =>
  page
    .locator('[role="gridcell"][data-col="name"]')
    .filter({
      has: page
        .locator(NAME_TEXT)
        .filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }),
    });

// ---------------------------------------------------------------- source quality

test.describe("the source-quality column", () => {
  test("confirmed and manually added rows are distinguishable", async ({ page }) => {
    // Cboe was resolved by a CXS-confirmed Workday redirect; loopreturns is a
    // Common Crawl slug nobody checked. The display language must preserve that
    // difference without exposing the engine's tier or confidence vocabulary.
    await isolate(page, "prov-distinguish");
    await page.goto("/companies?set=all");
    await ready(page);

    const chip = (row: string) =>
      page.locator('[role="row"]', { has: nameCell(page, row) }).getByTestId("provenance-chip");

    await expect(chip("Cboe Global Markets")).toHaveText("Confirmed");
    await expect(chip("loopreturns (board only)")).toHaveText("Likely");
    await expect(chip("Cboe Global Markets")).toHaveAttribute("data-confidence", "verified");
    await expect(chip("loopreturns (board only)")).toHaveAttribute("data-confidence", "inferred");
  });

  test("every row's chip names a confidence — none is silently blank", async ({ page }) => {
    await isolate(page, "prov-all");
    await page.goto("/companies?set=all");
    await ready(page);
    const chips = page.getByTestId("provenance-chip");
    const n = await chips.count();
    expect(n).toBeGreaterThan(8);
    for (let i = 0; i < n; i++) {
      const text = (await chips.nth(i).innerText()).trim();
      expect(text.length, `chip ${i} is empty`).toBeGreaterThan(3);
      // An unresolved row is the one case with no confidence word, and it says
      // "Not found yet" rather than nothing.
      expect(text).toMatch(/Confirmed|Likely|Added by you|Not found yet/);
    }
  });

  test("the popover explains the evidence and source in plain language", async ({ page }) => {
    await isolate(page, "prov-popover");
    await page.goto("/companies?set=all");
    await ready(page);
    await page
      .locator('[role="row"]', { has: nameCell(page, "loopreturns (board only)") })
      .getByTestId("provenance-chip")
      .click();

    const pop = page.getByTestId("provenance-popover");
    await expect(pop).toBeVisible();
    await expect(pop).toContainText(/may be dead/i);
    await expect(pop).toContainText(/Common Crawl/);
    await expect(pop).toContainText("How it was found");
    await expect(pop).not.toContainText("ingested-slug");

    await page.keyboard.press("Escape");
    await expect(pop).toBeHidden();
  });
});

// ---------------------------------------------------------------- bulk verbs

test.describe("the two review verbs", () => {
  test("approving a selection moves it into the universe and SURVIVES A RELOAD", async ({
    page,
  }) => {
    await isolate(page, "verbs-approve");
    await page.goto("/companies");
    await ready(page);

    // A shift-range over the review pile, exactly as a person would.
    const cells = page.locator('[role="gridcell"][data-col="name"]');
    const first = (await cells.nth(0).locator(NAME_TEXT).innerText()).trim();
    const third = (await cells.nth(2).locator(NAME_TEXT).innerText()).trim();
    await cells.nth(0).click();
    await cells.nth(2).click({ modifiers: ["Shift"] });
    await expect(page.getByTestId("review-count")).toHaveText("3 selected");

    await page.getByTestId("bulk-approve").click();
    await expect(page.getByText(/Added 3 companies to your universe/)).toBeVisible();

    // Gone from the review set — the grid re-derives its own set from the patch.
    await expect(nameCell(page, first)).toHaveCount(0);

    // The reload is the point. The whole suite once asserted client state right
    // after a gesture and never reloaded, which is how three separate stores behind
    // one process went unnoticed for a phase.
    await page.reload();
    await ready(page);
    await expect(nameCell(page, first)).toHaveCount(0);
    await page.goto("/companies?set=universe");
    await ready(page);
    await expect(nameCell(page, first)).toHaveCount(1);
    await expect(nameCell(page, third)).toHaveCount(1);
  });

  test("an approved row is included in scans; a dismissed one is not", async ({ page }) => {
    await isolate(page, "verbs-sweep");
    await page.goto("/companies");
    await ready(page);
    const cells = page.locator('[role="gridcell"][data-col="name"]');
    const approved = (await cells.nth(0).locator(NAME_TEXT).innerText()).trim();
    await cells.nth(0).click();
    await page.getByTestId("bulk-approve").click();
    await expect(page.getByText(/Added .* to your universe/)).toBeVisible();

    await page.goto("/companies?set=universe");
    await ready(page);
    // Approving includes the company in scans. The SQL guarantees that pairing.
    const row = page.locator('[role="row"]', { has: nameCell(page, approved) });
    // The cell is a switch now, not a badge with a word in it, so the fact is
    // read where the platform states it. `aria-checked` is the same claim as the
    // old "In scans" text and is the one a screen reader acts on.
    await expect(row.locator('[data-col="sweep"] [role="switch"]')).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("dismissing keeps the row, in its own set", async ({ page }) => {
    await isolate(page, "verbs-dismiss");
    await page.goto("/companies");
    await ready(page);
    const cells = page.locator('[role="gridcell"][data-col="name"]');
    const target = (await cells.nth(1).locator(NAME_TEXT).innerText()).trim();
    await cells.nth(1).click();
    await page.getByTestId("bulk-dismiss-company").click();
    await expect(page.getByText(/Passed/)).toBeVisible();

    await page.reload();
    await page.goto("/companies?set=dismissed");
    await ready(page);
    // Kept, not deleted: discovery must be able to see it was already declined.
    await expect(nameCell(page, target)).toHaveCount(1);
  });

  test("undo puts the batch back", async ({ page }) => {
    await isolate(page, "verbs-undo");
    await page.goto("/companies");
    await ready(page);
    const cells = page.locator('[role="gridcell"][data-col="name"]');
    const before = await cells.count();
    await cells.nth(0).click();
    await cells.nth(1).click({ modifiers: ["Shift"] });
    await page.getByTestId("bulk-approve").click();
    await expect(page.getByText(/Added 2 companies/)).toBeVisible();
    await expect(cells).toHaveCount(before - 2);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(cells).toHaveCount(before);
    // And it stuck: an undo that only repainted would pass an assertion made here
    // and fail on the next page load.
    await page.reload();
    await ready(page);
    await expect(page.locator('[role="gridcell"][data-col="name"]')).toHaveCount(before);
  });

  test("the keyboard verbs stay inert with nothing selected", async ({ page }) => {
    // A stray keypress deciding the row under the cursor would be a decision nobody
    // made. `j` moves the cursor onto a row first, precisely so that `a` has an
    // obvious wrong thing to do.
    await isolate(page, "verbs-inert");
    await page.goto("/companies");
    await ready(page);
    const before = await page.locator('[role="gridcell"][data-col="name"]').count();
    await page.locator('[data-testid="company-scroll"]').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("j");
    await page.keyboard.press("a");
    await page.waitForTimeout(300);
    await expect(page.locator('[role="gridcell"][data-col="name"]')).toHaveCount(before);
  });

  test("a keyboard verb after CLEARING a selection decides nothing", async ({ page }) => {
    // Matrix row 88, actually exercised.
    //
    // The bug was that the parent read the selection out of the `bulkBar` render
    // prop, which is only called WHILE something is selected — so a Clear left it
    // holding the last non-empty set, and the next `a` decided rows the user could
    // no longer see highlighted. The never-selected path (above) cannot see that:
    // the stale ref starts empty, so it is empty either way. Select, then clear,
    // then press — that is the only sequence where the two differ.
    await isolate(page, "verbs-cleared");
    await page.goto("/companies");
    await ready(page);
    const cells = page.locator('[role="gridcell"][data-col="name"]');
    const before = await cells.count();
    const first = (await cells.nth(0).locator(NAME_TEXT).innerText()).trim();

    await cells.nth(0).click();
    await cells.nth(2).click({ modifiers: ["Shift"] });
    await expect(page.getByTestId("review-count")).toHaveText("3 selected");

    // Escape is the grid's own clear, and it goes through the same
    // onSelectionChange the bar's Clear does.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("review-count")).toHaveCount(0);

    await page.keyboard.press("a");
    await page.waitForTimeout(400);
    await expect(cells).toHaveCount(before);
    await expect(nameCell(page, first)).toHaveCount(1);
    // And it really did nothing, not merely nothing visible.
    await page.reload();
    await ready(page);
    await expect(page.locator('[role="gridcell"][data-col="name"]')).toHaveCount(before);
  });

  test("a failed write reverts the whole batch and says so", async ({ page, context }) => {
    // Matrix rows 8 and 9 on this surface, mirroring grid-selection.spec.ts's
    // "a conflict inside the batch applies NOTHING".
    //
    // `FixtureDataSource.failNextWrite()` is what models a rejected write, and it
    // had ZERO CALLERS — the adversarial sweep named that exact shape once already
    // (rows 8/9/10 ticked while nothing exercised them). `hq_demo_fail` is the
    // channel a browser-driven test needs to arm it, the same way
    // `hq_demo_session=expired` arms the auth branch.
    await isolate(page, "verbs-failed-write");
    await page.goto("/companies");
    await ready(page);
    const cells = page.locator('[role="gridcell"][data-col="name"]');
    const before = await cells.count();
    const names = [
      (await cells.nth(0).locator(NAME_TEXT).innerText()).trim(),
      (await cells.nth(1).locator(NAME_TEXT).innerText()).trim(),
      (await cells.nth(2).locator(NAME_TEXT).innerText()).trim(),
    ];

    await cells.nth(0).click();
    await cells.nth(2).click({ modifiers: ["Shift"] });
    await expect(page.getByTestId("review-count")).toHaveText("3 selected");

    await context.addCookies([
      { name: "hq_demo_fail", value: "the store said no", url: ORIGIN },
    ]);
    await page.getByTestId("bulk-approve").click();

    await expect(page.getByText(/Couldn't save that/)).toBeVisible();
    await expect(page.getByText("the store said no")).toBeVisible();
    // Every optimistic row came back — including the two that would have
    // succeeded on their own, because the transaction is all-or-nothing.
    await expect(cells).toHaveCount(before);
    for (const name of names) await expect(nameCell(page, name)).toHaveCount(1);
    // Retry is one click, and it lives on the TOAST rather than on the selection:
    // the optimistic patch moved these rows out of the review set, and
    // `pruneSelection` permanently drops keys a filter hides (matrix row 72,
    // working as designed). The toast holds the original targets. The comment in
    // companies-surface.tsx claimed the highlight came back; watching this test
    // fail is what corrected it.
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

    // And the STORE agrees: nothing was written. The revert is not a repaint.
    await context.clearCookies({ name: "hq_demo_fail" });
    await page.reload();
    await ready(page);
    await expect(page.locator('[role="gridcell"][data-col="name"]')).toHaveCount(before);
    await page.goto("/companies?set=universe");
    await ready(page);
    for (const name of names) await expect(nameCell(page, name)).toHaveCount(0);
  });

  test("a stale row from another tab conflicts the batch: NOTHING applies, and the store keeps the other tab's decision", async ({
    page,
    context,
  }) => {
    // The two-tab trap, spelled out because it is the whole test: the second
    // page gets NO isolate() of its own. `isolate` writes the context cookie,
    // so `context.newPage()` resolves the SAME demo store — give the second
    // page its own `hq_demo_id` and it edits a different universe, tab A's
    // token is never stale, and this test green-lights a conflict branch it
    // never reached. (grid-selection.spec.ts's sibling test is the pattern.)
    await isolate(page, "conflict-batch");
    await page.goto("/companies");
    await ready(page);

    const cells = page.locator('[role="gridcell"][data-col="name"]');
    const before = await cells.count();
    const names = [
      (await cells.nth(0).locator(NAME_TEXT).innerText()).trim(),
      (await cells.nth(1).locator(NAME_TEXT).innerText()).trim(),
      (await cells.nth(2).locator(NAME_TEXT).innerText()).trim(),
    ];

    // Tab B, same store: approve the first row. Its `updatedAt` moves, and the
    // copy tab A is still holding is now stale.
    const other = await context.newPage();
    await other.goto("/companies");
    await ready(other);
    await nameCell(other, names[0]).click();
    await other.getByTestId("bulk-approve").click();
    await expect(other.getByText(/Added .* to your universe/)).toBeVisible();
    await other.close();

    // Tab A, unrefreshed: a batch that includes the stale row.
    await cells.nth(0).click();
    await cells.nth(2).click({ modifiers: ["Shift"] });
    await expect(page.getByTestId("review-count")).toHaveText("3 selected");
    await page.getByTestId("bulk-approve").click();

    // The conflict copy, exactly — not the offline copy, not the generic one.
    await expect(
      page.getByText("Changed on another device. Nothing was applied; showing the latest.", {
        exact: true,
      }),
    ).toBeVisible();

    // Every row reverted, INCLUDING the two whose tokens were fine — the
    // transaction is all-or-nothing and the screen must say what the store
    // holds, not apologise beside a half-applied grid.
    await expect(nameCell(page, names[1])).toHaveCount(1);
    await expect(nameCell(page, names[2])).toHaveCount(1);

    // No Undo for a batch that never landed: `lastBatch` is set on success
    // only, and the success toast never fired.
    await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);

    // "Showing the latest" is a refresh, not a promise: the other tab's
    // approval leaves this tab's review set once it lands.
    await expect(nameCell(page, names[0])).toHaveCount(0);
    await expect(cells).toHaveCount(before - 1);

    // The STORE proves atomicity on a fresh read: the universe gained exactly
    // the other tab's approval, and neither of tab A's riders.
    const check = await context.newPage();
    await check.goto("/companies?set=universe");
    await ready(check);
    await expect(nameCell(check, names[0])).toHaveCount(1);
    await expect(nameCell(check, names[1])).toHaveCount(0);
    await expect(nameCell(check, names[2])).toHaveCount(0);
    await check.close();

    // The surface recovered: a follow-up selection raises the bar — which
    // offers no Undo for the conflicted batch — and the gesture lands, because
    // the refreshed rows carry fresh tokens.
    await nameCell(page, names[1]).click();
    await expect(page.getByTestId("review-count")).toHaveText("1 selected");
    await expect(page.getByTestId("bulk-undo-company")).toHaveCount(0);
    await page.getByTestId("bulk-approve").click();
    await expect(page.getByText(/Added .* to your universe/)).toBeVisible();
    await expect(nameCell(page, names[1])).toHaveCount(0);
  });

  test("an offline approve reverts the whole batch, says so, and queues nothing", async ({
    page,
    context,
  }) => {
    // The absence of an outbox here is DESIGNED (the companies-surface.tsx
    // module comment; DEC-011): `lib/outbox.ts` speaks single-posting triage
    // gestures, so an undeliverable review reverts and says so rather than
    // claiming a durability this path does not have. This test pins both
    // halves — the honest revert AND the nothing-queued.
    await isolate(page, "verbs-offline");
    await page.goto("/companies");
    await ready(page);
    const cells = page.locator('[role="gridcell"][data-col="name"]');
    const before = await cells.count();
    const names = [
      (await cells.nth(0).locator(NAME_TEXT).innerText()).trim(),
      (await cells.nth(1).locator(NAME_TEXT).innerText()).trim(),
    ];

    await cells.nth(0).click();
    await cells.nth(1).click({ modifiers: ["Shift"] });
    await expect(page.getByTestId("review-count")).toHaveText("2 selected");

    await context.setOffline(true);
    await page.getByTestId("bulk-approve").click();

    // The offline copy, exactly. The auth branch has its own words; a refactor
    // collapsing the two must fail on one of these two tests.
    await expect(
      page.getByText("Couldn't save that. You may be offline.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Nothing was changed. Try again when you're back.", { exact: true }),
    ).toBeVisible();

    // The revert lands on REAL ROWS: every optimistic row is back, and the
    // grid did not strand on a skeleton or an empty state.
    await expect(cells).toHaveCount(before);
    for (const name of names) await expect(nameCell(page, name)).toHaveCount(1);
    await expect(page.getByTestId("empty-state")).toHaveCount(0);
    await expect(page.getByTestId("companies-skeleton")).toHaveCount(0);

    // Nothing queued, nothing undoable: no pending-work banner (the outbox's
    // one visible artifact), no Undo for a batch that never landed.
    await expect(page.getByTestId("pending-work")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);

    // Back online, SAME page state — no reload yet: the controls survived the
    // revert. A fresh click selects, and the keyboard verb still acts.
    await context.setOffline(false);
    await nameCell(page, names[0]).click();
    await expect(page.getByTestId("review-count")).toHaveText("1 selected");
    await page.keyboard.press("a");
    await expect(page.getByText(/Added .* to your universe/)).toBeVisible();
    await expect(nameCell(page, names[0])).toHaveCount(0);

    // Reload after reconnect: the store holds ONLY what the human repeated.
    // names[1] rode in the offline batch and nowhere else — if it shows up
    // approved, something queued and replayed the failed write.
    await page.reload();
    await ready(page);
    await expect(cells).toHaveCount(before - 1);
    await expect(nameCell(page, names[1])).toHaveCount(1);
    await page.goto("/companies?set=universe");
    await ready(page);
    await expect(nameCell(page, names[0])).toHaveCount(1);
    await expect(nameCell(page, names[1])).toHaveCount(0);
  });

  test("an expired session reverts the decision and says so; a fresh session lands the same gesture", async ({
    page,
    context,
  }) => {
    // `hq_demo_session=expired` was named in a comment in this file and set by
    // nothing — the auth branch at companies-surface.tsx had no proof. Same
    // arming pattern as `hq_demo_fail` above: cookie on, gesture, cookie off.
    await isolate(page, "verbs-session");
    await page.goto("/companies");
    await ready(page);
    const cells = page.locator('[role="gridcell"][data-col="name"]');
    const before = await cells.count();
    const name = (await cells.nth(0).locator(NAME_TEXT).innerText()).trim();

    await cells.nth(0).click();
    await expect(page.getByTestId("review-count")).toHaveText("1 selected");

    await context.addCookies([{ name: "hq_demo_session", value: "expired", url: ORIGIN }]);
    await page.getByTestId("bulk-approve").click();

    // The auth copy, exactly — and NOT the offline copy. Two different
    // failures with two different ways out; asserting both strings is what
    // makes a branch-collapsing refactor fail instead of shipping.
    await expect(
      page.getByText("Couldn't save that. Your session expired.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Sign in and try again.", { exact: true })).toBeVisible();
    await expect(page.getByText("You may be offline")).toHaveCount(0);

    // Full revert, no Undo: the row is exactly where it was.
    await expect(cells).toHaveCount(before);
    await expect(nameCell(page, name)).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);

    // Signing back in is clearing the cookie; the REPEATED gesture must land.
    // The selection does not survive the revert (pruneSelection drops hidden
    // keys, matrix row 72, working as designed), so the human selects again.
    await context.clearCookies({ name: "hq_demo_session" });
    await nameCell(page, name).click();
    await expect(page.getByTestId("review-count")).toHaveText("1 selected");
    await page.getByTestId("bulk-approve").click();
    await expect(page.getByText(/Added .* to your universe/)).toBeVisible();
    await expect(nameCell(page, name)).toHaveCount(0);

    // And it SURVIVES A RELOAD — the second gesture wrote, the first did not.
    await page.reload();
    await ready(page);
    await expect(cells).toHaveCount(before - 1);
    await page.goto("/companies?set=universe");
    await ready(page);
    await expect(nameCell(page, name)).toHaveCount(1);
  });
});

// ---------------------------------------------------------------- the sweep flag

test.describe("the per-row sweep flag", () => {
  test("an approved row's flag toggles and SURVIVES A RELOAD", async ({ page }) => {
    // `app_set_company_flags` and `setCompanyFlagsAction` had no caller at all: a
    // live security-definer endpoint with nothing behind it, and matrix row 86
    // guarding a path the app could not reach. This is that caller.
    await isolate(page, "sweep-toggle");
    await page.goto("/companies?set=universe");
    await ready(page);

    // `.first()` on the ROW, not on the toggle inside a `has:` filter — a `has:`
    // locator is re-evaluated per candidate row, so `.first()` inside it matches
    // every row that owns an enabled toggle rather than narrowing to one.
    const row = page
      .locator('[role="row"]')
      .filter({ has: page.locator('[data-testid="sweep-toggle"][data-enabled="true"]') })
      .first();
    const name = (await row.locator(`[data-col="name"] ${NAME_TEXT}`).innerText()).trim();
    await row.getByTestId("sweep-toggle").click();

    const toggle = page
      .locator('[role="row"]', { has: nameCell(page, name) })
      .getByTestId("sweep-toggle");
    await expect(toggle).toHaveAttribute("data-enabled", "false");
    // Was `toHaveText("Paused")`. The badge became the design's switch, so the
    // off state is stated as `aria-checked` and in the accessible name.
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toHaveAttribute("aria-label", /Paused$/);

    await page.reload();
    await ready(page);
    await expect(
      page.locator('[role="row"]', { has: nameCell(page, name) }).getByTestId("sweep-toggle"),
    ).toHaveAttribute("data-enabled", "false");
  });

  test("an unreviewed row offers no switch at all", async ({ page }) => {
    // The SQL refuses a flag write on a row that is not approved, so a control
    // that always errors is worse than no control. The review verbs are what turn
    // the flag on.
    await isolate(page, "sweep-unreviewed");
    await page.goto("/companies?set=all");
    await ready(page);
    const proposed = page.locator('[role="row"]', {
      has: page.locator('[data-col="review"]', { hasText: "Waiting for you" }),
    });
    await expect(proposed.first()).toBeVisible();
    await expect(proposed.first().getByTestId("sweep-toggle")).toHaveCount(0);
    await expect(proposed.first().getByTestId("sweep-none")).toHaveCount(1);
  });

  test("a failed flag write reverts the switch", async ({ page, context }) => {
    await isolate(page, "sweep-fail");
    await page.goto("/companies?set=universe");
    await ready(page);
    const row = page
      .locator('[role="row"]')
      .filter({ has: page.locator('[data-testid="sweep-toggle"][data-enabled="true"]') })
      .first();
    const name = (await row.locator(`[data-col="name"] ${NAME_TEXT}`).innerText()).trim();

    await context.addCookies([{ name: "hq_demo_fail", value: "nope", url: ORIGIN }]);
    await row.getByTestId("sweep-toggle").click();
    await expect(page.getByText(/Couldn't change that/)).toBeVisible();
    await expect(
      page.locator('[role="row"]', { has: nameCell(page, name) }).getByTestId("sweep-toggle"),
    ).toHaveAttribute("data-enabled", "true");
  });

  test("a stale sweep toggle settles on the SERVER's row, not the optimistic guess", async ({
    page,
    context,
  }) => {
    // Matrix row 113's shape: the screen must match the store, not just
    // apologise. The conflict branch takes `res.current` — the row the server
    // returned — rather than reverting blind to the captured value.
    //
    // Same two-tab trap as the batch test: the second page gets NO isolate()
    // of its own, or there is no shared store and no conflict.
    await isolate(page, "sweep-conflict");
    await page.goto("/companies?set=universe");
    await ready(page);
    const row = page
      .locator('[role="row"]')
      .filter({ has: page.locator('[data-testid="sweep-toggle"][data-enabled="true"]') })
      .first();
    const name = (await row.locator(`[data-col="name"] ${NAME_TEXT}`).innerText()).trim();

    // Tab B, same store: toggle the row OFF and back ON. The server ends where
    // tab A's screen already is — enabled — but two version bumps ahead. The
    // round trip is the point: after tab A's stale toggle below, the
    // optimistic guess (off) and the server's row (on) DISAGREE, so a branch
    // that kept the guess and merely apologised fails here. One toggle in tab
    // B could not see that — guess and server would both read off.
    const other = await context.newPage();
    await other.goto("/companies?set=universe");
    await ready(other);
    const otherToggle = other
      .locator('[role="row"]', { has: nameCell(other, name) })
      .getByTestId("sweep-toggle");
    await otherToggle.click();
    await expect(otherToggle).toHaveAttribute("data-enabled", "false");
    await otherToggle.click();
    await expect(otherToggle).toHaveAttribute("data-enabled", "true");
    await other.close();

    // Tab A, stale token: the switch draws the guess, the store says conflict,
    // and the screen settles on the SERVER's row — with the conflict copy,
    // exactly, and no "Nothing was applied" clause: this branch applies the
    // latest, it does not revert to the past.
    const toggle = page
      .locator('[role="row"]', { has: nameCell(page, name) })
      .getByTestId("sweep-toggle");
    await toggle.click();
    await expect(
      page.getByText("Changed on another device. Showing the latest.", { exact: true }),
    ).toBeVisible();
    await expect(toggle).toHaveAttribute("data-enabled", "true");
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    // And the settled row carries the server's VERSION TOKEN, not the stale
    // one: the next toggle lands. A blind revert would leave the stale token
    // in place and conflict forever — this is what distinguishes `res.current`
    // from a repaint that happens to show the right value.
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-enabled", "false");
    await page.reload();
    await ready(page);
    await expect(
      page.locator('[role="row"]', { has: nameCell(page, name) }).getByTestId("sweep-toggle"),
    ).toHaveAttribute("data-enabled", "false");
  });

  test("typing in the search box does not fire a review verb", async ({ page }) => {
    // Matrix row 78, on a new surface: with a selection held, `a` typed into a field
    // must be text.
    await isolate(page, "verbs-typing");
    await page.goto("/companies");
    await ready(page);
    const before = await page.locator('[role="gridcell"][data-col="name"]').count();
    await page.locator('[role="gridcell"][data-col="name"]').nth(0).click();
    await expect(page.getByTestId("review-count")).toHaveText("1 selected");

    await page.getByTestId("company-search").fill("a");
    await expect(page.getByTestId("company-search")).toHaveValue("a");
    await page.getByTestId("company-search").fill("");
    await expect(page.locator('[role="gridcell"][data-col="name"]')).toHaveCount(before);
  });
});

// ---------------------------------------------------------------- coverage

/**
 * The summary sentence that replaced the coverage meter.
 *
 * The meter is gone by design instruction, not by preference: `Coverage.dc.html`
 * line 25 is one sentence with two numbers, and the guardrail behind it forbids
 * meters, gauges and progress rings for coverage or confidence. Three of the four
 * meter tests went with it, and what they were each protecting is stated here so a
 * later reader can see what was and was not given up:
 *
 *   * "separates confirmed day-of from Tier-1-as-expected" protected the claim that
 *     a mined slug never reads as a board answer. That claim did NOT move into the
 *     sentence — it lives per row, on the chip, and "confirmed and manually added
 *     rows are distinguishable" plus "every row's chip names a confidence" above
 *     are the tests that hold it. Nothing is uncovered.
 *   * "states that recall is NOT measured" protected a labelled empty slot that the
 *     design retires along with the meter. A sentence that counts the companies you
 *     track, and says nothing about a share of anything, has no recall to misstate —
 *     so the property is now enforced as an ABSENCE, below.
 *   * "the rail's segments are confidences and sum to the total" protected the
 *     arithmetic: what is drawn accounts for every row. The sentence keeps that
 *     claim and it is checked directly against the table instead of against pixels,
 *     which is strictly the stronger form.
 *   * "does not render NaN on an empty universe" keeps its title and its store,
 *     because it is a ledger citation and because the hazard is the same one.
 */
test.describe("the coverage summary", () => {
  test("the summary's two numbers account for every company in the universe", async ({
    page,
  }) => {
    await isolate(page, "cov-arith");
    await page.goto("/companies");
    await ready(page);

    const summary = page.getByTestId("coverage-summary");
    await expect(summary).toBeVisible();
    const [watching, total] = (await page.getByTestId("coverage-watching").innerText())
      .trim()
      .match(/(\d+) of (\d+)/)!
      .slice(1)
      .map(Number);
    expect(total).toBeGreaterThan(0);

    const unresolvedEl = page.getByTestId("coverage-unresolved");
    const unresolved =
      (await unresolvedEl.count()) === 0 ? 0 : Number((await unresolvedEl.innerText()).trim());
    // The partition, stated: every approved company is either readable or not.
    expect(watching + unresolved).toBe(total);

    // And the denominator is the approved set the sentence claims, not the whole
    // table. Counting the review pile would make the number climb every time
    // discovery ran and fall the moment somebody did their job.
    await page.goto("/companies?set=universe");
    await ready(page);
    const rowCount = await page.locator('[role="row"][aria-rowindex]:not([aria-rowindex="1"])').count();
    expect(rowCount).toBe(total);
  });

  test("the summary states no share, percentage or measurement of anything", async ({
    page,
  }) => {
    // What the retired oracle slot was defending. The most damaging thing this
    // surface could do is imply it knows what fraction of the companies that exist
    // it covers; a sentence with no percentage in it cannot.
    await isolate(page, "cov-noshare");
    await page.goto("/companies");
    await ready(page);
    const text = await page.getByTestId("coverage-summary").innerText();
    expect(text).not.toMatch(/\d+\s?%/);
    expect(text).not.toMatch(/recall|share|coverage of|universe/i);
  });

  test("does not render NaN on an empty universe", async ({ page, context }) => {
    await isolate(page, "cov-empty");
    await context.addCookies([{ name: "hq_demo_seed", value: "empty", url: ORIGIN }]);
    await page.goto("/companies");
    await ready(page);
    const text = await page.getByTestId("coverage-summary").innerText();
    expect(text).not.toMatch(/NaN|Infinity/);
    await expect(page.getByTestId("coverage-watching")).toHaveText("Watching 0 of 0");
    // The second clause is omitted rather than reading "0 have no job board":
    // stating an absence as if it were news is its own small lie.
    await expect(page.getByTestId("coverage-unresolved")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------- logos + absence

test.describe("the company logo, and what an absent fact reads as", () => {
  /**
   * The 16px avatar inside the name cell — the inner span, not the cell, so the
   * assertion is about the avatar and not about the name beside it.
   */
  const logoCell = (page: Page, company: string) =>
    page
      .locator('[role="row"]', { has: nameCell(page, company) })
      .locator('[role="gridcell"][data-col="name"] > span > span')
      .first();

  test("a company the universe has no domain for is on the monogram already", async ({
    page,
  }) => {
    // No route interception: this rung is reached by having nothing to request,
    // which is production's common case. Fifth Third Bank is approved with
    // `domain: null` in the fixture universe. If this ever starts issuing a logo
    // request, the fixture source has drifted off SupabaseDataSource's behaviour.
    const requested: string[] = [];
    page.on("request", (r) => {
      if (/logo\.dev|s2\/favicons/.test(r.url())) requested.push(r.url());
    });
    await isolate(page, "logo-monogram");
    await page.goto("/companies?set=all");
    await ready(page);
    await expect(logoCell(page, "Fifth Third Bank")).toHaveText("FT");
    expect(requested.filter((u) => u.includes("fifththird"))).toEqual([]);
  });

  test("the monogram is decorative, so the company column does not read as 'R A Ramp'", async ({
    page,
  }) => {
    // Coverage shows more logos than any other surface, so this is where the
    // `alt=""`-does-nothing-for-the-monogram defect costs the most: every row of
    // the leftmost column announcing its initials before its name.
    //
    // Fifth Third Bank, not Ramp with the logo hosts aborted. The first version
    // of this test aborted logo.dev and the favicon host and asserted on Ramp,
    // which carries a domain — and it FAILED on the mobile project only, because
    // reaching the monogram that way depends on React's `onError` firing, and a
    // row rendered on the SERVER fires its image error before hydration attaches
    // the handler. That is a real defect on this surface and it belongs to
    // feat/redesign-today, which fixes it; a test that passes or fails depending
    // on who wins that race measures the race, not the accessibility claim.
    // A company with no domain has no image rung at all, so the monogram is what
    // renders on the server, deterministically, on both projects.
    //
    // MUTATION REASON: drop `aria-hidden` from LogoAvatar's wrapper and `spoken`
    // below gains the initials, failing here.
    await isolate(page, "logo-decorative");
    await page.goto("/companies?set=all");
    await ready(page);

    const cell = page
      .locator('[role="row"]', { has: nameCell(page, "Fifth Third Bank") })
      .locator('[role="gridcell"][data-col="name"]')
      .first();
    // The rendered text still carries the initials; the ACCESSIBLE name must
    // not. Asserting both is what distinguishes "hidden" from "deleted".
    await expect(cell).toContainText("FT");
    const spoken = await cell.evaluate((el) => {
      const walk = (node: Element): string =>
        [...node.childNodes]
          .map((c) => {
            if (c.nodeType === Node.TEXT_NODE) return c.textContent ?? "";
            if (!(c instanceof Element)) return "";
            return c.getAttribute("aria-hidden") === "true" ? "" : walk(c);
          })
          .join("");
      return walk(el).trim();
    });
    expect(spoken).toBe("Fifth Third Bank");
  });

  test("a company with no job board reads Not listed, never an empty cell", async ({ page }) => {
    // Section 5's "Missing optional fact" row on this surface. The unresolved set
    // is defined by having no board at all, so every row in it must SAY that in
    // the one word this product uses for an absent fact — a blank cell in a table
    // reads as a broken row, and "none", "N/A" and "null" are all banned.
    //
    // MUTATION REASON: return "" instead of ABSENT from `boardText` and every row
    // here goes blank, failing the per-row assertion below.
    await isolate(page, "absent-board");
    await page.goto("/companies?set=unresolved");
    await ready(page);
    const boards = page.locator('[role="gridcell"][data-col="board"]');
    const n = await boards.count();
    expect(n).toBeGreaterThan(0);
    // The WHOLE set, not the first row: the property is about absence, and a
    // narrower check passes a half-fix.
    for (let i = 0; i < n; i++) {
      await expect(boards.nth(i)).toHaveText("Not listed");
    }
  });
});

// ---------------------------------------------------------------- target size

test.describe("the row controls are big enough to hit", () => {
  /**
   * WCAG 2.2 SC 2.5.8, Target Size (Minimum): 24x24 CSS pixels.
   *
   * This guard exists because NOTHING in this repo checks target size — not axe
   * (the rule is AAA-adjacent and every call here filters to wcag2a/wcag2aa at
   * serious-or-critical), not the slop sweep, not the layout sweep. So the one
   * defect class that arrives every time a text control becomes an icon control
   * had no machine watching it, and this surface just made exactly that swap:
   * the "Included in scans" cell went from a text badge, which was comfortably
   * tappable, to a switch — once per row, on the surface with the most rows.
   *
   * The switch is therefore drawn as a 32x18 track inside a 32x24 button. The
   * button is the target; the track is the paint.
   *
   * MUTATION REASON: change the button's `h-6` to `h-[18px]` in
   * `sweep-toggle.tsx` — i.e. make the hit area the visible track, which is what
   * the naive port did — and this fails at 18 < 24.
   */
  test("every switch in the grid meets the 24px minimum target", async ({ page }) => {
    await isolate(page, "target-size");
    await page.goto("/companies?set=universe");
    await ready(page);

    const switches = page.locator('[role="row"] [role="switch"]');
    const n = await switches.count();
    expect(n, "no switch rendered, so this test would pass vacuously").toBeGreaterThan(0);

    // Every one, not the first: the property is about a control that repeats per
    // row, and a first-row-only check passes a half-fix.
    const undersized: string[] = [];
    for (let i = 0; i < n; i++) {
      const box = await switches.nth(i).boundingBox();
      if (!box) {
        undersized.push(`switch ${i}: no box`);
        continue;
      }
      if (box.width < 24 || box.height < 24) {
        undersized.push(`switch ${i}: ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
    }
    expect(undersized, "WCAG 2.2 SC 2.5.8 requires 24x24 CSS px").toEqual([]);
  });
});

// ---------------------------------------------------------------- sets + URL

test.describe("working sets and the URL", () => {
  test("a deep link paints its own state in the SERVER HTML", async ({ page }) => {
    // No post-hydration pop: the raw response already carries the sorted, filtered
    // grid (matrix row 58's assertion, on this surface).
    await isolate(page, "url-server");
    const res = await page.goto("/companies?set=universe&sort=tier:asc");
    const html = await res!.text();
    expect(html).toContain("approved and in your universe");
    await ready(page);
    await expect(page.getByTestId("company-view-switcher")).toHaveAttribute(
      "data-set",
      "universe",
    );
  });

  test("Back unwinds a set change in one step", async ({ page }) => {
    await isolate(page, "url-back");
    await page.goto("/companies");
    await ready(page);
    await page.getByTestId("company-view-switcher").click();
    await page.getByRole("menuitemradio", { name: "All companies" }).click();
    await expect(page).toHaveURL(/set=all/);
    await page.goBack();
    await expect(page).not.toHaveURL(/set=all/);
    await expect(page.getByTestId("company-view-switcher")).toHaveAttribute(
      "data-set",
      "review",
    );
  });

  test("a bogus set or sort renders the default rather than crashing", async ({ page }) => {
    // Matrix row 55: dropped, never "repaired", never a white screen.
    await isolate(page, "url-bogus");
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("/companies?set=banana&sort=tier:sideways");
    await ready(page);
    await expect(page.getByTestId("company-view-switcher")).toHaveAttribute(
      "data-set",
      "review",
    );
    // Half-valid is not valid: no arrow on any header.
    expect(await page.locator('[aria-sort]').count()).toBe(0);
    expect(errors).toEqual([]);
  });

  test("a persona applies its set and its sort in one gesture", async ({ page }) => {
    await isolate(page, "url-persona");
    await page.goto("/companies");
    await ready(page);
    await page.getByTestId("company-view-switcher").click();
    await page.getByTestId("company-persona-roommate").click();
    await expect(page).toHaveURL(/set=universe/);
    await expect(page).toHaveURL(/sort=tier%3Aasc|sort=tier:asc/);
    await ready(page);
    // Day-of first means verified-before-unverified INSIDE tier 1, which is the
    // distinction a plain numeric sort would lose.
    const confidences = await page
      .getByTestId("provenance-chip")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-confidence")));
    expect(confidences[0]).toBe("verified");
    expect(confidences.indexOf("verified")).toBeLessThan(
      confidences.lastIndexOf("asserted") === -1 ? 99 : confidences.lastIndexOf("asserted"),
    );
  });

  test("the switcher is reachable on a phone", async ({ page }, testInfo) => {
    // Matrix row 71: a desktop-only switcher left a phone user with no on-screen way
    // to leave the set they landed in.
    test.skip(testInfo.project.name !== "mobile", "phone-viewport concern");
    await isolate(page, "url-phone");
    await page.goto("/companies");
    await ready(page);
    await expect(page.getByTestId("company-view-switcher")).toBeVisible();
    await page.getByTestId("company-view-switcher").click();
    await page.getByRole("menuitemradio", { name: "All companies" }).click();
    await expect(page).toHaveURL(/set=all/);
  });

  test("the grid states its own counts", async ({ page }) => {
    // Row 50: a grid that silently shows a subset. "6 of 12" cannot pass as "6 of 6".
    await isolate(page, "url-counts");
    await page.goto("/companies?set=all");
    await ready(page);
    const rows = await page.locator('[role="row"][data-key]').count();
    const text = await page.getByTestId("company-count").innerText();
    expect(text).toMatch(new RegExp(`All ${rows} companies`));
  });

  test("a zero-result search offers a way back", async ({ page }) => {
    await isolate(page, "url-nomatch");
    await page.goto("/companies");
    await ready(page);
    await page.getByTestId("company-search").fill("zzzzz-no-such-company");
    await expect(page.getByTestId("empty-state")).toContainText("Nothing matches that search");
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(page.locator('[role="row"][data-key]').first()).toBeVisible();
    // The resurrection bug (matrix row 59): a pending debounce must not re-apply the
    // query that was just cleared.
    await page.waitForTimeout(500);
    await expect(page.getByTestId("company-search")).toHaveValue("");
    await expect(page.locator('[role="row"][data-key]').first()).toBeVisible();
  });
});

// ---------------------------------------------------------------- paste

test.describe("adding companies by paste", () => {
  test("previews the parse, then lands the rows in the review set", async ({ page }) => {
    await isolate(page, "paste-flow");
    await page.goto("/companies/add");
    // The page must say what it does NOT do before the input, not in an error later.
    await expect(page.getByText(/This adds names, not boards/)).toBeVisible();

    await page
      .getByTestId("paste-box")
      .fill("Kraft Heinz\n- 1. Mondelez\nADM, Zurich Insurance\n\n");
    const preview = page.getByTestId("paste-preview");
    await expect(preview).toContainText("4 companies will be proposed");
    // The combined list marker is stripped — the bug the preview surfaced.
    await expect(preview).toContainText("Mondelez");
    expect(await preview.innerText()).not.toContain("1. Mondelez");

    await page.getByTestId("paste-submit").click();
    await expect(page.getByText(/Added 4 proposals/)).toBeVisible();

    await page.goto("/companies?set=review");
    await ready(page);
    for (const name of ["Kraft Heinz", "Mondelez", "ADM", "Zurich Insurance"]) {
      await expect(nameCell(page, name)).toHaveCount(1);
    }
  });

  test("a pasted row is marked added by you, never as confirmed", async ({ page }) => {
    // The load-bearing claim of the whole path. Nothing in this app resolves a board,
    // so a pasted name may not carry a reliability promise.
    await isolate(page, "paste-tier");
    await page.goto("/companies/add");
    await page.getByTestId("paste-box").fill("Wintrust Financial");
    await page.getByTestId("paste-submit").click();
    await expect(page.getByText(/Added 1 proposal/)).toBeVisible();

    await page.goto("/companies?set=review");
    await ready(page);
    const chip = page
      .locator('[role="row"]', { has: nameCell(page, "Wintrust Financial") })
      .getByTestId("provenance-chip");
    await expect(chip).toHaveText("Added by you");
    await expect(chip).toHaveAttribute("data-confidence", "asserted");
  });

  test("re-pasting the same names adds nothing and says so", async ({ page }) => {
    // The second paste happens on a FRESH VISIT, and that is not cosmetic.
    //
    // Clicking submit twice in one visit fails on a phone, and it is the app's fault,
    // not the test's: typing the second list re-opens the preview box, which pushes
    // the primary action from y=689 down to y=773 — into the 749-823 strip the toast
    // from the FIRST paste occupies. On a 412x839 viewport the page is exactly one
    // screen tall, so there is nowhere to scroll the button clear, and sonner pauses
    // its 8s dismiss timer while a pointer is over the toaster — which is precisely
    // where Playwright parks the cursor while retrying. The click never lands, and it
    // burns the full 30s instead of waiting 8. It passed on macOS and failed on CI
    // because whether the preview pushes the button far enough depends on how the
    // copy above it wraps, which is a font question.
    //
    // The form now carries a bottom safe area so a human can scroll past the strip
    // (and `closeButton` on the Toaster is the other way out). The test does not
    // fight a live toast at all: coming back and pasting the same list is the real
    // journey the name describes, and it proves something stronger — the dedupe holds
    // across a page load, not just inside one client-side session.
    await isolate(page, "paste-dupe");
    await page.goto("/companies/add");
    await page.getByTestId("paste-box").fill("Exelon Corp");
    await page.getByTestId("paste-submit").click();
    await expect(page.getByText(/Added 1 proposal/)).toBeVisible();

    await page.goto("/companies/add");
    await page.getByTestId("paste-box").fill("exelon corp");
    await page.getByTestId("paste-submit").click();
    await expect(page.getByText(/already in your universe/)).toBeVisible();
  });

  test("a phone can reach the submit button while the previous toast is up", async ({
    page,
  }, testInfo) => {
    // The product half of the bug above, asserted so it cannot come back.
    //
    // The claim is NOT that the toast never overlaps — a bottom-anchored toast on a
    // one-screen page will overlap whatever is at the bottom, and reserving a strip
    // for it on every surface is a bigger change than this. The claim is that there
    // is always a way through: the page scrolls far enough to lift the action clear.
    test.skip(testInfo.project.name !== "mobile", "the strip only bites at phone heights");
    await isolate(page, "paste-reachable");
    await page.goto("/companies/add");
    await page.getByTestId("paste-box").fill("Exelon Corp");
    await page.getByTestId("paste-submit").click();
    await expect(page.getByText(/Added 1 proposal/)).toBeVisible();
    await page.getByTestId("paste-box").fill("something else entirely");

    // Scroll to the end of the document, as a thumb would.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(150);

    const clear = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="paste-submit"]')!.getBoundingClientRect();
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return hit ? hit.closest('[data-testid="paste-submit"]') !== null : false;
    });
    expect(clear, "the toast still covers the submit button after scrolling to the end").toBe(true);
  });

  test("the submit button is inert until something parses", async ({ page }) => {
    await isolate(page, "paste-inert");
    await page.goto("/companies/add");
    await expect(page.getByTestId("paste-submit")).toBeDisabled();
    await page.getByTestId("paste-box").fill("   ,,, \n\n");
    await expect(page.getByTestId("paste-preview")).toContainText("Nothing recognised");
    await expect(page.getByTestId("paste-submit")).toBeDisabled();
  });
});

// ---------------------------------------------------------------- the API route

test.describe("POST /api/companies/propose", () => {
  /** Per-project store, for `isolate`'s reason: one server, two projects. */
  const apiHeaders = (id: string) => ({
    cookie: `hq_demo_id=${test.info().project.name}-${id}`,
  });

  test("accepts a list and returns tier-3 proposals", async ({ request }) => {
    const res = await request.post("/api/companies/propose", {
      data: { names: ["Baxter International", "Walgreens Boots Alliance"], source: "import" },
      headers: apiHeaders("api-accept"),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.added).toBe(2);
    for (const row of body.proposed) {
      expect(row.tier).toBe(3);
      expect(row.resolutionMethod).toBe("manual");
      expect(row.reviewState).toBe("proposed");
    }
  });

  test("answers 501 for a facet — asked right, not built", async ({ request }) => {
    // 501 rather than 400 on purpose: 400 means "you asked wrong" and would send a
    // caller off to retry with different input, when the truth is that this end does
    // not exist yet.
    const res = await request.post("/api/companies/propose", {
      data: { facet: "Chicago finance, treasury roles" },
    });
    expect(res.status()).toBe(501);
    const body = await res.json();
    expect(body.reason).toContain("discovery_agent");
  });

  test("rejects a source tag outside the closed vocabulary", async ({ request }) => {
    // `source` is the dimension the coverage meter groups by, and this route takes
    // calls from outside the browser — an unbounded tag writes a novel into a
    // group-by. 0008 refuses it too; failing at the boundary makes it a sentence
    // rather than a Postgres error string.
    const res = await request.post("/api/companies/propose", {
      data: { names: ["Somebody"], source: "a-novel-about-provenance" },
      headers: apiHeaders("api-source"),
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain("Unknown `source` tag");
  });

  test("rejects a body with no usable names", async ({ request }) => {
    expect((await request.post("/api/companies/propose", { data: {} })).status()).toBe(400);
    expect(
      (await request.post("/api/companies/propose", { data: { names: [",,,", "  "] } })).status(),
    ).toBe(400);
    expect(
      (
        await request.post("/api/companies/propose", {
          data: { names: Array.from({ length: 501 }, (_, i) => `Co ${i}`) },
        })
      ).status(),
    ).toBe(413);
  });

  test("replays an idempotency key instead of double-adding", async ({ request }) => {
    // The cookie is sent EXPLICITLY, and that is not incidental. In demo mode the
    // store is keyed by `hq_demo_id`, which middleware mints on first visit — so the
    // request that mints it reads `cookies()` before the response has set it and
    // lands in the shared store, while the second request lands in the newly-named
    // one. Two stores, two inserts, and the replay this test is about never gets a
    // chance to fire. Naming the store up front puts both calls in the same place,
    // which is what the assertion is actually about.
    const headers = apiHeaders("api-replay");
    const data = { names: ["Guggenheim Investments"], idempotencyKey: "e2e-replay-key" };
    const a = await (await request.post("/api/companies/propose", { data, headers })).json();
    const b = await (await request.post("/api/companies/propose", { data, headers })).json();
    expect(a.added).toBe(1);
    expect(b).toEqual(a);
  });

  test("a GET explains itself instead of bare-405ing", async ({ request }) => {
    const res = await request.get("/api/companies/propose");
    expect(res.status()).toBe(405);
    expect((await res.json()).contract).toBeTruthy();
  });
});

// ---------------------------------------------------------------- looks

test.describe("it does not visually break", () => {
  test("the grid scrolls inside its own container at 280px", async ({ page }) => {
    // Row 49: the grid must overflow ITSELF, never the page.
    await isolate(page, "look-narrow");
    await page.setViewportSize({ width: 280, height: 900 });
    await page.goto("/companies?set=all");
    await ready(page);
    const offenders = await page.evaluate(collectPaintedOverflow);
    expect(offenders, describeOffenders(offenders)).toEqual([]);
    const scrollable = await page
      .getByTestId("company-scroll")
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrollable, "the grid should scroll inside its container at 280px").toBe(true);
  });

  test("a selection stays accessible and does not shift the rows", async ({ page }) => {
    // Row 79 (the bar must not move the grid) and row 82 (muted text on the selected
    // tint failed AA, which only an axe scan WITH a selection could catch).
    await isolate(page, "look-selected");
    await page.goto("/companies?set=all");
    await ready(page);
    const firstRow = page.locator('[role="row"][data-key]').first();
    const before = await firstRow.boundingBox();

    const cells = page.locator('[role="gridcell"][data-col="name"]');
    await cells.nth(0).click();
    await cells.nth(3).click({ modifiers: ["Shift"] });
    await expect(page.getByTestId("review-count")).toHaveText("4 selected");

    const after = await firstRow.boundingBox();
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(1.5);

    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const serious = results.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    );
    expect(
      serious.map((v) => `${v.id}: ${v.nodes[0]?.failureSummary ?? ""}`),
      "axe violations with a selection held",
    ).toEqual([]);
  });

  test("the sticky first column stays pinned under horizontal scroll", async ({ page }) => {
    // Row 48: rows are positioned with `top`, never translateY — a transform makes
    // the row a containing block and silently kills position:sticky on the cell.
    await isolate(page, "look-sticky");
    await page.setViewportSize({ width: 700, height: 800 });
    await page.goto("/companies?set=all");
    await ready(page);
    const cell = page.locator('[role="gridcell"][data-col="name"]').first();
    const before = await cell.boundingBox();
    await page.getByTestId("company-scroll").evaluate((el) => el.scrollTo({ left: 400 }));
    await page.waitForTimeout(120);
    const after = await cell.boundingBox();
    expect(Math.abs(after!.x - before!.x)).toBeLessThan(1.5);
  });

  test("the loading skeleton carries every band the loaded page does", async ({ page }) => {
    // The half of matrix row 7 that actually bit: the queue's skeleton drew only the
    // card while the page drew a header above it. Here the hazard is the COVERAGE
    // band, which sits between the toolbar and the grid — a skeleton missing it drops
    // every grid row by its height on load.
    //
    // FONT-INDEPENDENT ON PURPOSE, and this is the whole reason the sibling pixel
    // assertion moved out of this file into `visual.spec.ts`. A skeleton's bands are
    // fixed-height blocks; the loaded page's are text that REFLOWS, and how many line
    // boxes a sentence occupies is a font question. On GitHub's bare runner the
    // header subtitle and the coverage headline each wrap where they do not wrap on
    // macOS or in the Playwright container, and the loaded rail sat 36px below the
    // skeleton's — a real jump, on those fonts, that no fixed-height skeleton can
    // track. Counting and ordering the bands catches the regression that actually
    // happened (a missing band) and cannot be moved by a font.
    await isolate(page, "look-skeleton-bands");
    await page.goto("/coverage");
    await page.route(/\/companies/, async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.getByRole("link", { name: "Go to companies" }).click();
    const skeleton = page.getByTestId("companies-skeleton");
    await skeleton.waitFor({ state: "attached", timeout: 10_000 });

    // header · toolbar · coverage · grid, in that order — four children plus the
    // sr-only announcement.
    const bands = await skeleton.evaluate((el) => {
      const kids = [...el.children].filter((c) => !c.classList.contains("sr-only"));
      return kids.map((c) => c.tagName.toLowerCase());
    });
    expect(bands, "the skeleton is missing a band the loaded page has").toEqual([
      "header",
      "div",
      "div",
      "div",
    ]);
    await expect(page.getByTestId("companies-skeleton-colheads")).toBeVisible();

    // The column rail is INSIDE the last band and below the other three — the
    // ordering claim the pixel measurement used to make, stated as geometry that no
    // font can change.
    const order = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="companies-skeleton"]')!;
      const kids = [...el.children].filter((c) => !c.classList.contains("sr-only"));
      const rail = document.querySelector('[data-testid="companies-skeleton-colheads"]')!;
      const top = (n: Element) => n.getBoundingClientRect().top;
      return {
        railInLastBand: kids[3].contains(rail),
        ascending: kids.every((k, i) => i === 0 || top(k) >= top(kids[i - 1])),
        railBelowCoverage: top(rail) >= kids[2].getBoundingClientRect().bottom - 1,
        everyBandHasHeight: kids.every((k) => k.getBoundingClientRect().height > 0),
      };
    });
    expect(order).toEqual({
      railInLastBand: true,
      ascending: true,
      railBelowCoverage: true,
      everyBandHasHeight: true,
    });

    // And the loaded page really does put the coverage band between the toolbar and
    // the grid — so the skeleton is mirroring the order it claims to mirror.
    await ready(page, 20_000);
    const loadedOrder = await page.evaluate(() => {
      const cov = document.querySelector('[data-testid="coverage-summary"]')!.getBoundingClientRect();
      const row = document.querySelector('[role="row"][aria-rowindex="1"]')!.getBoundingClientRect();
      const hdr = document.querySelector("header")!.getBoundingClientRect();
      return { coverageAfterHeader: cov.top >= hdr.bottom, gridAfterCoverage: row.top >= cov.bottom };
    });
    expect(loadedOrder).toEqual({ coverageAfterHeader: true, gridAfterCoverage: true });
  });

});
