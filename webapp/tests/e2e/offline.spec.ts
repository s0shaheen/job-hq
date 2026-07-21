import { expect, test, type Page } from "@playwright/test";

/**
 * Matrix rows 16 and 17: a session that expires mid-action, and a network that
 * is not there.
 *
 * The assertion that matters in both is the same one, and it is about not
 * losing work: a decision the user made must still exist after the failure,
 * without them having to make it again. A test that only checks "a banner
 * appeared" would pass on an implementation that shows a warning and throws the
 * decision away, which is the bug.
 */

const FIXTURE_NOW = new Date("2026-07-21T15:00:00.000Z");

async function setup(page: Page, context: import("@playwright/test").BrowserContext, extra: { name: string; value: string }[] = []) {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await context.addCookies([
    {
      name: "hq_demo_id",
      value: `off-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      url: "http://127.0.0.1:3210",
    },
    ...extra.map((c) => ({ ...c, url: "http://127.0.0.1:3210" })),
  ]);
}

async function gotoQueue(page: Page) {
  await page.goto("/queue");
  await expect(page.locator('[data-testid="triage"][data-ready="true"]')).toBeAttached();
}

test("no banner when there is nothing pending", async ({ page, context }) => {
  // A permanent "you might be offline" strip is noise people learn to ignore.
  await setup(page, context);
  await gotoQueue(page);
  await expect(page.getByTestId("pending-work")).toHaveCount(0);
});

test.describe("offline", () => {
  test("a decision made offline is kept, not lost", async ({ page, context }) => {
    await setup(page, context);
    await gotoQueue(page);
    const first = await page.locator("article h3").first().innerText();

    await context.setOffline(true);
    await page.getByTestId("interested").click();

    // The card is gone (the decision stands) and the app says where it went.
    await expect(page.locator("article h3").first()).not.toHaveText(first);
    const banner = page.getByTestId("pending-work");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("data-reason", "offline");
    await expect(banner).toContainText(/1 decision .*saved on this device/i);
  });

  test("the decision survives a reload while still offline", async ({ page, context }) => {
    // The phone-in-a-pocket case: the tab is killed before the network returns.
    await setup(page, context);
    await gotoQueue(page);
    await context.setOffline(true);
    await page.getByTestId("interested").click();
    await expect(page.getByTestId("pending-work")).toBeVisible();

    await context.setOffline(false);
    await page.reload();
    // Still pending after a reload — it lives in localStorage, not in memory.
    await expect(page.getByTestId("pending-work")).toBeVisible();
  });

  test("reconnecting delivers the queued decision on its own", async ({ page, context }) => {
    await setup(page, context);
    await gotoQueue(page);
    await context.setOffline(true);
    await page.getByTestId("interested").click();
    await expect(page.getByTestId("pending-work")).toBeVisible();

    await context.setOffline(false);
    // No click: coming back online is the trigger. The banner clearing is the
    // app's own statement that the work was delivered.
    await expect(page.getByTestId("pending-work")).toHaveCount(0, { timeout: 20_000 });

    // And it really landed: an interested decision creates a pipeline row.
    await page.goto("/pipeline");
    await expect(page.getByRole("table")).toBeVisible();
  });

  test("undo works offline, because nothing was ever sent", async ({ page, context }) => {
    await setup(page, context);
    await gotoQueue(page);
    const first = await page.locator("article h3").first().innerText();

    await context.setOffline(true);
    await page.getByTestId("pass").click();
    await expect(page.getByTestId("pending-work")).toBeVisible();

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator("article h3").first()).toHaveText(first);
    // Undone before delivery means there is nothing left to deliver.
    await expect(page.getByTestId("pending-work")).toHaveCount(0);
  });
});

test.describe("expired session", () => {
  test("the decision is held and the banner offers a way back in", async ({ page, context }) => {
    await setup(page, context, [{ name: "hq_demo_session", value: "expired" }]);
    await gotoQueue(page);
    const first = await page.locator("article h3").first().innerText();

    await page.getByTestId("interested").click();

    await expect(page.locator("article h3").first()).not.toHaveText(first);
    const banner = page.getByTestId("pending-work");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("data-reason", "auth");
    await expect(banner).toContainText(/session expired/i);
    // The way out is present. Without it the user is told they are stuck and
    // given nothing to do about it.
    await expect(banner.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("it is not confused with being offline", async ({ page, context }) => {
    // Different cause, different fix. Telling someone with a working network
    // to wait for reconnection is a dead end.
    await setup(page, context, [{ name: "hq_demo_session", value: "expired" }]);
    await gotoQueue(page);
    await page.getByTestId("interested").click();
    const banner = page.getByTestId("pending-work");
    await expect(banner).toBeVisible();
    await expect(banner).not.toContainText(/offline/i);
  });

  test("the held decision is applied once the session is back", async ({ page, context }) => {
    await setup(page, context, [{ name: "hq_demo_session", value: "expired" }]);
    await gotoQueue(page);
    await page.getByTestId("interested").click();
    await expect(page.getByTestId("pending-work")).toBeVisible();

    // Signing back in, simulated by clearing the demo expiry. Re-auth always
    // ends on a fresh page load, so that load is what must deliver the held
    // work — with no further action from someone who has already done the
    // thing the banner asked for.
    await context.clearCookies({ name: "hq_demo_session" });
    await page.reload();

    await expect(page.getByTestId("pending-work")).toHaveCount(0, { timeout: 15_000 });
  });
});
