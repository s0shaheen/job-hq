import { expect, test } from "@playwright/test";

/** Pin the clock so relative dates — and therefore snapshots — never drift. */
const FIXTURE_NOW = new Date("2026-07-21T15:00:00.000Z");

test.beforeEach(async ({ page, context }) => {
  await page.clock.setFixedTime(FIXTURE_NOW);
  // Each test gets its own demo store, so draining the queue in one test
  // cannot empty it for another running in parallel.
  await context.addCookies([
    {
      name: "hq_demo_id",
      value: `t-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      url: "http://127.0.0.1:3210",
    },
  ]);
});

/**
 * Navigate and wait until the queue is genuinely interactive.
 *
 * `goto` resolves when the server HTML has painted, which is BEFORE the
 * keydown listener exists. Pressing a key in that window does nothing, and the
 * test fails intermittently on whichever machine is slowest that day — which
 * is exactly how this surfaced (green on a Mac, red on a CI runner). Waiting
 * on the app's own readiness flag removes the race instead of hiding it behind
 * a sleep.
 */
async function gotoQueue(page: import("@playwright/test").Page) {
  await page.goto("/queue");
  await expect(page.locator('[data-testid="triage"][data-ready="true"]')).toBeAttached();
}

test("the decision facts are visible without any interaction", async ({ page }) => {
  // This is the whole point of the surface: half of the owner's shortlisted
  // roles were abandoned because pay/YoE/location were not read. If any of
  // these needs a click, the design has regressed.
  //
  // The uppercase micro-labels the retired card put over each fact ("COMP",
  // "MIN YOE") are banned (01 §3), so the assertion is on the VALUES holding
  // their slots. Every segment is present on every row — an unstated one reads
  // "Not listed" rather than collapsing, which is the next test.
  await gotoQueue(page);
  const row = page.getByTestId("decision-row").first();
  await expect(row).toBeVisible();
  for (const fact of ["fact-pay", "fact-years", "fact-place"]) {
    await expect(row.getByTestId(fact)).toBeVisible();
    await expect(row.getByTestId(fact)).not.toHaveText("");
  }
});

test("an unstated value reads 'Not listed' rather than being hidden", async ({ page }) => {
  await gotoQueue(page);
  // The whole list is on screen now, so no walking: one of the rendered rows
  // carries the no-compensation fixture, and the claim is that its pay slot
  // says so rather than going blank.
  const notListed = page.getByTestId("fact-pay").filter({ hasText: "Not listed" });
  await expect(notListed.first()).toBeVisible();
});

/**
 * The mismatch chip is NOT asserted here, and the reason is a data gap rather
 * than an oversight.
 *
 * The owner's composition puts "Asks for 6+ years; your profile says 4" on a
 * QUEUED row. Nothing can reach this surface carrying that: the gate already
 * disposes a posting whose `min_yoe` exceeds the profile's limit
 * (`yoe:6>4` → filtered), so by the time a row is in the queue it has passed
 * the same rule the chip would report. The limit the row is checked against is
 * hardcoded `4` in `page.tsx`, which is the gate's number wearing a second
 * hat.
 *
 * Rendering it therefore needs a profile limit that ADVISES rather than gates —
 * the search profile's own YoE preference, which arrives with E5. The chip is
 * built and its rendering is proven in `tests/unit/decision-row.test.tsx`; what
 * is missing is a route that can produce one, and inventing a fixture that the
 * engine would have filtered would be asserting a state the product cannot
 * reach. Recorded in the PR's design-gap list (Today handoff §6 Q4).
 */


test("the fact line's posted age is relative, and survives hydration unchanged", async ({
  page,
}) => {
  /**
   * Two claims the unit tests cannot make.
   *
   * FIRST, the relative branch renders at all. It did not: the fixture set is
   * dated relative to FIXTURE_NOW and `queue/page.tsx` was reading the real
   * wall clock, so every row was weeks old and fell through to the absolute
   * "Jul 19" branch — the composition's relative age was never on screen and no
   * browser test ever exercised the code path.
   *
   * SECOND, the server and the client agree. `postedAge` used to derive the
   * current calendar day from a timestamp with `getFullYear/getMonth/getDate`,
   * which reads the server's zone during SSR and the user's after hydration; at
   * 02:00Z those are different days, so the text changed under the reader. Both
   * arguments are date STRINGS now, so there is nothing left to interpret.
   *
   * The assertion is on the SERVER HTML and then on the hydrated DOM, and a
   * React hydration warning fails the test — a silent text swap is exactly what
   * this is about, and it is only ever visible in a console.
   */
  const problems: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (/hydrat|did not match|server-rendered HTML/i.test(text)) problems.push(text);
  });

  await page.goto("/queue");

  // Before hydration: what the SERVER wrote.
  const serverAges = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="fact-age"]')].map((e) => e.textContent),
  );
  expect(serverAges.length, "no row rendered a posted age").toBeGreaterThan(0);
  expect(
    serverAges.some((a) => a && /^(Today|\d+d ago)$/.test(a)),
    `no row took the relative branch; ages were ${JSON.stringify(serverAges)}`,
  ).toBe(true);

  await expect(page.locator('[data-testid="triage"][data-ready="true"]')).toBeAttached();

  // After hydration: byte-identical, in the same order.
  const clientAges = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="fact-age"]')].map((e) => e.textContent),
  );
  expect(clientAges).toEqual(serverAges);
  expect(problems, `React reported a hydration problem: ${problems.join(" | ")}`).toEqual([]);
});

test("keyboard triage advances the queue and can be undone", async ({ page }) => {
  await gotoQueue(page);
  const first = await page.getByTestId("row-title").first().innerText();

  await page.keyboard.press("i");
  // 02 §6's exact string for a single row. Undo is the toast's own action,
  // never glued into the message.
  await expect(page.getByText("Marked interested", { exact: true })).toBeVisible();
  await expect(page.getByTestId("row-title").first()).not.toHaveText(first);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("row-title").first()).toHaveText(first);
});

test("passing on a role removes it and the section count follows", async ({ page }) => {
  // 01 §2 #8: the count states what is there. The section header is the ONLY
  // place Today states it, so a row leaving and the header not moving is the
  // count lying.
  await gotoQueue(page);
  const rows = page.getByTestId("decision-row");
  const before = await rows.count();
  await expect(page.getByRole("heading", { name: `New roles (${before})` })).toBeVisible();

  await page.getByTestId("pass").click();
  await expect(rows).toHaveCount(before - 1);
  await expect(page.getByRole("heading", { name: `New roles (${before - 1})` })).toBeVisible();
});

test("the row's actions are reachable by keyboard, not only by hover", async ({ page }) => {
  /**
   * The seed reveals the three buttons with `hidden group-hover:flex
   * group-focus-within:flex`, and `display:none` removes a control from the
   * accessibility tree: focus cannot land on it, so `group-focus-within` can
   * never fire and a keyboard-only user has no way to reveal it at all. The
   * port uses `sr-only` + `not-sr-only`, which keeps the buttons focusable.
   *
   * MUTATION: put `hidden group-hover:flex group-focus-within:flex` back in
   * `components/ds/decision-row.tsx` and the focus below never reaches a
   * button — `count` stays 0 and this fails. The unit suite cannot see it:
   * jsdom loads no stylesheet, so both class strings behave identically there.
   */
  await gotoQueue(page);
  // The SECOND row, so the assertion is not about the cursor row, whose actions
  // are painted anyway.
  const second = page.getByTestId("decision-row").nth(1);
  await second.getByRole("checkbox").focus();

  let reached: string | null = null;
  for (let i = 0; i < 6 && reached === null; i++) {
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el?.tagName === "BUTTON" ? (el.getAttribute("aria-label") ?? "") : null;
    });
    if (active?.startsWith("Interested:")) reached = active;
  }
  expect(reached, "Tab never reached a row action").not.toBeNull();

  // And reaching it is what paints it: a focused control the user cannot see
  // is its own failure.
  await expect(second.getByRole("button", { name: /^Interested:/ })).toBeInViewport();
  const box = await second.getByRole("button", { name: /^Interested:/ }).boundingBox();
  expect(box!.width, "the focused action is still clipped to sr-only").toBeGreaterThan(20);
});

test("the j/k cursor moves and the row it lands on is the one a key decides", async ({ page }) => {
  await gotoQueue(page);
  const rows = page.getByTestId("decision-row");
  await expect(rows.nth(0)).toHaveAttribute("data-cursor", "true");

  await page.keyboard.press("j");
  await expect(rows.nth(1)).toHaveAttribute("data-cursor", "true");
  await expect(rows.nth(0)).toHaveAttribute("data-cursor", "false");

  const second = await rows.nth(1).getByTestId("row-title").innerText();
  await page.keyboard.press("x");
  // The row under the cursor left; the one above it did not.
  await expect(page.getByTestId("row-title").filter({ hasText: second })).toHaveCount(0);
});

test("selecting rows raises a bar that states its count, and one gesture decides them all", async ({
  page,
}) => {
  await gotoQueue(page);
  const rows = page.getByTestId("decision-row");
  const before = await rows.count();

  await rows.nth(0).getByRole("checkbox").check();
  await rows.nth(2).getByRole("checkbox").check();

  const bar = page.getByTestId("selection-bar");
  await expect(bar).toBeVisible();
  // The count on a control equals the count it acts on (02 §8).
  await expect(bar).toContainText("2 selected");
  await expect(bar.getByRole("button", { name: "Pass 2" })).toBeVisible();

  await bar.getByRole("button", { name: "Pass 2" }).click();
  await expect(rows).toHaveCount(before - 2);
  await expect(page.getByText("Passed 2 roles", { exact: true })).toBeVisible();
  await expect(bar).toHaveCount(0);
});

test("a decision made on another device first conflicts the batch: nothing applies, and the newer decision is kept", async ({
  page,
  context,
}) => {
  // Tab A loads the queue and holds (soon to be) stale row versions.
  await gotoQueue(page);
  const rows = page.getByTestId("decision-row");
  const before = await rows.count();
  const titles = [
    await rows.nth(0).getByTestId("row-title").innerText(),
    await rows.nth(1).getByTestId("row-title").innerText(),
  ];

  // Tab B, same store, passes on the first row — tab A's copy of that row is
  // now stale, and the store already holds a decision for it.
  const other = await context.newPage();
  await other.goto("/queue");
  await expect(other.locator('[data-testid="triage"][data-ready="true"]')).toBeAttached();
  await other.getByTestId("pass").click();
  await expect(other.getByText("Passed", { exact: true })).toBeVisible();

  // Tab A: one batch over the stale row and a clean one.
  await rows.nth(0).getByRole("checkbox").check();
  await rows.nth(1).getByRole("checkbox").check();
  const bar = page.getByTestId("selection-bar");
  await bar.getByRole("button", { name: "Interested 2" }).click();

  await expect(page.getByText(/changed on another device/i)).toBeVisible();

  // Full revert: BOTH rows are still on screen as undecided — including the
  // clean one that would have succeeded alone, because the store applied
  // nothing — and the selection came back with them.
  await expect(rows).toHaveCount(before);
  await expect(rows.nth(0).getByTestId("row-title")).toHaveText(titles[0]);
  await expect(rows.nth(1).getByTestId("row-title")).toHaveText(titles[1]);
  await expect(bar).toContainText("2 selected");

  // No Undo: nothing was applied, so there is nothing to undo. Offering one
  // would promise an inverse for a write that never happened.
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);

  // The STORE proves atomicity: a fresh read holds ONLY tab B's pass. Tab A's
  // interested batch applied to neither row — the stale one still shows the
  // other device's decision (it left the queue), the clean one is undecided.
  const check = await context.newPage();
  await check.goto("/queue");
  await expect(check.locator('[data-testid="triage"][data-ready="true"]')).toBeAttached();
  const checkRows = check.getByTestId("decision-row");
  await expect(checkRows).toHaveCount(before - 1);
  await expect(checkRows.first().getByTestId("row-title")).toHaveText(titles[1]);
});

test("shift-click selects the range between the two rows clicked", async ({ page }) => {
  await gotoQueue(page);
  const rows = page.getByTestId("decision-row");

  await rows.nth(0).getByRole("checkbox").click();
  await rows.nth(3).getByRole("checkbox").click({ modifiers: ["Shift"] });

  await expect(page.getByTestId("selection-bar")).toContainText("4 selected");
  for (let i = 0; i <= 3; i++) {
    await expect(rows.nth(i)).toHaveAttribute("data-selected", "true");
  }
});

test("a row's own button decides that row, even while other rows are selected", async ({
  page,
}, testInfo) => {
  // Desktop only, and the reason is a finding rather than a convenience.
  //
  // A non-cursor row reveals its three actions on HOVER, and hover is not a
  // gesture a touch device makes — so on the Pixel 7 project those buttons
  // cannot be reached at all. Measured while writing this: at that viewport the
  // third row's checkbox sits at y=1110 on a 915px screen, and the fixed
  // SelectionBar owns the bottom of the viewport once a selection exists, so
  // even reaching the CHECKBOX takes a scroll into ground the bar covers.
  //
  // 04 §2 says the actions "collapse to an overflow menu plus keys" at narrow
  // widths. That menu is unbuilt, so this claim is asserted where the
  // affordance exists and the phone's version of it is ADD-018.
  // Closing ADD-018 means DELETING this skip, not baselining it — the
  // addendum states that in its acceptance criteria.
  test.skip(testInfo.project.name === "mobile", "hover-revealed affordance; see ADD-018");
  /**
   * 02 §8 as a correctness rule: the count on a control equals the count it
   * acts on.
   *
   * The bug this pins shipped in the first cut of Today. Every row button went
   * through a helper that returned the SELECTION whenever one existed, so with
   * rows 1-3 checked, clicking the button named `Interested: Vanta, …` wrote
   * rows 1-3, left Vanta undecided, and raised a toast saying "Marked 3 roles
   * interested". The control's name, its position and its effect all disagreed,
   * while the SelectionBar two inches away was getting it right.
   *
   * MUTATION: route `onPass` back through the selection-aware helper and the
   * `toHaveCount` below fails — the three selected rows leave instead of the
   * one whose button was clicked.
   */
  await gotoQueue(page);
  const rows = page.getByTestId("decision-row");
  const before = await rows.count();

  // Select three rows, then act on a DIFFERENT one.
  for (const i of [0, 1, 2]) await rows.nth(i).getByRole("checkbox").check();
  await expect(page.getByTestId("selection-bar")).toContainText("3 selected");

  const target = rows.nth(5);
  const targetTitle = await target.getByTestId("row-title").innerText();
  const selectedTitles = await Promise.all(
    [0, 1, 2].map((i) => rows.nth(i).getByTestId("row-title").innerText()),
  );

  /**
   * FOCUS, not hover, and that is a fix rather than a preference.
   *
   * A non-cursor row's actions are `sr-only` until the pointer or focus reaches
   * the row, so the button is a 1px clip box until then. Hovering first worked
   * locally and failed on CI both times it ran: Playwright scrolls the target
   * into view before clicking, the pointer stops being over the row when it
   * moves, the button collapses back to 1px, and the click lands on the row
   * behind it — no error, nothing decided, `toHaveCount` sees 8 rows instead of
   * 7.
   *
   * Focus does not evaporate when the page scrolls. `group-focus-within` is the
   * same rule that makes these buttons keyboard-reachable at all, so this is
   * also the path a keyboard user takes.
   */
  const pass = target.getByRole("button", { name: /^Pass:/ });
  await pass.focus();
  await pass.click();

  // Exactly one row left, and it is the one whose button was clicked.
  await expect(rows).toHaveCount(before - 1);
  await expect(page.getByTestId("row-title").filter({ hasText: targetTitle })).toHaveCount(0);
  for (const title of selectedTitles) {
    await expect(page.getByTestId("row-title").filter({ hasText: title })).toHaveCount(1);
  }

  // The toast states one row, not three.
  await expect(page.getByText("Passed", { exact: true })).toBeVisible();

  // And the selection is untouched — deciding an unrelated row is not a reason
  // to throw away rows the user deliberately picked.
  await expect(page.getByTestId("selection-bar")).toContainText("3 selected");
});

test("a logo host that never answers degrades to the monogram, not a broken image", async ({
  page,
}) => {
  /**
   * The bottom rung of the logo ladder (01 §7), on a rendered page rather than
   * in a unit test — a unit test cannot see an `onError` that never fires, an
   * `<img>` that resolves to the browser's broken-image glyph, or a row whose
   * height changes when the logo gives up.
   *
   * Aborted rather than stubbed with a 404: an abort is the shape of the real
   * failure (DNS, an offline machine, a blocked third party).
   *
   * The monogram is checked for BOTH things it has to be. It has to be there,
   * and it has to be silent: it is real text, so without an `aria-hidden`
   * wrapper every row announces "R A Ramp" — the defect the Jobs cutover
   * shipped and then fixed. MUTATION: drop `aria-hidden` from LogoAvatar's
   * wrapper and the second half of this fails while the first still passes.
   */
  await page.route(/logo\.dev|google\.com\/s2\/favicons/, (route) => route.abort());
  await gotoQueue(page);

  const row = page.getByTestId("decision-row").first();
  await expect(row).toBeVisible();
  const company = (await row.getByTestId("row-company").innerText()).trim();
  const initials = company.slice(0, 2).toUpperCase();

  const avatar = row.getByText(initials, { exact: true });
  await expect(avatar).toBeVisible();
  // The ladder ran off its end rather than parking on a src that will never
  // paint, which is what shows the broken-image glyph.
  await expect(row.locator("img")).toHaveCount(0);

  // The fallback keeps the 20px box the image had, so nothing above or below
  // it moved. Measured on the WRAPPER, which is what holds the row's rhythm —
  // the letters inside it are a 16px line box either way.
  const box = await avatar.locator("xpath=..").boundingBox();
  expect(Math.round(box!.height)).toBe(20);
  expect(Math.round(box!.width)).toBe(20);

  const hidden = await avatar.evaluate((el) => {
    // Walk UP from the monogram itself. `aria-hidden` anywhere on the ancestor
    // chain removes it from the tree; asserting that the row merely contains
    // some aria-hidden element would pass on the checkbox's visual proxy and
    // say nothing about the letters.
    for (let n: Element | null = el; n; n = n.parentElement) {
      const a = n.getAttribute("aria-hidden");
      if (a === "true" || a === "") return true;
    }
    return false;
  });
  expect(hidden, "the monogram must sit inside an aria-hidden wrapper").toBe(true);
});

test("the queue reaches a finished state rather than trailing off", async ({ page }) => {
  await gotoQueue(page);
  const empty = page.getByTestId("empty-state");
  for (let i = 0; i < 25; i++) {
    if (await empty.isVisible().catch(() => false)) break;
    await page.keyboard.press("x");
    await page.waitForTimeout(90);
  }
  // The FINISHED template (02 §7), which is a factual state and not a
  // celebration: what happened, then what happens next.
  await expect(empty).toContainText("You're done for today.");
  await expect(empty).toContainText("New roles arrive with the next scan.");
});
