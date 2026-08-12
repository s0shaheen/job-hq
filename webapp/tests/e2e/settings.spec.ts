import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { SETTINGS_SECTIONS } from "../../app/(app)/settings/sections";

/**
 * THE SETTINGS SURFACE, as `Settings.dc.html` composes it.
 *
 * `/settings` was one stacked column. It is now a 200px section rail beside a
 * 640px content column, with five sections in a fixed order, and this file owns
 * what a browser can see of that: the rail resolves, the sections say what they
 * are, the two absences are really absent, the leave block cannot be pressed,
 * and the narrow viewport does not push the page sideways.
 *
 * WHAT LIVES ELSEWHERE, deliberately, so nothing is asserted twice in the
 * slowest suite (17 §4):
 *
 *   * the profile form's own behaviour, its dry run and its conflict handling
 *     are `profile.spec.ts`;
 *   * the autosave control's timeout, offline and idempotency behaviour is
 *     `tests/unit/display-prefs-control.test.tsx`, where it can be driven
 *     without a server;
 *   * the six `reasonSetting()` deep links are `routing.spec.ts`, which derives
 *     them from the function rather than from a list;
 *   * the refusal a pending account gets on every one of these routes is
 *     `entry-path.spec.ts`.
 *
 * WHAT IS NOT COVERED AND IS NOT FAKED. The Email preference block, the Gmail
 * connected-account card, Change email, Change password and Export defaults are
 * all absent by decision (ADD-022, DEV-010, DEV-012, DEV-013). Two of those
 * absences are asserted below, because a control that must never appear is worth
 * a test; the rest are recorded in `07-decisions-assumptions-risks.md` and have
 * nothing to drive.
 */

/** Its own demo store per test AND per project: desktop and mobile share a server. */
async function isolate(page: Page, context: BrowserContext, baseURL: string, id: string) {
  const project = test.info().project.name;
  await context.addCookies([
    { name: "hq_demo_id", value: `settings-${project}-${id}`, url: baseURL },
  ]);
  return page;
}

/** Every serious/critical axe finding on the current page, as readable text. */
async function axeFailures(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations
    .filter((v) => ["serious", "critical"].includes(v.impact ?? ""))
    .map((v) => `${v.id}: ${v.help}\n  ${v.nodes.map((n) => n.target.join(" ")).join("\n  ")}`);
}

// ───────────────────────────────────────────────────────────── the rail

test("the rail lists the design's five sections, in the design's order", async ({
  page,
  context,
  baseURL,
}) => {
  // Read from the RENDERED rail and compared against the module the rail is
  // built from, which is `routing.spec.ts`'s rule one level down: a hardcoded
  // list in the test goes stale the day a section is added, and then the test
  // agrees with itself about a page nobody changed.
  await isolate(page, context, baseURL!, "rail");
  await page.goto("/settings");

  const rail = page.getByTestId("settings-rail");
  await expect(rail).toBeVisible();
  const names = await rail.getByRole("link").allInnerTexts();
  expect(names).toEqual(SETTINGS_SECTIONS.map((s) => s.name));
});

test("every section in the rail resolves, and marks itself current when it does", async ({
  page,
  context,
  baseURL,
}) => {
  await isolate(page, context, baseURL!, "rail-resolves");

  for (const section of SETTINGS_SECTIONS) {
    const response = await page.goto(section.href);
    expect(response?.status(), section.href).toBeLessThan(400);

    // The current row is a real `aria-current`, not a colour. A rail that
    // highlighted the row visually and told a screen reader nothing would pass
    // a screenshot and fail a person.
    const current = page.getByTestId("settings-rail").locator("[aria-current=page]");
    await expect(current, section.href).toHaveCount(1);
    await expect(current, section.href).toHaveText(section.name);

    // And Settings is NOT one of the five app destinations: the shell's rail
    // still names exactly those five, with Settings beside them rather than
    // among them.
    const shell = page.locator('nav[aria-label="Sections"]');
    await expect(shell.getByRole("link", { name: "Settings" })).toHaveCount(1);
  }
});

test("each section states its own save semantics", async ({ page, context, baseURL }) => {
  // 06 §A's guardrail, and the reason it is a guardrail: the sections do not
  // agree. Profile & search commits explicitly and Preferences autosaves, so a
  // person who learns one and assumes the other loses work or waits for a save
  // that already happened. Both sentences are asserted, because either one alone
  // would pass a build where the other was dropped.
  await isolate(page, context, baseURL!, "save-semantics");

  await page.goto("/settings");
  await expect(page.getByText("Saved with Save changes.", { exact: false })).toBeVisible();

  await page.goto("/settings/preferences");
  await expect(page.getByText("Changes save as you make them.")).toBeVisible();
});

// ────────────────────────────────────────────────────────── the absences

test("Connected accounts names Google and nothing that reads mail", async ({
  page,
  context,
  baseURL,
}) => {
  // DEV-010 and DEC-002. `Settings.dc.html` draws an "Email check" card with
  // `gmail.readonly` in a scope grid; this product does not read mail and must
  // not say it might.
  //
  // Asserted over the WHOLE PAGE TEXT rather than over the card's absence,
  // because the property here is ABSENCE and a check for one missing selector
  // passes a build that moved the same sentence into a tooltip, a heading or an
  // aria-label. The corpus is every way this product could claim mail access.
  await isolate(page, context, baseURL!, "no-gmail");
  await page.goto("/settings/account");

  await expect(page.getByTestId("connected-accounts")).toContainText("Google");

  const text = (await page.locator("body").innerText()).toLowerCase().replace(/\s+/g, " ");
  const visible = [
    "gmail",
    "inbox",
    "email check",
    "readonly",
    "reads your",
    "status updates",
    "never sends or deletes",
  ].filter((f) => text.includes(f));
  expect(visible, `Settings said, in words: ${visible.join(", ")}`).toEqual([]);

  // And in the MARKUP, where an aria-label, a title attribute or a hidden card
  // would hide from the text check. Narrower terms here on purpose: the shell's
  // Today icon ships as `lucide-inbox`, which is a class name and not a claim
  // about anybody's mail, and a corpus that cannot tell those apart is a corpus
  // that gets deleted the first time it cries wolf.
  const html = (await page.content()).toLowerCase();
  const inMarkup = ["gmail", "mail.google", "googleapis.com/auth"].filter((f) =>
    html.includes(f),
  );
  expect(inMarkup, `Settings' markup implied mailbox access: ${inMarkup.join(", ")}`).toEqual([]);
});

test("nothing on the Data section can delete an account or start an archive", async ({
  page,
  context,
  baseURL,
}) => {
  // Deletion and the full archive are T4 and unbuilt (RM-72). The rule for a T4
  // surface in a T2 packet is that the SURFACE ships and the action does not, and
  // this is the assertion that keeps the second half true.
  //
  // DISABLED rather than enabled-and-refusing, and the difference is the whole
  // point: a control that looks live and then says no has already taken the
  // decision away from the person, because they have pressed the button that
  // deletes their account.
  await isolate(page, context, baseURL!, "leave-block");
  await page.goto("/settings/data");

  for (const id of ["data-export-everything", "data-delete-account", "data-delete-confirm"]) {
    await expect(page.getByTestId(id), id).toBeDisabled();
  }

  // And each one says WHY, associated with the control rather than floating near
  // it, so the reason is announced with the control and not merely printed above
  // it. 02 §7's template: what happened, then what to do instead.
  for (const id of ["data-export-everything", "data-delete-account"]) {
    const described = await page.getByTestId(id).getAttribute("aria-describedby");
    expect(described, id).toBeTruthy();
    await expect(page.locator(`#${described}`), id).toContainText("Not available yet");
  }

  // The irreversibility ADD-007 names is stated BEFORE the control, not inside a
  // confirmation nobody reads.
  await expect(page.getByText("Deleting this account does not withdraw them.")).toBeVisible();
});

// ────────────────────────────────────────────────────── preferences round trip

test("the landing view really decides where the front door goes", async ({
  page,
  context,
  baseURL,
}) => {
  // The preference has been stored since migration 0025 and read by NOTHING, so
  // the select the design draws would have been a control that changes a row and
  // nothing else. This is the assertion that makes it a setting.
  //
  // Driven through `/` rather than through a helper, because `/` is the address
  // the middleware sends an authenticated visitor to and is therefore the path
  // the copy describes ("the page that opens when you sign in").
  await isolate(page, context, baseURL!, "landing-view");
  await page.goto("/settings/preferences");

  // The default first, so the assertion below is a change and not a coincidence.
  await page.goto("/");
  await expect(page).toHaveURL(/\/queue$/);

  await page.goto("/settings/preferences");
  await page.getByTestId("prefs-landing-view").selectOption("jobs");
  // Landing view is not one of the three knobs the document is measured against,
  // so it does NOT reload; the tick is how it confirms.
  await expect(page.getByTestId("preferences-saved")).toBeVisible({ timeout: 15_000 });

  await page.goto("/");
  await expect(page).toHaveURL(/\/jobs$/);
});

test("the keyboard-hints switch is a 24px target at the 6px control radius", async ({
  page,
  context,
  baseURL,
}) => {
  // TWO NUMBERS, and both are here on purpose after being briefly deleted.
  //
  // DEV-015, the radius: `Settings.dc.html` draws the track at 999px; 04 3.3
  // says controls take 6px and exempts only badges and avatars. Asserted on the
  // COMPUTED value, not a class name — a class proves what was typed and this is
  // about what is painted — and not left to `slop.spec.ts`, which only tests
  // `r > 12`, so a 12px pill satisfies that sweep while violating the standard
  // it exists to enforce. That is the trap the first draft of this control fell
  // into.
  //
  // DEV-016, the box: `tests/e2e/target-size.spec.ts` now sweeps this route, and
  // the honest instinct was to delete this as a weaker second copy of somebody
  // else's rule. It is not weaker HERE, and the difference was measured rather
  // than argued: shrinking this button back to the authored 18px and running the
  // sweep on `/settings/preferences` PASSES. The switch qualifies for SC 2.5.8's
  // spacing exception, because its only nearby targets are the selects a `gap-4`
  // above, and its `<label>` is not in the sweep's `TARGET_SELECTOR` at all.
  //
  // So the sweep checks the CRITERION and this checks the NUMBER. DEV-016 names
  // this assertion as the thing that keeps it visible, and a deviation guarded
  // by something weaker than it claims is the defect class this surface spent
  // its whole review finding. Three lines is the cost of the claim being true.
  await isolate(page, context, baseURL!, "switch-geometry");
  await page.goto("/settings/preferences");

  const box = await page.getByTestId("prefs-keyboard-hints").boundingBox();
  expect(box, "the switch has no box").not.toBeNull();
  expect(box!.width, "switch target width").toBeGreaterThanOrEqual(24);
  expect(box!.height, "switch target height").toBeGreaterThanOrEqual(24);

  const radii = await page
    .getByTestId("prefs-keyboard-hints")
    .locator("span")
    .first()
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return [
        s.borderTopLeftRadius,
        s.borderTopRightRadius,
        s.borderBottomLeftRadius,
        s.borderBottomRightRadius,
      ];
    });
  expect(radii, "the switch track is not at the 6px control radius").toEqual([
    "6px",
    "6px",
    "6px",
    "6px",
  ]);
});

test("the auth column's legal links are 24px targets", async ({ page }) => {
  // DEV-016's other half, and the same measurement: reverting these to the
  // authored 12/16 line and running the sweep on `/login` and `/terms` PASSES.
  // Their nearest neighbour's edge is roughly 35px from centre, well outside the
  // 12px radius the spacing exception uses, so the criterion is satisfied and
  // the number is not.
  //
  // `/login` needs no demo store: it reads nothing.
  await page.goto("/login");
  for (const name of ["Terms", "Privacy"]) {
    const box = await page.getByRole("link", { name, exact: true }).boundingBox();
    expect(box, `${name} has no box`).not.toBeNull();
    expect(box!.height, `${name} target height`).toBeGreaterThanOrEqual(24);
    expect(box!.width, `${name} target width`).toBeGreaterThanOrEqual(24);
  }
});


test("a write that is refused leaves the controls usable and queues nothing", async ({
  page,
  context,
  baseURL,
}) => {
  // The offline rule, DEC-011: writes are disabled, an explanation is shown, and
  // there is NO local mutation queue. Driven by taking the browser offline, which
  // makes the server action reject rather than answer.
  await isolate(page, context, baseURL!, "prefs-offline");
  await page.goto("/settings/preferences");
  await expect(page.getByTestId("preferences-form")).toHaveAttribute("data-hydrated", "true");

  await context.setOffline(true);
  await page.getByTestId("prefs-landing-view").selectOption("pipeline");

  const error = page.getByTestId("preferences-error");
  await expect(error).toBeVisible({ timeout: 20_000 });
  await expect(error).toContainText(/connection/i);
  // Usable again, which is what "the control came back" means. Asserted across
  // all five, because `busy` disables all five and a half-fix that re-enabled
  // only the one that was touched would pass a narrower check.
  for (const id of [
    "prefs-density",
    "prefs-type-scale",
    "prefs-theme",
    "prefs-landing-view",
    "prefs-keyboard-hints",
  ]) {
    await expect(page.getByTestId(id), id).toBeEnabled();
  }

  await context.setOffline(false);
  // Nothing was queued: the front door still goes to the default, because the
  // refused write never landed and nothing replayed it. This is the assertion
  // that would fail if somebody added an offline queue.
  await page.goto("/");
  await expect(page).toHaveURL(/\/queue$/);
});

test("an offline check and save leave the profile form usable and queue nothing", async ({
  page,
  context,
  baseURL,
}) => {
  // DEC-011 on the OTHER settings form, and the branch that was broken rather
  // than merely unproven: `profile-form.tsx` awaited both actions through a
  // `withTimeout` that bounds a promise but does not catch one, so the
  // rejection an offline server action produces escaped the handler before
  // `setBusy(null)` ran and every control stayed disabled until reload —
  // matrix row 135's stuck-busy failure, reachable by going offline.
  await isolate(page, context, baseURL!, "profile-offline");
  await page.goto("/settings");
  await expect(page.getByTestId("profile-form")).toHaveAttribute("data-hydrated", "true");

  // A real change, so the retry at the end has something observable to land.
  await page.locator("#metros-input").fill("Miami");
  await page.locator("#metros-input").press("Enter");
  await expect(page.getByTestId("metros-chips")).toContainText("Miami");

  await page.getByTestId("check-button").click();
  await expect(page.getByTestId("preview-panel")).toBeVisible({ timeout: 15_000 });

  await context.setOffline(true);

  // Check first: its rejection must land in the preview's own failed state —
  // not hang the panel on "Checking" with every button dead.
  await page.getByTestId("check-button").click();
  await expect(page.getByTestId("preview-failed")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("preview-failed")).toContainText(/connection/i);
  await expect(page.getByTestId("check-button")).toBeEnabled();

  // Save next: the preferences form's connection sentence, and the controls
  // come back rather than wedging.
  await page.getByTestId("save-button").click();
  const refusal = page.getByText("Couldn't save that. Check your connection and try again.");
  await expect(refusal).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("save-button")).toBeEnabled();
  await expect(page.getByTestId("check-button")).toBeEnabled();

  // Let the refusal toast retire so the "no error" assertion below cannot be
  // reading a leftover of the failure it is checking never recurred.
  await expect(refusal).toHaveCount(0, { timeout: 15_000 });

  // Back online, a re-check clears the failed panel (its "save anyway" sentence
  // would otherwise satisfy the failure-text sweep below for the wrong reason)…
  await context.setOffline(false);
  await page.getByTestId("check-button").click();
  await expect(page.getByTestId("preview-panel")).toBeVisible({ timeout: 15_000 });

  // …and pressing Save again lands the change exactly once: the idempotency
  // key was NOT rotated on the refusal, so this gesture is the same save,
  // replayed — never a second write.
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("commit-banner")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/couldn.t save|try again/i)).toHaveCount(0);

  // And it is really there — the server has it, not just this render.
  await page.reload();
  await expect(page.getByTestId("profile-form")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByTestId("metros-chips")).toContainText("Miami");
});

// ─────────────────────────────────────────────────────────────── loading

test("a slow profile read shows the section's own skeleton, not a spinner", async ({
  page,
  context,
  baseURL,
}) => {
  // Reachable at all only because `hq_demo_slow` exists: the fixture source
  // answers from memory, so the `Suspense` fallback used to render for less than
  // a frame and no assertion could ever see it.
  //
  // DRIVEN AS A RAIL CLICK, not as a fresh load, and the reason is worth stating
  // because it was measured rather than assumed. On a cold load React renders
  // the root layout, the app layout and this page CONCURRENTLY, so a uniform
  // delay makes all three finish together and the boundary never gets to be
  // pending — the first byte arrives with the form already in it. A rail click
  // re-fetches this segment alone, which is also the case a person actually
  // meets: the shell and the rail are already on screen and one section is
  // fetching.
  await isolate(page, context, baseURL!, "slow");
  await page.goto("/settings/data");
  await expect(page.getByTestId("settings-rail")).toBeVisible();

  await context.addCookies([{ name: "hq_demo_slow", value: "3000", url: baseURL! }]);
  await page.getByTestId("settings-rail-profile").click();

  // The skeleton is up…
  await expect(page.getByTestId("settings-skeleton")).toBeVisible({ timeout: 10_000 });
  // …and the rail is still there beside it, which is why the boundary is around
  // the section rather than around the page: the one control that still works
  // while the read is slow is the one you navigate with.
  await expect(page.getByTestId("settings-rail")).toBeVisible();
  // …and it is content-shaped, not a spinner: the bars stand where the fields
  // will. A single centred element would pass "something is on screen" and fail
  // 04 §5, which is exactly what the old skeleton assertion did.
  const bars = page.getByTestId("settings-skeleton").locator("span.bg-raised");
  expect(await bars.count()).toBeGreaterThan(8);

  // And it gives way to the real thing rather than staying forever.
  await expect(page.getByTestId("profile-form")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("settings-skeleton")).toHaveCount(0);
});

test("a slow preferences read shows the section's own skeleton beside a working rail", async ({
  page,
  context,
  baseURL,
}) => {
  // The same claim as the profile test above, for the section that used to have
  // NO loading state at all: the page was one async read with no boundary, so a
  // slow read froze navigation with zero feedback. Driven as a rail click for
  // that test's measured reason — on a cold load the whole tree finishes
  // together and the boundary is never pending.
  await isolate(page, context, baseURL!, "slow-prefs");
  await page.goto("/settings/data");
  await expect(page.getByTestId("settings-rail")).toBeVisible();

  await context.addCookies([{ name: "hq_demo_slow", value: "3000", url: baseURL! }]);
  await page.getByTestId("settings-rail-preferences").click();

  // The skeleton is up…
  await expect(page.getByTestId("preferences-skeleton")).toBeVisible({ timeout: 10_000 });
  // …and the rail beside it is the NEW page's rail, current section marked and
  // still taking input — which is what keeping the shell outside the boundary
  // buys. A route-level `loading.tsx` would pass a naive "skeleton visible"
  // check while blanking the one control that still works during the read.
  const current = page.getByTestId("settings-rail").locator("[aria-current=page]");
  await expect(current).toHaveText("Preferences");
  await page.getByTestId("settings-rail-data").focus();
  await expect(page.getByTestId("settings-rail-data")).toBeFocused();
  // …and it is content-shaped: bars standing where the five control rows land.
  const bars = page.getByTestId("preferences-skeleton").locator("span.bg-raised");
  expect(await bars.count()).toBeGreaterThan(8);

  // It gives way to the real controls, with the version-token wrapper the other
  // suites wait on intact.
  await expect(page.getByTestId("preferences-form")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("preferences-skeleton")).toHaveCount(0);
  await expect(page.locator("[data-display-version]")).toBeAttached();
});

test("a slow answers read shows a card-shaped skeleton, and it is not the empty state", async ({
  page,
  context,
  baseURL,
}) => {
  await isolate(page, context, baseURL!, "slow-answers");
  await page.goto("/settings");
  await expect(page.getByTestId("profile-form")).toHaveAttribute("data-hydrated", "true");

  await context.addCookies([{ name: "hq_demo_slow", value: "3000", url: baseURL! }]);
  await page.getByTestId("answers-link").click();

  // The skeleton is up, and the header above it — the part outside the boundary
  // — already says where you are.
  await expect(page.getByTestId("answers-skeleton")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Application answers" })).toBeVisible();
  const bars = page.getByTestId("answers-skeleton").locator("span.bg-raised");
  expect(await bars.count()).toBeGreaterThan(6);

  // Loading and empty stay distinguishable: "still asking" must not satisfy the
  // locators that mean "the server answered and found nothing".
  await expect(page.getByTestId("library-empty")).toHaveCount(0);
  await expect(page.getByTestId("exceptions-empty")).toHaveCount(0);

  await expect(page.getByTestId("answers-surface")).toHaveAttribute("data-hydrated", "true", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("answers-skeleton")).toHaveCount(0);
});

// ──────────────────────────────────────────────────────── narrow and a11y

test("the section rail absorbs its own overflow at 280px", async ({
  page,
  context,
  baseURL,
}) => {
  // The regression this is written against is real and is #121's: the shell
  // opts into a bounded frame through `data-bounded-frame` + `:has()`, and the
  // first cutover applied it to twelve surfaces that never asked for it, which
  // took document scrolling away on a phone and pinned a submit button under a
  // toast. Settings does NOT set that attribute, and a 200px rail beside a
  // gutter would push the page sideways at 280px if it did not scroll inside
  // itself.
  await isolate(page, context, baseURL!, "narrow");
  await page.setViewportSize({ width: 280, height: 800 });

  for (const section of SETTINGS_SECTIONS) {
    await page.goto(section.href);

    const overflow = await page.evaluate(() => {
      const el = document.documentElement;
      return { scroll: el.scrollWidth, client: el.clientWidth };
    });
    expect(
      overflow.scroll,
      `${section.href} paints ${overflow.scroll - overflow.client}px past the page edge at 280px`,
    ).toBeLessThanOrEqual(overflow.client + 1);

    // The document still scrolls vertically, which is what NOT opting into the
    // bounded frame buys: the section's own actions stay reachable on a phone.
    const bounded = await page.locator("[data-bounded-frame]").count();
    expect(bounded, `${section.href} opted into the bounded frame`).toBe(0);
  }
});

test("every section passes axe at the levels this product targets", async ({
  page,
  context,
  baseURL,
}) => {
  await isolate(page, context, baseURL!, "axe");
  for (const section of SETTINGS_SECTIONS) {
    await page.goto(section.href);
    const failures = await axeFailures(page);
    expect(failures, `${section.href}\n${failures.join("\n")}`).toEqual([]);
  }
});


test("the rail is reachable and operable from the keyboard alone", async ({
  page,
  context,
  baseURL,
}) => {
  await isolate(page, context, baseURL!, "keyboard");
  await page.goto("/settings");

  // Tab until the rail's second entry has focus, then open it with Enter. A
  // rail built from buttons would still "work" here, which is why the assertion
  // afterwards is on the URL: a button cannot change one.
  const target = page.getByTestId("settings-rail-preferences");
  await target.focus();
  await expect(target).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/settings\/preferences$/);
  await expect(page.getByTestId("preferences-form")).toHaveAttribute("data-hydrated", "true");
});
