import { expect, test, type Page } from "@playwright/test";

/**
 * The Search Profile, driven through the real UI.
 *
 * The claims worth an E2E rather than a unit test are the ones that only exist
 * once a browser has laid the page out and a server action has round-tripped:
 *
 *   * The dry run WRITES NOTHING. `app_preview_corpus` is `stable`, so Postgres
 *     enforces it in production — but the demo store has no such guard, and the
 *     fake is what the whole suite drives. Asserted here by checking the
 *     server's own version token is untouched across a preview (matrix row 81).
 *   * A save really lands, and SURVIVES A RELOAD. The assertion this whole suite
 *     once lacked: every E2E asserted client state right after a gesture and not
 *     one reloaded, so a write into a store nothing else read passed everything.
 *   * The preview goes STALE when a setting changes under it, in words, on
 *     screen (matrix row 95).
 *   * Double-submitting Save leaves ONE change and no error toast. The
 *     idempotency claim UNDERNEATH that is deliberately proven elsewhere — see
 *     the note on that test for the mutant that survived here and why.
 *   * The binding constraint's name is a LINK, and it lands on the section that
 *     caused it (row 84).
 *
 * Every wait is on a SERVER FACT — `data-profile-version`, which the server
 * component renders from `profiles.updated_at`. Not a client counter: a counter
 * lives in a component that can unmount, and rows 117 and 164 are both what
 * that costs.
 */

const ORIGIN = "http://127.0.0.1:3210";

/** Own demo store per test, keyed by project — matrix row 91. */
async function isolate(page: Page, id: string) {
  const project = test.info().project.name;
  await page
    .context()
    .addCookies([{ name: "hq_demo_id", value: `${project}-${id}`, url: ORIGIN }]);
}

/**
 * Enter the surface and wait until it is INTERACTIVE, not merely painted.
 *
 * The server renders every input and button here before React attaches a
 * handler, and on a loaded CI runner a click landing in that gap fires into
 * nothing — `pipeline-table.tsx` paid for this lesson with two blur-commits that
 * left no POST in the trace at all. `data-hydrated` flips in an effect, so it
 * cannot be true early. Every test enters through this.
 */
async function gotoSettings(page: Page) {
  await page.goto("/settings");
  await expect(page.getByTestId("profile-form")).toHaveAttribute("data-hydrated", "true");
}

async function version(page: Page): Promise<string> {
  return (await page.locator("[data-profile-version]").getAttribute("data-profile-version")) ?? "";
}

/**
 * The server's version token, waited for rather than sampled.
 *
 * An instant read of rendered text or an attribute is a race with the render
 * that produces it — `empty.spec.ts` earned that rule — and this value is a
 * PRECONDITION for the assertions that follow, so reading "" here would make
 * them compare against nothing.
 */
async function versionOnce(page: Page): Promise<string> {
  await expect.poll(async () => version(page), { timeout: 15_000 }).not.toBe("");
  return version(page);
}

/**
 * Empty a chip list.
 *
 * One at a time, re-locating each round: `.all()` resolves the handles ONCE and
 * every click re-renders the list, so the fourth handle is detached before it is
 * used. The first version of this waited 30s for `.nth(7)` of a list that had
 * shrunk to two.
 */
async function clearChips(page: Page, field: string) {
  const chips = page.getByTestId(`${field}-chips`).getByRole("button");
  // Wait for the list to be POPULATED before emptying it. `count()` is an
  // instant read, so a loop that starts with zero exits immediately and reports
  // success on a list it never touched — the vacuous-guard shape (matrix rows
  // 92, 130, 163, 165) arriving as a test helper.
  await expect.poll(async () => chips.count(), { timeout: 15_000 }).toBeGreaterThan(0);
  for (let guard = 0; guard < 80; guard += 1) {
    if ((await chips.count()) === 0) return;
    await chips.first().click();
  }
  throw new Error(`${field} still has chips after 80 removals`);
}

/** Type one chip into a list and commit it with Enter. */
async function addChip(page: Page, field: string, value: string) {
  await page.locator(`#${field}-input`).fill(value);
  await page.locator(`#${field}-input`).press("Enter");
  await expect(page.getByTestId(`${field}-chips`)).toContainText(value);
}

/** Run the dry run and wait for numbers, not for a spinner to go away. */
async function check(page: Page) {
  await page.getByTestId("check-button").click();
  // 15s: the budget every awaited server write in this suite gets.
  await expect(page.getByTestId("preview-panel")).toBeVisible({ timeout: 15_000 });
}

test("the profile renders what is saved, not empty fields", async ({ page }) => {
  await isolate(page, "render");
  await gotoSettings(page);
  await expect(page.getByRole("heading", { name: "Search profile" })).toBeVisible();
  // The demo profile is Salman's, from users/salman/profile.yaml. A page that
  // opened on blank chips could not show somebody what they already chose.
  await expect(page.getByTestId("titles_include-chips")).toContainText("product manager");
  await expect(page.getByTestId("countries-chips")).toContainText("United States");
  expect(await page.locator("[data-onboarded]").getAttribute("data-onboarded")).toBe("yes");
});

test("a dry run states its numbers and writes nothing", async ({ page }) => {
  await isolate(page, "dry-run");
  await gotoSettings(page);
  const before = await versionOnce(page);

  await check(page);
  await expect(page.getByTestId("preview-panel")).toContainText(/would have\s+qualified/i);

  // The whole claim: a preview is not a write. Reload and read the SERVER's
  // token again — the demo store is per-cookie and survives the navigation, so
  // a token that moved would mean the "dry run" wrote.
  await page.reload();
  expect(await version(page)).toBe(before);
});

test("saving lands, survives a reload, and says what it changed", async ({ page }) => {
  await isolate(page, "save");
  await gotoSettings(page);
  const before = await versionOnce(page);

  // Narrow to a metro almost nothing in the fixture set is in. This both
  // changes the profile and re-gates rows, so the banner has something to say.
  await addChip(page, "metros", "Miami");

  await check(page);
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("commit-banner")).toBeVisible({ timeout: 15_000 });

  // The server's token moved…
  await expect
    .poll(async () => version(page), { timeout: 15_000 })
    .not.toBe(before);

  // …and the value is there after a reload, which is the half that would
  // otherwise pass against a store nothing else reads.
  await page.reload();
  await expect(page.getByTestId("metros-chips")).toContainText("Miami");
});

test("changing a setting after a check says the numbers are stale", async ({ page }) => {
  await isolate(page, "stale");
  await gotoSettings(page);
  await check(page);
  await expect(page.getByTestId("preview-stale")).toHaveCount(0);

  await page.locator("#yoe_max").fill("12");
  await page.locator("#yoe_max").blur();

  // Matrix row 95. The number is still on screen and it is now labelled as
  // belonging to settings that have changed — a stale number that looks
  // current is worse than no number.
  await expect(page.getByTestId("preview-stale")).toBeVisible();
  await expect(page.getByTestId("check-button")).toContainText(/check what/i);
});

test("save is refused until the settings have been checked at least once", async ({ page }) => {
  await isolate(page, "gate");
  await gotoSettings(page);
  // The one thing this surface will not do: commit a profile nobody has seen
  // the consequences of. Silent starvation is the failure the phase exists for.
  await expect(page.getByTestId("save-button")).toBeDisabled();
  await check(page);
  await expect(page.getByTestId("save-button")).toBeEnabled();
});

test("a zero-result profile names the setting that caused it", async ({ page }) => {
  await isolate(page, "zero");
  await gotoSettings(page);

  // A floor nothing clears, plus "filter unstated pay" so the rows that publish
  // nothing cannot slip through either.
  //
  // NOT a nonsense country, which was the first attempt: a blank-country remote
  // posting bypasses the geo gate entirely and by design (that is G17's converse
  // — a remote role with no stated origin is worth a look), so the corpus's
  // remote rows kept qualifying and the number never reached zero. The test was
  // wrong about the product, and the product is right.
  await page.locator("#comp_min").fill("2000");
  await page.locator("#comp_min").blur();
  // Scoped to the section: "Filter it out" is also the geo policy's wording, and
  // an unscoped role query matches both radios.
  await page.locator("#compMin").getByRole("radio", { name: "Filter it out" }).check();

  await check(page);
  await expect(page.locator("[data-qualified='0']")).toBeVisible();
  // "Save anyway" rather than a blocked button: this may be exactly what
  // somebody meant, and refusing it would be the app arguing with its user.
  await expect(page.getByTestId("save-button")).toContainText("Save anyway");

  const link = page.getByTestId("binding-link");
  await expect(link).toBeVisible();
  expect(await link.getAttribute("data-setting")).toBe("compMin");

  // …and it LANDS. A named constraint whose link goes nowhere is the same dead
  // end as the bare empty state it replaced (matrix row 84).
  await link.click();
  await expect(page.locator("#compMin-heading")).toBeFocused();
});

test("a metro the sweep has never heard of says so", async ({ page }) => {
  // `unknownMetros` was exported, documented and called by NOTHING: its doc
  // comment promised this warning and no screen rendered it. A metro the engine
  // cannot produce matches nothing at all — `dispose` compares `geo.metro`
  // against the list with `==` — so a typo is a filter that silently removes
  // every posting, which is this phase's own failure mode arriving through a
  // text field.
  await isolate(page, "unknown-metro");
  await gotoSettings(page);
  await expect(page.getByTestId("unknown-metros-warning")).toHaveCount(0);

  await addChip(page, "metros", "Chicagoland");
  await expect(page.getByTestId("unknown-metros-warning")).toContainText("Chicagoland");

  // …and a real metro does not trip it, so the warning cannot be a constant.
  await clearChips(page, "metros");
  await addChip(page, "metros", "Chicago");
  await expect(page.getByTestId("unknown-metros-warning")).toHaveCount(0);
});

test("a role family the engine never sweeps for is reported separately", async ({ page }) => {
  await isolate(page, "coverage");
  await gotoSettings(page);

  // Dad's real situation. Swap the PM titles for FP&A ones: the fixture corpus
  // carries three of 138, under the 5% floor.
  await clearChips(page, "titles_include");
  // The empty state on the way through is its own message, and a different one —
  // asserted here so the two cannot silently collapse back into one.
  await check(page);
  const empty = page.getByTestId("title-coverage-warning");
  await expect(empty).toHaveAttribute("data-coverage", "no-titles");
  // The COPY, not only the attribute: a mutant collapsing the two branches into
  // one left the attribute correct and the sentence wrong, which is the half a
  // person actually reads.
  await expect(empty).toContainText(/haven.t listed any job titles/i);
  await expect(empty).not.toContainText(/not a verdict/i);
  await addChip(page, "titles_include", "financial analyst");

  await check(page);
  // The number the gate produces is NOT the story here, and the panel says so
  // rather than letting the profile take the blame (matrix row 80).
  const warning = page.getByTestId("title-coverage-warning");
  await expect(warning).toBeVisible();
  // `engine-behind`, not `no-titles`: the titles ARE set and the universe has
  // almost none of them. One is fixed by typing and the other by waiting, and
  // the panel said the wrong one until a recorded baseline showed it.
  await expect(warning).toHaveAttribute("data-coverage", "engine-behind");
  await expect(warning).toContainText(/not a verdict/i);
});

test("double-clicking Save leaves one change and no error", async ({ page }) => {
  await isolate(page, "double");
  await gotoSettings(page);
  const before = await versionOnce(page);

  // A change that really moves rows, so the RESULT is observable rather than
  // just the version token. Narrowing to a metro nothing is in restamps a
  // handful of untriaged postings; the count is what tells one applied commit
  // from two.
  await addChip(page, "metros", "Miami");
  await check(page);

  // Both clicks in ONE JavaScript task, which is what a double-submit actually
  // is. Two awaited Playwright clicks are serialised and the demo store answers
  // between them, so the first gesture has already settled and rotated its key —
  // that is two deliberate saves, not a double-tap, and it proved nothing (the
  // first version of this test failed for exactly that reason). Driving both
  // through one `evaluate` means neither handler has seen the other's state
  // update, so both carry the SAME idempotency key and the second must replay.
  await page.evaluate(() => {
    const b = document.querySelector<HTMLButtonElement>('[data-testid="save-button"]');
    b?.click();
    b?.click();
  });
  await expect(page.getByTestId("commit-banner")).toBeVisible({ timeout: 15_000 });

  await expect.poll(async () => version(page), { timeout: 15_000 }).not.toBe(before);

  // What this test can honestly claim, and what it cannot.
  //
  // CAN: the double-submit lands one visible change and no failure toast. That
  // is the user-facing promise, and a surface that red-toasted its own second
  // click would be a real defect.
  //
  // CANNOT: that the IDEMPOTENCY KEY is what prevents the second application.
  // A mutant rotating the key per attempt passed this file twice, and the
  // reason is worth keeping: with a non-null `expectedUpdatedAt`, the first
  // commit moves the version token, so a second gesture carrying the old one
  // CONFLICTS — the row-90 mechanism catches it before the row-89 mechanism is
  // reached. The idempotency claim is only falsifiable where the two can be
  // separated, and it is asserted there instead: `tests/db/test_profile.py`
  // replays one key and counts exactly one `profile.changed` event, and
  // `regate.test.ts` replays one against the fake. Matrix row 128's rule —
  // when a mutant survives, the test is the thing that was wrong.
  const banner = page.getByTestId("commit-banner");
  await expect(banner).toHaveAttribute("data-restamped", /^[1-9]/);
  await expect(page.getByText(/couldn.t save|try again/i)).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("metros-chips")).toContainText("Miami");
});
