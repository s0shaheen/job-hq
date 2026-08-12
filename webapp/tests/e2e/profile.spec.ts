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

/**
 * Preferences is its OWN route now (`Settings.dc.html`'s section rail), so the
 * display knobs are no longer on the same page as the profile form. Same rule,
 * same reason, different flag: `data-hydrated` on the preferences control.
 *
 * `toBeVisible` is NOT enough and this branch measured why. A `select` rendered
 * by the server is visible and enabled before React attaches anything, and
 * `selectOption` into that gap moves the DOM value and fires a change event
 * nothing is listening for — so the option looks chosen, no write is sent, and
 * the failure surfaces 15 seconds later as an attribute that never arrived. The
 * two-knob test passed alone and failed under parallel load on exactly that.
 */
async function gotoPreferences(page: Page) {
  await page.goto("/settings/preferences");
  await expect(page.getByTestId("preferences-form")).toHaveAttribute("data-hydrated", "true");
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
  // The page title is "Settings" and this section's title is "Profile & search"
  // — the rail's first entry, which lives at `/settings` itself so the six
  // `reasonSetting()` deep links keep landing on a page that carries them.
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Profile & search" })).toBeVisible();
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
  // DOLLARS, not thousands. The field used to be labelled "Minimum, in
  // thousands" with a maximum of 2000, and the owner read that as a $2,000
  // ceiling on his first run — which is what it said. Typing the number a
  // salary is written with is now the whole interaction.
  await page.locator("#comp_min").fill("2000000");
  await page.locator("#comp_min").blur();
  // …and it comes back formatted, which is how a mistyped magnitude is visible.
  await expect(page.locator("#comp_min")).toHaveValue("$2,000,000");
  // Scoped to the section: "Skip them" is also the geo policy's wording, and an
  // unscoped role query matches both radios.
  await page.locator("#compMin").getByRole("radio", { name: "Skip them" }).check();

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
  await expect(empty).toContainText(/not listed any job titles/i);
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

test("a save with a stale token yields to the other device and shows its write", async ({
  page,
  context,
}) => {
  // The conflict branch, driven the only way it happens: two tabs sharing ONE
  // demo store. The second page is opened in the SAME context on purpose — a
  // per-page `hq_demo_id` would give each tab its own store and make the
  // conflict unreachable, which is the isolation trap, not the isolation rule.
  await isolate(page, "conflict");
  await gotoSettings(page);
  const before = await versionOnce(page);

  // The other tab saves first, moving the server's token…
  const other = await context.newPage();
  await gotoSettings(other);
  await addChip(other, "metros", "Miami");
  await check(other);
  await other.getByTestId("save-button").click();
  await expect(other.getByTestId("commit-banner")).toBeVisible({ timeout: 15_000 });
  // POLLED, not sampled: the banner is client state and arrives before the
  // router.refresh() that re-renders the server's token, so an instant read
  // here races the refresh and loses on a slow worker.
  await expect.poll(async () => version(other), { timeout: 15_000 }).not.toBe(before);
  const theirs = await version(other);
  await other.close();

  // …and this tab, still holding the old token, tries to land its own change.
  await addChip(page, "metros", "Boston");
  await check(page);
  await page.getByTestId("save-button").click();

  await expect(
    page.getByText("Your profile changed on another device. Showing the latest."),
  ).toBeVisible({ timeout: 15_000 });

  // The FIELDS after the refresh, not just the toast: a toast beside stale
  // fields is matrix row 113. The version token becomes the OTHER tab's, and
  // the chips show its write rather than this tab's losing draft.
  await expect.poll(async () => version(page), { timeout: 15_000 }).toBe(theirs);
  await expect(page.getByTestId("metros-chips")).toContainText("Miami");
  await expect(page.getByTestId("metros-chips")).not.toContainText("Boston");
});

test("an expired session refuses the save, keeps the form usable, and queues nothing", async ({
  page,
}) => {
  await isolate(page, "expired");
  await gotoSettings(page);
  const before = await versionOnce(page);

  await addChip(page, "metros", "Miami");
  await check(page);

  // The session expires BETWEEN the check and the save — the cookie arms the
  // auth branch of the server action, exactly as `entry-path.spec.ts` uses it.
  await page
    .context()
    .addCookies([{ name: "hq_demo_session", value: "expired", url: ORIGIN }]);
  await page.getByTestId("save-button").click();

  await expect(page.getByText("Your session expired. Sign in and try again.")).toBeVisible({
    timeout: 15_000,
  });
  // Usable, not wedged — and nothing landed: no banner, and the token this
  // page holds is still the one it read before the refusal.
  await expect(page.getByTestId("save-button")).toBeEnabled();
  await expect(page.getByTestId("check-button")).toBeEnabled();
  await expect(page.getByTestId("commit-banner")).toHaveCount(0);
  expect(await version(page)).toBe(before);

  // Signed back in, the same gesture lands — which is also the proof nothing
  // was queued: ONE application arrives, from this press, not a replay plus it.
  await page.context().clearCookies({ name: "hq_demo_session" });
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("commit-banner")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => version(page), { timeout: 15_000 }).not.toBe(before);

  await page.reload();
  await expect(page.getByTestId("profile-form")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByTestId("metros-chips")).toContainText("Miami");
});

/**
 * A store nothing has touched, even when the dev server outlives the test run.
 *
 * `isolate` keys the demo store by a STABLE id, which is right for every test
 * above: they assert on an end state, so re-running against a store their last
 * run mutated still means what it says. The three display-preference cases below
 * assert on a STARTING state ("large type is off, now turn it on"), and
 * `globalThis.__hqDemoStores` survives between runs against a reused server — so
 * the second run of the suite would start with the preference already set and
 * the precondition would fail for a reason that has nothing to do with the code.
 * A per-run suffix buys a genuinely untouched store; the map is bounded, so
 * nothing accumulates.
 */
async function isolateFresh(page: Page, id: string) {
  await isolate(page, `${id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
}

/**
 * Wait until the toggle's reload has LANDED and the page is interactive again.
 *
 * Two waits, and skipping either is a real flake rather than belt-and-braces.
 * The attribute is server HTML, so it is true the moment the new document
 * arrives — before React has attached a single handler. A gesture in that gap
 * fires into nothing, which is the exact lesson `gotoSettings` was written for;
 * under parallel load it cost this file two failures and no error anywhere.
 */
async function displaySettled(page: Page, attr: string, value: string) {
  await expect(page.locator("html")).toHaveAttribute(attr, value, { timeout: 15_000 });
  // The second wait is on the PREFERENCES control now, not on the profile form:
  // the section rail moved the display knobs to `/settings/preferences`, so the
  // profile form is not on this page at all and waiting for it would time out
  // for a reason that has nothing to do with what settled. The property is
  // unchanged — the reloaded document is interactive again — and the element
  // that carries it is the one that will receive the next gesture.
  await expect(page.getByTestId("preferences-form")).toHaveAttribute("data-hydrated", "true");
}

// ------------------------------------------------------ display preferences

test("a display preference autosaves, survives a reload, and reaches every surface", async ({
  page,
}) => {
  // The E5 round trip end to end: a gesture on /settings writes `profiles`, and
  // the ROOT layout renders the result as an `<html>` attribute — on the server,
  // which is what removes the flash the retired `hq_display` cookie existed to
  // prevent while adding the thing that cookie could never do (following the
  // person to their phone).
  //
  // Worth an E2E rather than a unit test for two reasons neither layer covers:
  // the write is AUTOSAVED, so there is no Save button to assert against and
  // "landed" can only mean the server answers differently afterwards; and the
  // attribute is set by a DIFFERENT layout from the page that wrote it.
  await isolateFresh(page, "display-prefs");
  await gotoPreferences(page);

  await expect(page.locator("html")).not.toHaveAttribute("data-type-scale", "large");
  await page.getByTestId("prefs-type-scale").selectOption("large");

  // The control reloads once the server confirms — preferences-form.tsx states
  // why a reload rather than a re-render, for the three knobs the document
  // itself is rendered against. Waiting on the ATTRIBUTE rather than on the
  // select is the point: the select is client state and would move the instant
  // it was changed, whether or not anything was stored.
  await displaySettled(page, "data-type-scale", "large");
  await expect(page.getByTestId("prefs-type-scale")).toHaveValue("large");

  // A hard reload, because the assertion this suite once lacked everywhere is
  // "did it actually persist" — a write into a store nothing else reads passes
  // every check made straight after the gesture.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-type-scale", "large");

  // And on a surface that never mentions display preferences, which is the
  // "per-user, everywhere" claim rather than the "this page remembers" one.
  await page.goto("/pipeline");
  await expect(page.locator("html")).toHaveAttribute("data-type-scale", "large");
});

test("turning one knob does not revert the other", async ({ page }) => {
  // The reason every value in `SetDisplayPrefsInput` is optional. A control that
  // sent all five would replay whatever it last READ into the other four, so the
  // second gesture would quietly undo the first — and both selects would still
  // LOOK right until a reload, which is why this asserts after one.
  await isolateFresh(page, "display-both");
  await gotoPreferences(page);

  await page.getByTestId("prefs-type-scale").selectOption("large");
  await displaySettled(page, "data-type-scale", "large");
  await page.getByTestId("prefs-density").selectOption("comfortable");
  await displaySettled(page, "data-density", "comfortable");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-type-scale", "large");
  await expect(page.locator("html")).toHaveAttribute("data-density", "comfortable");
});

test("an autosaved preference does not make the profile form report a conflict", async ({
  page,
  context,
}) => {
  // The bug 0025's trigger clause exists for. `updated_at` is the Search
  // Profile's version token, and 0001 bumped it on every write to the row — so a
  // preference write would have raised "this profile changed since you read it"
  // over a gesture that touched nothing the form edits.
  //
  // DRIVEN ACROSS TWO PAGES, because the section rail moved Preferences to its
  // own route and the two controls are no longer on one screen. That is the
  // STRONGER version of the same claim, not a weaker one: the form here holds a
  // token read before the preference write, keeps a typed draft across it, and
  // must still save. A single-page version could only ever prove the token was
  // untouched in one render.
  await isolateFresh(page, "display-no-conflict");
  await gotoSettings(page);
  const before = await versionOnce(page);

  const prefs = await context.newPage();
  await prefs.goto("/settings/preferences");
  await expect(prefs.getByTestId("preferences-form")).toBeVisible();
  await prefs.getByTestId("prefs-density").selectOption("comfortable");
  await expect(prefs.locator("html")).toHaveAttribute("data-density", "comfortable", {
    timeout: 15_000,
  });
  await prefs.close();

  // The token the form holds is untouched by the preference write — the
  // server-side half of the claim, read off the same attribute every other test
  // in this file waits on, and read WITHOUT reloading, because a reload would
  // fetch a fresh token and prove nothing about the one the form is holding.
  expect(await version(page)).toBe(before);

  await addChip(page, "metros", "Miami");
  await check(page);
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("commit-banner")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/couldn.t save|changed since|try again/i)).toHaveCount(0);
});
