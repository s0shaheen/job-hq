import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * The read-error state — the last §5 state with no way in.
 *
 * `app/error.tsx` has existed since the shell landed, and until the
 * `hq_demo_fail_read` seam nothing could make a server read fail: the fixture
 * source answers from memory, so the boundary had never rendered in any test on
 * any surface and "This page didn't load" appeared in zero specs. A component
 * cited as its own enforcement is the exact ticked-row failure `loading.spec.ts`
 * opens with, one state over.
 *
 * Driven from `/queue` and looped over the other shell surfaces, because the
 * boundary is app-level: one spec proving it once is cheaper than four issues
 * proving it four times, and the per-surface issues cite this file rather than
 * re-proving it.
 *
 * WHAT THE SEAM DOES NOT LET THROUGH. The cookie is read inside `isDemoMode()`
 * only and thrown AFTER the entitlement gate — both pinned by
 * `tests/unit/get-source-seam.test.ts`, because neither is provable from a
 * browser: a refused account is redirected by the middleware before
 * `getDataSource()` ever runs for it. The pending-session test here proves the
 * JOURNEY stays refused with the seam armed; the unit test proves the layer.
 */

const FIXTURE_NOW = new Date("2026-07-21T15:00:00.000Z");

/**
 * The other shell surfaces the app-level boundary must cover. `/queue` is the
 * driving surface above; these are the loop, because the boundary is one
 * component at the app root and each of these pages reads through the same
 * `getDataSource()` the seam fails.
 */
const OTHER_SURFACES = ["/jobs", "/pipeline", "/companies"];

const HEADING = "This page didn't load";

/**
 * A browser with its own demo store and the read seam armed. Per test AND per
 * project, the `empty.spec.ts` isolation rule: desktop and mobile run this file
 * against one server, and a shared store makes them each other's flake.
 */
async function armed(
  context: BrowserContext,
  baseURL: string,
  extra: { name: string; value: string }[] = [],
) {
  const id = `err-${test.info().project.name}-${Math.random().toString(36).slice(2)}`;
  await context.addCookies([
    { name: "hq_demo_id", value: id, url: baseURL },
    { name: "hq_demo_fail_read", value: "1", url: baseURL },
    ...extra.map((c) => ({ ...c, url: baseURL })),
  ]);
}

function boundaryHeading(page: Page) {
  return page.getByRole("heading", { name: HEADING });
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXTURE_NOW);
});

test("an armed read failure renders the boundary, not a blank page or a stuck skeleton", async ({
  page,
  context,
  baseURL,
}) => {
  await armed(context, baseURL!);
  await page.goto("/queue");

  await expect(boundaryHeading(page)).toBeVisible();
  // The two actions that ever help, both really there.
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Go to Today" })).toBeVisible();

  // Not the empty state, not the skeleton, not fixture rows wearing an error:
  // while the boundary shows, the states it replaced are gone. The skeleton
  // check runs twice with a beat between, because the failure mode worth
  // catching is the skeleton strobing back in BEHIND the boundary when a
  // suspended segment resolves late.
  await expect(page.getByTestId("empty-state")).toHaveCount(0);
  await expect(page.getByTestId("decision-row")).toHaveCount(0);
  await expect(page.getByTestId("queue-skeleton")).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(page.getByTestId("queue-skeleton")).toHaveCount(0);
  await expect(boundaryHeading(page)).toBeVisible();
});

test("Try again recovers through the boundary once the failure clears", async ({
  page,
  context,
  baseURL,
}) => {
  await armed(context, baseURL!);
  await page.goto("/queue");
  await expect(boundaryHeading(page)).toBeVisible();

  // The failure clears on the server side of the seam; the RECOVERY has to
  // come through the boundary's own control. A `page.reload()` here would
  // prove the server works and nothing about the button the user actually has.
  await context.clearCookies({ name: "hq_demo_fail_read" });
  await page.getByRole("button", { name: "Try again" }).click();

  await expect(page.locator('[data-testid="triage"][data-ready="true"]')).toBeAttached();
  await expect(page.getByTestId("decision-row").first()).toBeVisible();
  await expect(boundaryHeading(page)).toHaveCount(0);
});

test("a pending session with the seam armed is still refused, and never sees the boundary", async ({
  page,
  context,
  baseURL,
}) => {
  // The seam must not jump the auth ordering: refusal wins. The middleware
  // answers this journey; the same ordering inside `getDataSource()` itself is
  // pinned by tests/unit/get-source-seam.test.ts, where a browser cannot reach.
  await armed(context, baseURL!, [{ name: "hq_demo_entitlement", value: "pending" }]);
  await page.goto("/queue");

  await expect(page).toHaveURL(/\/pending$/);
  await expect(boundaryHeading(page)).toHaveCount(0);
});

test("the boundary is app-level: jobs, pipeline and companies render it too", async ({
  page,
  context,
  baseURL,
}) => {
  await armed(context, baseURL!);
  for (const path of OTHER_SURFACES) {
    await page.goto(path);
    await expect(boundaryHeading(page), `${path} did not render the boundary`).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Try again" }),
      `${path} renders the boundary without its retry`,
    ).toBeVisible();
  }
});

test("Try again and Go to Today are reachable and operable by keyboard alone", async ({
  page,
  context,
  baseURL,
}) => {
  await armed(context, baseURL!);
  await page.goto("/queue");
  await expect(boundaryHeading(page)).toBeVisible();

  // Walk the tab order and collect the boundary's controls as focus lands on
  // them. Bounded, because "press Tab forever" is a hang wearing a loop.
  const found: string[] = [];
  for (let i = 0; i < 15 && found.length < 2; i++) {
    await page.keyboard.press("Tab");
    const name = await page.evaluate(
      () => document.activeElement?.textContent?.trim() ?? "",
    );
    if ((name === "Try again" || name === "Go to Today") && !found.includes(name)) {
      found.push(name);
    }
  }
  expect(found, "not every boundary control is reachable by keyboard").toEqual([
    "Try again",
    "Go to Today",
  ]);

  // And operable: recover through the keyboard, not a click. Focus ended on
  // Go to Today, so one Shift+Tab is Try again — asserted, not assumed.
  await context.clearCookies({ name: "hq_demo_fail_read" });
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Try again" })).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page.locator('[data-testid="triage"][data-ready="true"]')).toBeAttached();
  await expect(boundaryHeading(page)).toHaveCount(0);
});
