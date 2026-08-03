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
 *
 * The second half of that invariant: no decision leaves the outbox in silence.
 * A rejected or conflicted replay must become a visible notice, a malformed
 * entry must not starve the valid ones behind it, a full localStorage must not
 * turn "saved on this device" into a lie, and Undo must stay a genuine undo
 * even when the network returns while the toast is still up.
 */

const FIXTURE_NOW = new Date("2026-07-21T15:00:00.000Z");

const OUTBOX_KEY = "hq.outbox.v1";

/** Inject queued gestures as a previous session would have left them. */
async function seedOutbox(page: Page, entries: Record<string, unknown>[]) {
  await page.evaluate(
    ([key, json]) => window.localStorage.setItem(key as string, json as string),
    [OUTBOX_KEY, JSON.stringify(entries)] as const,
  );
}

function pendingEntry(id: string, input: Record<string, unknown>, label: string) {
  return { id, input, label, queuedAt: 1, reason: "offline" };
}

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
    const first = await page.getByTestId("row-title").first().innerText();

    await context.setOffline(true);
    await page.getByTestId("interested").click();

    // The card is gone (the decision stands) and the app says where it went.
    await expect(page.getByTestId("row-title").first()).not.toHaveText(first);
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

    // The document has to load for there to be a page to assert about, but the
    // SERVER ACTION must stay unreachable — otherwise this test contradicts its
    // own name. It used to go fully online before reloading, so PendingWork's
    // mount flush delivered the gesture and cleared the banner; the assertion
    // then raced that delivery and failed roughly one CI run in two. The flake
    // was the test disagreeing with itself, not the app misbehaving.
    await page.route("**/queue", (route) =>
      route.request().method() === "POST" ? route.abort("failed") : route.continue(),
    );
    await context.setOffline(false);
    await page.reload();

    // Still pending after a reload — it lives in localStorage, not in memory.
    await expect(page.getByTestId("pending-work")).toBeVisible();
    await expect(page.getByTestId("pending-work")).toHaveAttribute("data-reason", "offline");
  });

  test("reconnecting delivers the queued decision on its own", async ({ page, context }) => {
    await setup(page, context);
    await gotoQueue(page);
    await context.setOffline(true);
    await page.getByTestId("interested").click();
    await expect(page.getByTestId("pending-work")).toBeVisible();

    await context.setOffline(false);
    // No click: coming back online is the trigger. Delivery waits out the 8s
    // undo hold first — while the Undo toast is live the decision stays local
    // — which is why the timeout is generous. The banner clearing is the
    // app's own statement that the work was delivered.
    await expect(page.getByTestId("pending-work")).toHaveCount(0, { timeout: 20_000 });

    // And it really landed: an interested decision creates a pipeline row.
    await page.goto("/pipeline");
    await expect(page.getByTestId("pipeline")).toBeVisible();
  });

  test("undo works offline, because nothing was ever sent", async ({ page, context }) => {
    await setup(page, context);
    await gotoQueue(page);
    const first = await page.getByTestId("row-title").first().innerText();

    await context.setOffline(true);
    await page.getByTestId("pass").click();
    await expect(page.getByTestId("pending-work")).toBeVisible();

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByTestId("row-title").first()).toHaveText(first);
    // Undone before delivery means there is nothing left to deliver.
    await expect(page.getByTestId("pending-work")).toHaveCount(0);
  });
});

test.describe("expired session", () => {
  test("the decision is held and the banner offers a way back in", async ({ page, context }) => {
    await setup(page, context, [{ name: "hq_demo_session", value: "expired" }]);
    await gotoQueue(page);
    const first = await page.getByTestId("row-title").first().innerText();

    await page.getByTestId("interested").click();

    await expect(page.getByTestId("row-title").first()).not.toHaveText(first);
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

test.describe("failed deliveries are never silent", () => {
  test("a rejected replay leaves a visible notice, not a vanished banner", async ({ page, context }) => {
    await setup(page, context);
    await gotoQueue(page);
    // A queued decision whose posting the server does not know: the replay is
    // genuinely rejected. The old code dequeued it and moved on — the banner
    // disappeared, which reads as "delivered", and the decision was gone.
    await seedOutbox(page, [
      pendingEntry(
        "e2e-rejected",
        {
          postingKey: "greenhouse-0000000",
          triage: "dismissed",
          snoozeUntil: null,
          idempotencyKey: "e2e-rejected",
          expectedUpdatedAt: null,
        },
        "Passed on Nowhere — Product Manager",
      ),
    ]);
    await page.reload();

    const notice = page.getByTestId("failed-work");
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toContainText("Passed on Nowhere — Product Manager");
    await expect(page.getByTestId("pending-work")).toHaveCount(0);
    // The notice is dismissible — actionable, not a permanent scar.
    await notice.getByRole("button", { name: "Dismiss" }).click();
    await expect(notice).toHaveCount(0);
  });

  test("a conflict on replay says the decision lost, instead of pretending it landed", async ({ page, context }) => {
    await setup(page, context);
    await gotoQueue(page);
    // A stale expectedUpdatedAt: someone decided on another device after this
    // gesture was queued. The server keeps the newer decision — sometimes the
    // right outcome, but the user must hear that theirs lost.
    await seedOutbox(page, [
      pendingEntry(
        "e2e-conflict",
        {
          postingKey: "greenhouse-1120044",
          triage: "dismissed",
          snoozeUntil: null,
          idempotencyKey: "e2e-conflict",
          expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
        },
        "Passed on Modern Treasury — Product Manager, Ledgers",
      ),
    ]);
    await page.reload();

    const notice = page.getByTestId("failed-work");
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toContainText("Passed on Modern Treasury — Product Manager, Ledgers");
    await expect(notice).toContainText(/another device/i);
    await expect(page.getByTestId("pending-work")).toHaveCount(0);
  });

  test("a malformed entry is quarantined and the valid decision behind it still delivers", async ({ page, context }) => {
    await setup(page, context);
    await gotoQueue(page);
    // The poison entry has no `input`. It used to throw inside the replay loop
    // on every pass, so the valid decision behind it was never delivered and
    // the "will sync automatically" banner could never be satisfied.
    await seedOutbox(page, [
      { id: "e2e-poison", label: "A poisoned entry", queuedAt: 1, reason: "offline" },
      pendingEntry(
        "e2e-valid",
        {
          postingKey: "ashby-c7d9e001",
          triage: "dismissed",
          snoozeUntil: null,
          idempotencyKey: "e2e-valid",
          expectedUpdatedAt: null,
        },
        "Passed on Brex — Product Manager, Spend",
      ),
    ]);
    await page.reload();

    // The valid decision made it out: the pending banner clears.
    await expect(page.getByTestId("pending-work")).toHaveCount(0, { timeout: 15_000 });
    // And the poison one did not vanish in silence.
    const notice = page.getByTestId("failed-work");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("A poisoned entry");
  });
});

test("a full localStorage still holds the decision for this tab, and says so", async ({ page, context }) => {
  // Quota exhaustion, scoped to the outbox keys so the rest of the app is
  // undisturbed. The old code swallowed the throw: the toast said "Saved on
  // this device", read() re-read localStorage, and the decision existed
  // nowhere at all.
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (String(key).startsWith("hq.outbox")) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  });
  await setup(page, context);
  await gotoQueue(page);
  const first = await page.getByTestId("row-title").first().innerText();

  await context.setOffline(true);
  await page.getByTestId("pass").click();

  const banner = page.getByTestId("pending-work");
  await expect(banner).toBeVisible();
  // Honest about the degraded durability: held in this tab, not "saved".
  await expect(banner).toHaveAttribute("data-durable", "false");
  await expect(banner).toContainText(/held in this tab/i);

  // Reconnecting delivers it from memory (after the undo hold passes).
  await context.setOffline(false);
  await expect(banner).toHaveCount(0, { timeout: 20_000 });

  // And it truly reached the server: the passed card is gone after a reload.
  await page.reload();
  await expect(page.getByTestId("row-title").first()).not.toHaveText(first);
});

test("undo still works when the network returns inside the undo window", async ({ page, context }) => {
  await setup(page, context);
  await gotoQueue(page);
  const first = await page.getByTestId("row-title").first().innerText();

  await context.setOffline(true);
  await page.getByTestId("pass").click();
  await expect(page.getByTestId("pending-work")).toBeVisible();

  await context.setOffline(false);
  // Give the reconnect flush the window in which it used to deliver the
  // decision out from under the live Undo toast. The hold must keep the
  // gesture local for the length of the Undo window instead.
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("pending-work")).toBeVisible();

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("row-title").first()).toHaveText(first);
  await expect(page.getByTestId("pending-work")).toHaveCount(0);

  // The server never saw the pass: after a reload the card is still first.
  await page.reload();
  await expect(page.getByTestId("row-title").first()).toHaveText(first);
});
