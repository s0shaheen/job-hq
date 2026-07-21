import { expect, test, type Page } from "@playwright/test";

/**
 * Undo pressed after the background flush already delivered the gesture.
 *
 * (Needs a row in the failure-mode matrix in docs/WEBAPP-BUILD.md — added here
 * with the test first, per the rule that a found bug becomes a row, not a fix.)
 *
 * The 8s hold in PendingWork keeps a freshly queued decision local for as long
 * as the Undo toast is live, which narrows this window — it does not close it.
 * The toast's dismiss timer pauses while the pointer is on it (sonner does this
 * so a toast cannot vanish from under a cursor reaching for its action), so the
 * hold expires, the network is back, the flush delivers the decision, and the
 * Undo button is still on screen. That is not a contrived state: hovering the
 * button is what someone about to click it does.
 *
 * The assertion that matters is the one after the reload. Restoring the card on
 * screen is easy and proves nothing — the old code did exactly that while the
 * server kept the decision. Only a reload can tell whether Undo was real.
 */

const FIXTURE_NOW = new Date("2026-07-21T15:00:00.000Z");

async function setup(page: Page, context: import("@playwright/test").BrowserContext) {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await context.addCookies([
    {
      name: "hq_demo_id",
      value: `undo-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      url: "http://127.0.0.1:3210",
    },
  ]);
}

async function gotoQueue(page: Page) {
  await page.goto("/queue");
  await expect(page.locator('[data-testid="triage"][data-ready="true"]')).toBeAttached();
}

test("undo after the flush delivered the decision really undoes it", async ({ page, context }) => {
  test.slow(); // the undo hold is 8s of wall clock, on purpose

  await setup(page, context);
  await gotoQueue(page);
  const first = await page.locator("article h3").first().innerText();

  await context.setOffline(true);
  await page.getByTestId("pass").click();
  await expect(page.getByTestId("pending-work")).toBeVisible();

  // Keep the toast alive across the hold. Focus and hover both pause sonner's
  // dismiss timer; using both keeps this working on the touch-emulating mobile
  // project, where a hover is not the gesture a real user would make.
  const undo = page.getByRole("button", { name: "Undo" });
  await undo.focus();
  await undo.hover();

  await context.setOffline(false);
  // The banner clearing is the app's own statement that the gesture left the
  // outbox and the server has it. Undo is now a compensating write or a lie.
  await expect(page.getByTestId("pending-work")).toHaveCount(0, { timeout: 20_000 });

  // If sonner ever stops pausing on hover this fails here rather than passing
  // for the wrong reason — the window under test would no longer be reachable.
  await expect(undo).toBeVisible();
  await undo.click();

  // On screen it comes back either way; this only rules out the card being lost.
  await expect(page.locator("article h3").first()).toHaveText(first);

  // The real check. Before the compensating write existed, the server still
  // held the pass and this card did not come back.
  await page.reload();
  await expect(page.locator('[data-testid="triage"][data-ready="true"]')).toBeAttached();
  await expect(page.locator("article h3").first()).toHaveText(first);
});
